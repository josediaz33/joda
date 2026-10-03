import { PrismaClient } from "@joda/db";
import type { Clock } from "@joda/domain";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeStaffAuthProvider } from "../../adapters/staffAuth/fakeStaffAuthProvider.js";
import { jodaApiConnectionUrl, startTestDb, type TestDb } from "../../db/testDb.js";
import { buildServer } from "../../index.js";
import type { AuthServiceDeps } from "../auth/service.js";

// Integración real contra Postgres (.claude/rules/testing.md: "nunca
// simulacros de Prisma") — mismo arnés que permission.integration.test.ts
// (WP-C05): startTestDb() real, sesión de personal real, HTTP real vía
// app.inject. Cubre RF-CAT-01…07 de punta a punta (docs/backlog.md,
// WP-C08), no cada combinación — las combinaciones de los CHECK de
// createVariantInput ya están cubiertas en packages/contracts/src/catalog.test.ts,
// sin necesitar Postgres.
const TENANT_ID = "88888888-8888-4888-a888-888888888888";
const STAFF_OWNER_ID = "99999999-9999-4999-a999-999999999991";
const STAFF_OWNER_EMAIL = "owner@jodaparfums.com";
const STAFF_PASSWORD = "correcta";
const MFA_ENCRYPTION_KEY = Buffer.from("1".repeat(64), "hex");
const PLACEHOLDER_MFA_SECRET = "placeholder-nunca-se-descifra-en-este-test";

function createManualClock(initial: Date): Clock {
  return { now: () => initial };
}

function toRequestCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("se esperaba un header Set-Cookie en la respuesta");
  const separator = raw.indexOf(";");
  return separator === -1 ? raw : raw.slice(0, separator);
}

describe("WP-C08 · módulo catálogo (RF-CAT-01…07)", () => {
  let testDb: TestDb;
  let redisContainer: StartedRedisContainer;
  let db: PrismaClient;
  let redis: Redis;
  let app: FastifyInstance;
  let cookie: string;

  async function call<T>(procedure: string, input: unknown): Promise<T> {
    const response = await app.inject({
      method: "GET",
      url: `/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`,
      headers: { cookie },
    });
    if (response.statusCode >= 400) {
      throw new Error(`${procedure} query → ${response.statusCode}: ${response.body}`);
    }
    return response.json().result.data as T;
  }

  async function mutate(procedure: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/trpc/${procedure}`,
      headers: { cookie },
      payload,
    });
  }

  async function mutateOk<T>(procedure: string, payload: Record<string, unknown>): Promise<T> {
    const response = await mutate(procedure, payload);
    if (response.statusCode >= 400) {
      throw new Error(`${procedure} mutation → ${response.statusCode}: ${response.body}`);
    }
    return response.json().result.data as T;
  }

  beforeAll(async () => {
    testDb = await startTestDb();

    await testDb.superuserClient.query(
      `INSERT INTO app.tenants (id, slug, legal_name, trade_name)
       VALUES ($1, 'joda-c08', 'JODA Parfums SRL', 'JODA Parfums')`,
      [TENANT_ID],
    );
    await testDb.superuserClient.query(`SELECT app.seed_roles($1)`, [TENANT_ID]);
    await testDb.superuserClient.query(
      `INSERT INTO app.staff_users
         (id, tenant_id, auth_subject, email, full_name, is_active, mfa_enrolled, mfa_secret_encrypted)
       VALUES ($1, $2, 'auth|owner-c08', $3, 'Test Owner', true, true, $4)`,
      [STAFF_OWNER_ID, TENANT_ID, STAFF_OWNER_EMAIL, PLACEHOLDER_MFA_SECRET],
    );
    const ownerRole = await testDb.superuserClient.query(
      `SELECT id FROM app.roles WHERE tenant_id = $1 AND code = 'owner'`,
      [TENANT_ID],
    );
    await testDb.superuserClient.query(
      `INSERT INTO app.staff_user_roles (tenant_id, staff_user_id, role_id) VALUES ($1, $2, $3)`,
      [TENANT_ID, STAFF_OWNER_ID, ownerRole.rows[0].id],
    );

    db = new PrismaClient({ datasourceUrl: jodaApiConnectionUrl(testDb.container) });
    redisContainer = await new RedisContainer("redis:7").start();
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
        new Map([[STAFF_OWNER_EMAIL, { password: STAFF_PASSWORD, authSubject: "auth|owner-c08" }]]),
      ),
      clock: createManualClock(new Date("2026-01-01T12:00:00.000Z")),
      mfaEncryptionKey: MFA_ENCRYPTION_KEY,
    };
    app = buildServer(authDeps, "0".repeat(32));

    const loginResponse = await app.inject({
      method: "POST",
      url: "/trpc/auth.session.login",
      payload: { email: STAFF_OWNER_EMAIL, password: STAFF_PASSWORD },
    });
    cookie = toRequestCookie(loginResponse.headers["set-cookie"]);

    // Satisface el segundo factor directo en la base (mismo criterio que
    // permission.integration.test.ts) — lo que este archivo ejercita es el
    // módulo catálogo, no el desafío TOTP (WP-C04, ya cubierto aparte).
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
  });

  afterEach(async () => {
    await app.close();
    await redis.flushall();
    redis.disconnect();
  });

  it("RF-CAT-03 · crea una categoría raíz y una hija, con el path materializado encadenado", async () => {
    const root = await mutateOk<{ id: string; path: string }>("catalog.category.create", {
      slug: "perfumeria",
      name: "Perfumería",
    });
    expect(root.path).toBe("perfumeria");

    const child = await mutateOk<{ id: string; path: string; parentId: string | null }>(
      "catalog.category.create",
      { parentId: root.id, slug: "nicho", name: "Nicho" },
    );
    expect(child.path).toBe("perfumeria/nicho");
    expect(child.parentId).toBe(root.id);
  });

  it("RF-CAT-04 · crea un tag", async () => {
    const tag = await mutateOk<{ id: string; slug: string; kind: string }>("catalog.tag.create", {
      slug: "best-seller",
      name: "Best Seller",
      kind: "badge",
    });
    expect(tag.kind).toBe("badge");
  });

  it("RF-CAT-01/02/04 · crea un producto perfume con categoría primaria y tag, y el DTO admin trae los tres niveles", async () => {
    const category = await mutateOk<{ id: string }>("catalog.category.create", {
      slug: "perfumeria-2",
      name: "Perfumería",
    });
    const tag = await mutateOk<{ id: string }>("catalog.tag.create", {
      slug: "novedad",
      name: "Novedad",
    });

    const product = await mutateOk<{
      id: string;
      kind: string;
      status: string;
      categoryIds: string[];
      primaryCategoryId: string | null;
      tagIds: string[];
      facets: Record<string, unknown>;
      perfumeDetails?: { concentration: string; wasteFactor: number };
    }>("catalog.product.create", {
      kind: "perfume",
      slug: "layton",
      name: "Layton",
      categoryIds: [category.id],
      primaryCategoryId: category.id,
      tagIds: [tag.id],
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

    expect(product.kind).toBe("perfume");
    expect(product.status).toBe("draft");
    expect(product.categoryIds).toEqual([category.id]);
    expect(product.primaryCategoryId).toBe(category.id);
    expect(product.tagIds).toEqual([tag.id]);
    expect(product.perfumeDetails?.concentration).toBe("edp");
    // La merma es administrativa: sale en el detalle admin (arriba), nunca en facets.
    expect(product.perfumeDetails?.wasteFactor).toBe(0.02);
    expect(product.facets).toEqual({
      concentration: "edp",
      nominalVolumeMl: 100,
      olfactoryFamily: "amaderado",
      notesTop: ["bergamota"],
      notesHeart: ["jazmín"],
      notesBase: ["sándalo"],
      isDecantable: true,
    });
    expect(product.facets.wasteFactor).toBeUndefined();

    const fetched = await call<{ name: string }>("catalog.product.byId", { id: product.id });
    expect(fetched.name).toBe("Layton");
  });

  it("RF-CAT-01 · crea productos watch y accessory con su detalle tipado", async () => {
    const watchCategory = await mutateOk<{ id: string }>("catalog.category.create", {
      slug: "relojeria",
      name: "Relojería",
    });
    const watch = await mutateOk<{ kind: string; watchDetails?: { movement: string } }>(
      "catalog.product.create",
      {
        kind: "watch",
        slug: "reloj-automatico",
        name: "Reloj Automático",
        categoryIds: [watchCategory.id],
        primaryCategoryId: watchCategory.id,
        watchDetails: {
          movement: "automatic",
          caseMaterial: "acero",
          caseDiameterMm: 40,
          waterResistanceM: 100,
          strapMaterial: "cuero",
          crystal: "zafiro",
          warrantyMonths: 24,
          requiresSerial: true,
        },
      },
    );
    expect(watch.kind).toBe("watch");
    expect(watch.watchDetails?.movement).toBe("automatic");

    const accessoryCategory = await mutateOk<{ id: string }>("catalog.category.create", {
      slug: "accesorios",
      name: "Accesorios",
    });
    const accessory = await mutateOk<{
      kind: string;
      accessoryDetails?: { material: string | null };
    }>("catalog.product.create", {
      kind: "accessory",
      slug: "estuche-cuero",
      name: "Estuche de cuero",
      categoryIds: [accessoryCategory.id],
      primaryCategoryId: accessoryCategory.id,
      accessoryDetails: { material: "cuero", color: "marrón", sizeLabel: null },
    });
    expect(accessory.kind).toBe("accessory");
    expect(accessory.accessoryDetails?.material).toBe("cuero");
  });

  it("RF-CAT-05/06/07 · variantes sealed/bulk/decant, made_to_order con sourceVariantId, y BOM solo sobre decant", async () => {
    const category = await mutateOk<{ id: string }>("catalog.category.create", {
      slug: "perfumeria-3",
      name: "Perfumería",
    });
    const product = await mutateOk<{ id: string }>("catalog.product.create", {
      kind: "perfume",
      slug: "layton-exclusif",
      name: "Layton Exclusif",
      categoryIds: [category.id],
      primaryCategoryId: category.id,
      perfumeDetails: {
        concentration: "extrait",
        nominalVolumeMl: 125,
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

    const sealed = await mutateOk<{ id: string; variantType: string; pricePyg: string }>(
      "catalog.variant.create",
      {
        productId: product.id,
        sku: "LAYTON-125-SELLADO",
        variantType: "sealed",
        uom: "unit",
        sizeMl: 125,
        pricePyg: "2850000",
      },
    );
    expect(sealed.pricePyg).toBe("2850000");

    const duplicateSku = await mutate("catalog.variant.create", {
      productId: product.id,
      sku: "LAYTON-125-SELLADO",
      variantType: "sealed",
      uom: "unit",
      sizeMl: 125,
      pricePyg: "2850000",
    });
    expect(duplicateSku.statusCode).toBe(409);
    expect(duplicateSku.json().error.data.appCode).toBe("CONFLICT_DUPLICATE");

    const bulk = await mutateOk<{ id: string; variantType: string }>("catalog.variant.create", {
      productId: product.id,
      sku: "LAYTON-125-GRANEL",
      variantType: "bulk",
      uom: "ml",
      sizeMl: null,
      pricePyg: "0",
    });

    const decant = await mutateOk<{
      id: string;
      variantType: string;
      productionMode: string;
      sourceVariantId: string | null;
    }>("catalog.variant.create", {
      productId: product.id,
      sku: "LAYTON-10ML-DECANT",
      variantType: "decant",
      uom: "ml",
      sizeMl: 10,
      pricePyg: "285000",
      productionMode: "made_to_order",
      sourceVariantId: bulk.id,
    });
    expect(decant.productionMode).toBe("made_to_order");
    expect(decant.sourceVariantId).toBe(bulk.id);

    const vial = await mutateOk<{ id: string }>("catalog.variant.create", {
      productId: product.id,
      sku: "VIAL-10ML",
      variantType: "supply",
      uom: "unit",
      sizeMl: null,
      pricePyg: "0",
    });

    const bom = await mutateOk<{ id: string; qtyPerUnit: number }>("catalog.bom.create", {
      parentVariantId: decant.id,
      componentVariantId: vial.id,
      qtyPerUnit: 1,
      uom: "unit",
    });
    expect(bom.qtyPerUnit).toBe(1);

    const bomList = await call<unknown[]>("catalog.bom.list", { variantId: decant.id });
    expect(bomList).toHaveLength(1);

    // La trampa explícita del WP: BOM solo sobre una variante decant, nunca
    // sobre sellado/granel (docs/backlog.md, prompts-playbook.md Sesión 28).
    const rejected = await mutate("catalog.bom.create", {
      parentVariantId: sealed.id,
      componentVariantId: vial.id,
      qtyPerUnit: 1,
      uom: "unit",
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.data.appCode).toBe("CONFLICT_BOM_REQUIRES_DECANT_VARIANT");
  });

  it("WP-C08c · dos altas simultáneas de granel dejan una sola variante y una respuesta de conflicto", async () => {
    const product = await testDb.superuserClient.query<{ id: string }>(
      "INSERT INTO app.products (tenant_id, kind, slug, name) VALUES ($1, 'perfume', 'bulk-race-c08c', 'Granel concurrente') RETURNING id",
      [TENANT_ID],
    );
    const firstPayload = {
      productId: product.rows[0]!.id,
      sku: "BULK-RACE-1",
      variantType: "bulk",
      uom: "ml",
      sizeMl: null,
      pricePyg: "0",
    };
    const [first, second] = await Promise.all([
      mutate("catalog.variant.create", firstPayload),
      mutate("catalog.variant.create", { ...firstPayload, sku: "BULK-RACE-2" }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    const count = await testDb.superuserClient.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM app.product_variants WHERE product_id = $1 AND variant_type = 'bulk'",
      [product.rows[0]!.id],
    );
    expect(count.rows[0]!.n).toBe(1);
  });

  it("RF-CAT-01 · update cambia campos y recomputa facets; archive pasa a status archived", async () => {
    const category = await mutateOk<{ id: string }>("catalog.category.create", {
      slug: "perfumeria-4",
      name: "Perfumería",
    });
    const product = await mutateOk<{ id: string }>("catalog.product.create", {
      kind: "perfume",
      slug: "eros",
      name: "Eros",
      categoryIds: [category.id],
      primaryCategoryId: category.id,
      perfumeDetails: {
        concentration: "edt",
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

    const updated = await mutateOk<{
      name: string;
      facets: Record<string, unknown>;
      perfumeDetails?: { concentration: string };
    }>("catalog.product.update", {
      id: product.id,
      name: "Eros Intense",
      perfumeDetails: { concentration: "parfum" },
    });
    expect(updated.name).toBe("Eros Intense");
    expect(updated.perfumeDetails?.concentration).toBe("parfum");
    expect(updated.facets.concentration).toBe("parfum");

    const wrongVertical = await mutate("catalog.product.update", {
      id: product.id,
      watchDetails: { movement: "quartz" },
    });
    expect(wrongVertical.statusCode).toBe(400);
    expect(wrongVertical.json().error.data.appCode).toBe("VALIDATION_WRONG_VERTICAL_DETAILS");

    const archived = await mutateOk<{ status: string }>("catalog.product.archive", {
      id: product.id,
    });
    expect(archived.status).toBe("archived");
  });

  it("docs/api-conventions.md §6 · catalog.product.list pagina por cursor, más nueva primero", async () => {
    const category = await mutateOk<{ id: string }>("catalog.category.create", {
      slug: "perfumeria-5",
      name: "Perfumería",
    });
    const makeProduct = (slug: string) =>
      mutateOk<{ id: string; slug: string }>("catalog.product.create", {
        kind: "accessory",
        slug,
        name: slug,
        categoryIds: [category.id],
        primaryCategoryId: category.id,
        accessoryDetails: { material: null, color: null, sizeLabel: null },
      });

    const first = await makeProduct("cursor-a");
    const second = await makeProduct("cursor-b");

    const page1 = await call<{ items: { id: string }[]; nextCursor: string | null }>(
      "catalog.product.list",
      { limit: 1, kind: "accessory" },
    );
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]?.id).toBe(second.id);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await call<{ items: { id: string }[]; nextCursor: string | null }>(
      "catalog.product.list",
      { limit: 1, kind: "accessory", cursor: page1.nextCursor },
    );
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]?.id).toBe(first.id);
  });
});
