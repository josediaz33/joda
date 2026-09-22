import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@joda/db";
import type { Clock } from "@joda/domain";
import { MEDIA_MAX_DIMENSION_PX, MEDIA_MAX_UPLOAD_BYTES } from "@joda/domain";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeStaffAuthProvider } from "../../adapters/staffAuth/fakeStaffAuthProvider.js";
import { createLocalDiskStorage } from "../../adapters/storage/localDiskStorage.js";
import { jodaApiConnectionUrl, startTestDb, type TestDb } from "../../db/testDb.js";
import { buildServer } from "../../index.js";
import type { AuthServiceDeps } from "../auth/service.js";

// Integración real contra Postgres (.claude/rules/testing.md: "nunca
// simulacros de Prisma"), mismo arnés que catalog.integration.test.ts
// (WP-C08). Cubre RF-CAT-08: bytes mágicos (no Content-Type ni extensión),
// límites de tamaño/dimensión ANTES de procesar, derivados AVIF/WebP,
// dedup por sha256, e idempotencia — las trampas explícitas de la Sesión 29
// del playbook (docs/runbooks/prompts-playbook.md).
const TENANT_ID = "77777777-7777-4777-a777-777777777777";
const STAFF_OWNER_ID = "99999999-9999-4999-a999-999999999992";
const STAFF_OWNER_EMAIL = "owner-media@jodaparfums.com";
const STAFF_PASSWORD = "correcta";
const MFA_ENCRYPTION_KEY = Buffer.from("2".repeat(64), "hex");
const PLACEHOLDER_MFA_SECRET = "placeholder-nunca-se-descifra-en-este-test";
const MEDIA_PUBLIC_BASE_URL = "http://media.localhost:9999";

function createManualClock(initial: Date): Clock {
  return { now: () => initial };
}

function toRequestCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("se esperaba un header Set-Cookie en la respuesta");
  const separator = raw.indexOf(";");
  return separator === -1 ? raw : raw.slice(0, separator);
}

/** Busboy necesita los campos ANTES del archivo para que `data.fields` los tenga listos al leer (@fastify/multipart, README "order matters"). */
function buildMultipartBody(
  boundary: string,
  fields: Record<string, string>,
  file: { fieldName: string; filename: string; contentType: string; content: Buffer },
): Buffer {
  const chunks: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
        "utf8",
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; ` +
        `filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      "utf8",
    ),
  );
  chunks.push(file.content);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  return Buffer.concat(chunks);
}

describe("WP-C09 · módulo medios (RF-CAT-08)", () => {
  let testDb: TestDb;
  let redisContainer: StartedRedisContainer;
  let db: PrismaClient;
  let redis: Redis;
  let app: FastifyInstance;
  let cookie: string;
  let mediaStorageDir: string;
  let productId: string;
  let validJpeg: Buffer;

  async function mutateOk<T>(procedure: string, payload: Record<string, unknown>): Promise<T> {
    const response = await app.inject({
      method: "POST",
      url: `/trpc/${procedure}`,
      headers: { cookie },
      payload,
    });
    if (response.statusCode >= 400) {
      throw new Error(`${procedure} mutation → ${response.statusCode}: ${response.body}`);
    }
    return response.json().result.data as T;
  }

  async function uploadMedia(
    fields: Record<string, string>,
    file: { filename: string; contentType: string; content: Buffer },
    headers: Record<string, string> = {},
  ) {
    const boundary = "----jodaTestBoundary";
    const payload = buildMultipartBody(boundary, fields, { fieldName: "file", ...file });
    return app.inject({
      method: "POST",
      url: "/media/products",
      headers: {
        cookie,
        "content-type": `multipart/form-data; boundary=${boundary}`,
        ...headers,
      },
      payload,
    });
  }

  beforeAll(async () => {
    testDb = await startTestDb();

    await testDb.superuserClient.query(
      `INSERT INTO app.tenants (id, slug, legal_name, trade_name)
       VALUES ($1, 'joda-c09', 'JODA Parfums SRL', 'JODA Parfums')`,
      [TENANT_ID],
    );
    await testDb.superuserClient.query(`SELECT app.seed_roles($1)`, [TENANT_ID]);
    await testDb.superuserClient.query(
      `INSERT INTO app.staff_users
         (id, tenant_id, auth_subject, email, full_name, is_active, mfa_enrolled, mfa_secret_encrypted)
       VALUES ($1, $2, 'auth|owner-c09', $3, 'Test Owner', true, true, $4)`,
      [STAFF_OWNER_ID, TENANT_ID, STAFF_OWNER_EMAIL, PLACEHOLDER_MFA_SECRET],
    );
    const ownerRole = await testDb.superuserClient.query(
      `SELECT id FROM app.roles WHERE tenant_id = $1 AND code = 'owner'`,
      [TENANT_ID],
    );
    await testDb.superuserClient.query(
      `INSERT INTO app.staff_user_roles (staff_user_id, role_id) VALUES ($1, $2)`,
      [STAFF_OWNER_ID, ownerRole.rows[0].id],
    );

    db = new PrismaClient({ datasourceUrl: jodaApiConnectionUrl(testDb.container) });
    redisContainer = await new RedisContainer("redis:7").start();

    validJpeg = await sharp({
      create: { width: 100, height: 80, channels: 3, background: "red" },
    })
      .jpeg()
      .toBuffer();
  }, 120_000);

  afterAll(async () => {
    await db.$disconnect();
    await testDb.stop();
    await redisContainer.stop();
  });

  beforeEach(async () => {
    redis = new Redis(redisContainer.getConnectionUrl());
    const authDeps: AuthServiceDeps = {
      db,
      redis,
      authProvider: createFakeStaffAuthProvider(
        new Map([[STAFF_OWNER_EMAIL, { password: STAFF_PASSWORD, authSubject: "auth|owner-c09" }]]),
      ),
      clock: createManualClock(new Date("2026-01-01T12:00:00.000Z")),
      mfaEncryptionKey: MFA_ENCRYPTION_KEY,
    };

    mediaStorageDir = await mkdtemp(join(tmpdir(), "joda-media-integration-"));
    const storage = createLocalDiskStorage({
      rootDir: mediaStorageDir,
      publicBaseUrl: MEDIA_PUBLIC_BASE_URL,
      signingSecret: "0".repeat(32),
    });

    app = buildServer(authDeps, "0".repeat(32), {
      storage,
      mediaPublicBaseUrl: MEDIA_PUBLIC_BASE_URL,
    });

    const loginResponse = await app.inject({
      method: "POST",
      url: "/trpc/auth.session.login",
      payload: { email: STAFF_OWNER_EMAIL, password: STAFF_PASSWORD },
    });
    cookie = toRequestCookie(loginResponse.headers["set-cookie"]);

    await testDb.superuserClient.query(
      `UPDATE app.staff_sessions SET mfa_verified_at = now()
       WHERE id = (
         SELECT s.id FROM app.staff_sessions s
         JOIN app.staff_users u ON u.id = s.staff_user_id
         WHERE u.email = $1 AND s.revoked_at IS NULL
         ORDER BY s.created_at DESC LIMIT 1
       )`,
      [STAFF_OWNER_EMAIL],
    );
    await redis.flushall();

    const category = await mutateOk<{ id: string }>("catalog.category.create", {
      slug: `perfumeria-${Date.now()}`,
      name: "Perfumería",
    });
    const product = await mutateOk<{ id: string }>("catalog.product.create", {
      kind: "perfume",
      slug: `layton-${Date.now()}`,
      name: "Layton",
      categoryIds: [category.id],
      primaryCategoryId: category.id,
      perfumeDetails: {
        concentration: "edp",
        nominalVolumeMl: 100,
        olfactoryFamily: "amaderado",
        notesTop: ["bergamota"],
        notesHeart: ["jazmín"],
        notesBase: ["sándalo"],
        isDecantable: true,
        wasteFactor: 0.02,
        unusableResidueMl: 2,
        evaporationMlYear: 0.5,
      },
    });
    productId = product.id;
  });

  afterEach(async () => {
    await app.close();
    await redis.flushall();
    redis.disconnect();
    await rm(mediaStorageDir, { recursive: true, force: true });
  });

  it("RF-CAT-08 · sube una imagen real, genera los 8 derivados y los persiste en disco", async () => {
    const response = await uploadMedia(
      { productId },
      { filename: "foto.jpg", contentType: "image/jpeg", content: validJpeg },
    );

    expect(response.statusCode).toBe(201);
    const media = response.json();
    expect(media.productId).toBe(productId);
    expect(media.mimeType).toBe("image/jpeg");
    expect(media.width).toBe(100);
    expect(media.height).toBe(80);
    expect(media.derivatives).toHaveLength(8);
    for (const derivative of media.derivatives) {
      expect(new URL(derivative.url).host).toBe("media.localhost:9999");
    }

    const catalogFiles = await readdir(join(mediaStorageDir, "catalog"), { recursive: true });
    // 8 derivados = 1 carpeta (sha256) + 8 archivos.
    expect(catalogFiles).toHaveLength(9);

    // Verifica que el archivo servido es REALMENTE el formato que dice ser —
    // no solo que la extensión coincide. AVIF vive en un contenedor
    // HEIF/ISOBMFF: sharp reporta `format: "heif"` con `compression: "av1"`
    // para un AVIF real, no `format: "avif"` (eso es solo la extensión de
    // archivo, no lo que sharp lee del contenido).
    const avifDerivative = media.derivatives.find((d: { format: string }) => d.format === "avif");
    const webpDerivative = media.derivatives.find((d: { format: string }) => d.format === "webp");

    const avifMetadata = await sharp(
      await readFile(join(mediaStorageDir, new URL(avifDerivative.url).pathname)),
    ).metadata();
    expect(avifMetadata.format).toBe("heif");
    expect(avifMetadata.compression).toBe("av1");
    expect(avifMetadata.width).toBeLessThanOrEqual(avifDerivative.width);

    const webpMetadata = await sharp(
      await readFile(join(mediaStorageDir, new URL(webpDerivative.url).pathname)),
    ).metadata();
    expect(webpMetadata.format).toBe("webp");
    expect(webpMetadata.width).toBeLessThanOrEqual(webpDerivative.width);
  });

  it("RF-CAT-08 · un .exe renombrado a .jpg (Content-Type declarado image/jpeg) se rechaza por bytes mágicos", async () => {
    const fakeExe = Buffer.from([
      0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00,
    ]);

    const response = await uploadMedia(
      { productId },
      { filename: "foto.jpg", contentType: "image/jpeg", content: fakeExe },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_UNSUPPORTED_FILE_TYPE");
  });

  it("una imagen que supera MEDIA_MAX_DIMENSION_PX se rechaza antes de generar derivados", async () => {
    const oversized = await sharp({
      create: { width: MEDIA_MAX_DIMENSION_PX + 1, height: 1, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();

    const response = await uploadMedia(
      { productId },
      { filename: "panoramica.png", contentType: "image/png", content: oversized },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_IMAGE_TOO_LARGE");
    const filesWritten = await readdir(mediaStorageDir).catch(() => []);
    expect(filesWritten).toHaveLength(0);
  });

  it("un archivo que supera MEDIA_MAX_UPLOAD_BYTES se corta en el stream, nunca llega a sharp", async () => {
    const tooLarge = Buffer.alloc(MEDIA_MAX_UPLOAD_BYTES + 1024, 0);

    const response = await uploadMedia(
      { productId },
      { filename: "gigante.jpg", contentType: "image/jpeg", content: tooLarge },
    );

    expect(response.statusCode).toBe(413);
    expect(response.json().code).toBe("VALIDATION_FILE_TOO_LARGE");
  }, 30_000);

  it("sin sesión de personal, rechaza antes de leer el archivo con 404 — no 401 (docs/api-conventions.md §4.3, la regla del 404)", async () => {
    const boundary = "----sinSesion";
    const payload = buildMultipartBody(
      boundary,
      { productId },
      {
        fieldName: "file",
        filename: "foto.jpg",
        contentType: "image/jpeg",
        content: validJpeg,
      },
    );

    const response = await app.inject({
      method: "POST",
      url: "/media/products",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("NOT_FOUND");
  });

  it("dos imágenes idénticas (mismo sha256) dedupan en una sola fila de media, con dos product_media", async () => {
    // Imagen propia de este test (no `validJpeg`, que comparten otros `it`
    // de este describe) — sha256 único, así el conteo de abajo no se
    // contamina con product_media de otro test que haya subido el mismo
    // contenido a un producto distinto.
    const uniqueJpeg = await sharp({
      create: { width: 37, height: 41, channels: 3, background: "green" },
    })
      .jpeg()
      .toBuffer();

    const category = await mutateOk<{ id: string }>("catalog.category.create", {
      slug: `perfumeria-2-${Date.now()}`,
      name: "Perfumería 2",
    });
    const secondProduct = await mutateOk<{ id: string }>("catalog.product.create", {
      kind: "perfume",
      slug: `layton-2-${Date.now()}`,
      name: "Layton 2",
      categoryIds: [category.id],
      primaryCategoryId: category.id,
      perfumeDetails: {
        concentration: "edp",
        nominalVolumeMl: 100,
        olfactoryFamily: "amaderado",
        notesTop: [],
        notesHeart: [],
        notesBase: [],
        isDecantable: true,
        wasteFactor: 0.02,
        unusableResidueMl: 2,
        evaporationMlYear: 0.5,
      },
    });

    const firstResponse = await uploadMedia(
      { productId },
      { filename: "foto.jpg", contentType: "image/jpeg", content: uniqueJpeg },
    );
    const secondResponse = await uploadMedia(
      { productId: secondProduct.id },
      { filename: "misma-foto.jpg", contentType: "image/jpeg", content: uniqueJpeg },
    );

    expect(firstResponse.statusCode).toBe(201);
    expect(secondResponse.statusCode).toBe(201);
    const mediaId = firstResponse.json().id;
    expect(secondResponse.json().id).toBe(mediaId);

    const mediaRowCount = await testDb.superuserClient.query(
      `SELECT count(*)::int AS n FROM app.media WHERE id = $1`,
      [mediaId],
    );
    expect(mediaRowCount.rows[0].n).toBe(1);

    const productMediaRowCount = await testDb.superuserClient.query(
      `SELECT count(*)::int AS n FROM app.product_media WHERE media_id = $1`,
      [mediaId],
    );
    expect(productMediaRowCount.rows[0].n).toBe(2);
  });

  it("Idempotency-Key: mismo cuerpo devuelve la respuesta guardada, sin duplicar product_media", async () => {
    const idempotencyKey = "11111111-2222-4333-8444-555555555555";

    const first = await uploadMedia(
      { productId },
      { filename: "foto.jpg", contentType: "image/jpeg", content: validJpeg },
      { "idempotency-key": idempotencyKey },
    );
    const replay = await uploadMedia(
      { productId },
      { filename: "foto.jpg", contentType: "image/jpeg", content: validJpeg },
      { "idempotency-key": idempotencyKey },
    );

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());

    const productMediaRowCount = await testDb.superuserClient.query(
      `SELECT count(*)::int AS n FROM app.product_media pm
       JOIN app.products p ON p.id = pm.product_id
       WHERE p.id = $1`,
      [productId],
    );
    expect(productMediaRowCount.rows[0].n).toBe(1);
  });

  it("Idempotency-Key reusada con otro cuerpo → 409", async () => {
    const idempotencyKey = "22222222-3333-4444-8555-666666666666";
    const otherProductCategory = await mutateOk<{ id: string }>("catalog.category.create", {
      slug: `otra-${Date.now()}`,
      name: "Otra",
    });
    const otherProduct = await mutateOk<{ id: string }>("catalog.product.create", {
      kind: "perfume",
      slug: `otro-producto-${Date.now()}`,
      name: "Otro producto",
      categoryIds: [otherProductCategory.id],
      primaryCategoryId: otherProductCategory.id,
      perfumeDetails: {
        concentration: "edp",
        nominalVolumeMl: 50,
        olfactoryFamily: "cítrico",
        notesTop: [],
        notesHeart: [],
        notesBase: [],
        isDecantable: true,
        wasteFactor: 0.02,
        unusableResidueMl: 1,
        evaporationMlYear: 0.3,
      },
    });

    const first = await uploadMedia(
      { productId },
      { filename: "foto.jpg", contentType: "image/jpeg", content: validJpeg },
      { "idempotency-key": idempotencyKey },
    );
    const second = await uploadMedia(
      { productId: otherProduct.id },
      { filename: "foto.jpg", contentType: "image/jpeg", content: validJpeg },
      { "idempotency-key": idempotencyKey },
    );

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("CONFLICT_IDEMPOTENCY_KEY_REUSE");
  });
});
