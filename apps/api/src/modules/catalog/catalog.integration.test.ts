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

  // WP-E05b · reubicar categorías. Cada prueba usa slugs propios: las
  // categorías de un test siguen ahí en el siguiente (la base es una sola).
  async function createCategory(slug: string, parentId?: string) {
    return mutateOk<{ id: string; slug: string; path: string; parentId: string | null }>(
      "catalog.category.create",
      { slug, name: slug, ...(parentId ? { parentId } : {}) },
    );
  }

  async function categoryBySlug(slug: string) {
    const page = await call<{
      items: { id: string; slug: string; path: string; parentId: string | null }[];
    }>("catalog.category.list", { limit: 200 });
    const found = page.items.find((item) => item.slug === slug);
    if (!found) throw new Error(`no hay una categoría con slug ${slug}`);
    return found;
  }

  it("RF-CAT-03 · mover una categoría recompone el path de ella y de todos sus descendientes", async () => {
    const perfumeria = await createCategory("mv-perfumeria");
    const nicho = await createCategory("mv-nicho", perfumeria.id);
    await createCategory("mv-arabes", nicho.id);
    const relojes = await createCategory("mv-relojes");

    const moved = await mutateOk<{ parentId: string | null; slug: string; path: string }>(
      "catalog.category.update",
      { id: nicho.id, parentId: relojes.id },
    );

    expect(moved).toMatchObject({
      parentId: relojes.id,
      slug: "mv-nicho",
      path: "mv-relojes/mv-nicho",
    });
    expect((await categoryBySlug("mv-arabes")).path).toBe("mv-relojes/mv-nicho/mv-arabes");
    expect((await categoryBySlug("mv-perfumeria")).path).toBe("mv-perfumeria");
    expect((await categoryBySlug("mv-relojes")).path).toBe("mv-relojes");
  });

  it("RF-CAT-03 · parentId null deja a la categoría como raíz y sus descendientes cuelgan de ella", async () => {
    const accesorios = await createCategory("mv-accesorios");
    const correas = await createCategory("mv-correas", accesorios.id);
    await createCategory("mv-cuero", correas.id);

    const moved = await mutateOk<{ parentId: string | null; path: string }>(
      "catalog.category.update",
      { id: correas.id, parentId: null },
    );

    expect(moved).toMatchObject({ parentId: null, path: "mv-correas" });
    expect((await categoryBySlug("mv-cuero")).path).toBe("mv-correas/mv-cuero");
  });

  it("RF-CAT-03 · mover no arrastra a otra categoría cuyo path solo empieza con el mismo texto", async () => {
    const catalogo = await createCategory("mv-catalogo");
    const relojes = await createCategory("mv-sk");
    const vintage = await createCategory("mv-sk-vintage");
    await createCategory("mv-seiko", vintage.id);

    await mutateOk("catalog.category.update", { id: relojes.id, parentId: catalogo.id });

    expect((await categoryBySlug("mv-sk")).path).toBe("mv-catalogo/mv-sk");
    expect((await categoryBySlug("mv-sk-vintage")).path).toBe("mv-sk-vintage");
    expect((await categoryBySlug("mv-seiko")).path).toBe("mv-sk-vintage/mv-seiko");
  });

  it("RF-CAT-03 · rechaza mover una categoría dentro de sí misma o de un descendiente, y el árbol queda igual", async () => {
    const a = await createCategory("mv-a");
    const b = await createCategory("mv-b", a.id);
    const c = await createCategory("mv-c", b.id);

    const intoItself = await mutate("catalog.category.update", { id: a.id, parentId: a.id });
    const intoChild = await mutate("catalog.category.update", { id: a.id, parentId: b.id });
    const intoGrandchild = await mutate("catalog.category.update", { id: a.id, parentId: c.id });

    expect(intoItself.statusCode).toBe(400);
    expect(intoItself.json().error.data.appCode).toBe("VALIDATION_CATEGORY_CYCLE");
    expect(intoChild.statusCode).toBe(400);
    expect(intoChild.json().error.data.appCode).toBe("VALIDATION_CATEGORY_CYCLE");
    expect(intoGrandchild.statusCode).toBe(400);
    expect(intoGrandchild.json().error.data.appCode).toBe("VALIDATION_CATEGORY_CYCLE");
    expect(await categoryBySlug("mv-a")).toMatchObject({ parentId: null, path: "mv-a" });
    expect(await categoryBySlug("mv-c")).toMatchObject({ parentId: b.id, path: "mv-a/mv-b/mv-c" });
  });

  it("RF-CAT-03 · una categoría de otro tenant no es un destino válido: 404 y la categoría no se mueve", async () => {
    const otherTenantId = "88888888-8888-4888-a888-8888888888e5";
    const foreignCategoryId = "77777777-7777-4777-a777-7777777777e5";
    await testDb.superuserClient.query(
      `INSERT INTO app.tenants (id, slug, legal_name, trade_name)
       VALUES ($1, 'otro-e05b', 'Otra SRL', 'Otra')`,
      [otherTenantId],
    );
    await testDb.superuserClient.query(
      `INSERT INTO app.categories (id, tenant_id, slug, name, path)
       VALUES ($1, $2, 'mv-ajena', 'Ajena', 'mv-ajena')`,
      [foreignCategoryId, otherTenantId],
    );
    const own = await createCategory("mv-propia");

    const moved = await mutate("catalog.category.update", {
      id: own.id,
      parentId: foreignCategoryId,
    });

    expect(moved.statusCode).toBe(404);
    expect(await categoryBySlug("mv-propia")).toMatchObject({ parentId: null, path: "mv-propia" });
  });

  it("RF-CAT-03 · mover una categoría no cambia a qué productos pertenece", async () => {
    const root = await createCategory("mv-destino");
    const nicho = await createCategory("mv-con-productos");
    const product = await mutateOk<{ id: string }>("catalog.product.create", {
      kind: "accessory",
      slug: "mv-estuche",
      name: "Estuche",
      categoryIds: [nicho.id],
      primaryCategoryId: nicho.id,
      accessoryDetails: { material: null, color: null, sizeLabel: null },
    });

    await mutateOk("catalog.category.update", { id: nicho.id, parentId: root.id });

    const fetched = await call<{ categoryIds: string[]; primaryCategoryId: string | null }>(
      "catalog.product.byId",
      { id: product.id },
    );
    expect(fetched.categoryIds).toEqual([nicho.id]);
    expect(fetched.primaryCategoryId).toBe(nicho.id);
  });

  it("RF-CAT-03 · cambiar nombre, orden o visibilidad, o repetir el mismo padre, no mueve la categoría", async () => {
    const parent = await createCategory("mv-padre");
    const child = await createCategory("mv-hija", parent.id);

    const renamed = await mutateOk<{
      name: string;
      position: number;
      isVisible: boolean;
      parentId: string | null;
      path: string;
    }>("catalog.category.update", {
      id: child.id,
      name: "Hija renombrada",
      position: 3,
      isVisible: false,
    });
    const samePlace = await mutateOk<{ parentId: string | null; path: string }>(
      "catalog.category.update",
      { id: child.id, parentId: parent.id },
    );

    expect(renamed).toMatchObject({
      name: "Hija renombrada",
      position: 3,
      isVisible: false,
      parentId: parent.id,
      path: "mv-padre/mv-hija",
    });
    expect(samePlace).toMatchObject({ parentId: parent.id, path: "mv-padre/mv-hija" });
  });

  // Concurrencia (.claude/rules/api.md). Cada prueba retiene una fila desde
  // otra conexión y espera, mirando `pg_stat_activity`, a que la petición
  // quede detenida en un bloqueo: sin esa espera, comprobar «todavía no
  // terminó» daría falso verde en una máquina lenta.
  async function waitUntilABackendIsBlockedOnALock(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      // Dentro de una transacción, pg_stat_activity devuelve la foto del primer
      // acceso: sin descartarla nunca se ve el cambio.
      await testDb.superuserClient.query("SELECT pg_stat_clear_snapshot()");
      const blocked = await testDb.superuserClient.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
      );
      if (blocked.rows[0].n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("la petición nunca quedó esperando un bloqueo");
  }

  /**
   * Fuerza para `joda_api` el recorrido del heap (sin índice) y lo devuelve a su
   * estado. Bajo RLS el plan normal recorre el índice de la clave primaria y ya
   * entrega las filas ordenadas por `id`, así que sin esto un `ORDER BY` de
   * menos no se nota. `ALTER ROLE ... SET` solo vale para conexiones nuevas: hay
   * que reconectar el pool, al entrar y al salir.
   */
  async function withHeapPlansForApiRole(body: () => Promise<void>): Promise<void> {
    const settings = ["enable_indexscan", "enable_bitmapscan", "enable_indexonlyscan"];
    try {
      for (const setting of settings) {
        await testDb.superuserClient.query(`ALTER ROLE joda_api SET ${setting} = off`);
      }
      await db.$disconnect();
      await body();
    } finally {
      for (const setting of settings) {
        await testDb.superuserClient.query(`ALTER ROLE joda_api RESET ${setting}`);
      }
      await db.$disconnect();
    }
  }

  it("RF-CAT-03 · dos movimientos cruzados no arman un ciclo: el segundo espera, lee el árbol del primero y se rechaza", async () => {
    const a = await createCategory("mv-cruz-a");
    const b = await createCategory("mv-cruz-b");

    // Otra transacción deja a B bajo A y todavía no confirma. Si la petición «A
    // bajo B» leyera el árbol antes de tomar el bloqueo, vería a B como raíz,
    // no vería ciclo, y al confirmarse la otra armaría A → B → A.
    await testDb.superuserClient.query("BEGIN");
    let released = false;
    let pending: ReturnType<typeof mutate> | undefined;
    try {
      await testDb.superuserClient.query(
        "UPDATE app.categories SET parent_id = $1, path = 'mv-cruz-a/mv-cruz-b' WHERE id = $2",
        [a.id, b.id],
      );
      pending = mutate("catalog.category.update", { id: a.id, parentId: b.id });
      await waitUntilABackendIsBlockedOnALock();
      await testDb.superuserClient.query("COMMIT");
      released = true;
      const response = await pending;

      expect(response.statusCode).toBe(400);
      expect(response.json().error.data.appCode).toBe("VALIDATION_CATEGORY_CYCLE");
    } finally {
      if (!released) {
        await testDb.superuserClient.query("ROLLBACK");
        await pending?.catch(() => undefined);
      }
    }
    expect(await categoryBySlug("mv-cruz-a")).toMatchObject({
      parentId: null,
      path: "mv-cruz-a",
    });
    expect(await categoryBySlug("mv-cruz-b")).toMatchObject({
      parentId: a.id,
      path: "mv-cruz-a/mv-cruz-b",
    });
  });

  it("RF-CAT-03 · dar de alta una subcategoría espera a un movimiento en curso y cuelga del path ya nuevo", async () => {
    const root = await createCategory("mv-alta-raiz");
    const moving = await createCategory("mv-alta-mueve");

    // Otra transacción mueve `moving` bajo `root` y todavía no confirma. Un alta
    // bajo `moving` que leyera su `path` antes de esperar lo heredaría viejo.
    await testDb.superuserClient.query("BEGIN");
    let released = false;
    let pending: ReturnType<typeof mutate> | undefined;
    try {
      await testDb.superuserClient.query(
        "UPDATE app.categories SET parent_id = $1, path = 'mv-alta-raiz/mv-alta-mueve' WHERE id = $2",
        [root.id, moving.id],
      );
      pending = mutate("catalog.category.create", {
        parentId: moving.id,
        slug: "mv-alta-hija",
        name: "Hija",
      });
      await waitUntilABackendIsBlockedOnALock();
      await testDb.superuserClient.query("COMMIT");
      released = true;
      const response = await pending;

      expect(response.statusCode).toBe(200);
    } finally {
      if (!released) {
        await testDb.superuserClient.query("ROLLBACK");
        await pending?.catch(() => undefined);
      }
    }
    expect((await categoryBySlug("mv-alta-hija")).path).toBe(
      "mv-alta-raiz/mv-alta-mueve/mv-alta-hija",
    );
  });

  it("RF-CAT-03 · toma las categorías en orden ascendente de id aunque el plan no lo dé: con el heap forzado, la de id más alto no queda tomada mientras espera la de id más bajo", async () => {
    const left = await createCategory("mv-orden-izq");
    // La de id MÁS ALTO se inserta primero: en un recorrido del heap sale
    // primero. Sin el `ORDER BY` el movimiento la tomaría antes que la de id más
    // bajo y, con otro movimiento en orden inverso, habría interbloqueo.
    const highestId = "ffffffff-0000-4000-8000-0000000000e5";
    const lowestId = "00000000-0000-4000-8000-0000000000e5";
    await testDb.superuserClient.query(
      `INSERT INTO app.categories (id, tenant_id, slug, name, path)
       VALUES ($1, $3, 'mv-orden-alta', 'Alta', 'mv-orden-alta'),
              ($2, $3, 'mv-orden-baja', 'Baja', 'mv-orden-baja')`,
      [highestId, lowestId, TENANT_ID],
    );
    let status = 0;

    await withHeapPlansForApiRole(async () => {
      await testDb.superuserClient.query("BEGIN");
      let released = false;
      let pending: ReturnType<typeof mutate> | undefined;
      try {
        // Otra transacción retiene la de id más bajo...
        await testDb.superuserClient.query(
          "SELECT id FROM app.categories WHERE id = $1 FOR NO KEY UPDATE",
          [lowestId],
        );
        pending = mutate("catalog.category.update", { id: left.id, parentId: null });
        await waitUntilABackendIsBlockedOnALock();
        // ...y el movimiento, que espera por ella, todavía no tiene la de id más
        // alto: NOWAIT la consigue. Con el orden del heap ya la tendría tomada y
        // esto falla (55P03).
        await testDb.superuserClient.query(
          "SELECT id FROM app.categories WHERE id = $1 FOR UPDATE NOWAIT",
          [highestId],
        );
        await testDb.superuserClient.query("COMMIT");
        released = true;
        status = (await pending).statusCode;
      } finally {
        if (!released) {
          await testDb.superuserClient.query("ROLLBACK");
          await pending?.catch(() => undefined);
        }
      }
    });

    expect(status).toBe(200);
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

    const forbiddenBulkVisibility = await mutate("catalog.variant.update", {
      id: bulk.id,
      onlineVisible: true,
    });
    expect(forbiddenBulkVisibility.statusCode).toBe(400);
    // WP-B17 (RN-CAT-02): la base rechaza un granel publicado aun al dueño de
    // la tabla; `updateVariant` ya no lo normaliza porque no hace falta.
    await expect(
      testDb.superuserClient.query(
        `UPDATE app.product_variants SET online_visible = true WHERE id = $1`,
        [bulk.id],
      ),
    ).rejects.toThrow(/product_variants_online_visible_type_check/);
    const renamedBulk = await mutateOk<{ sku: string; onlineVisible: boolean }>(
      "catalog.variant.update",
      { id: bulk.id, sku: "LAYTON-GRANEL-B17" },
    );
    expect(renamedBulk.sku).toBe("LAYTON-GRANEL-B17");
    expect(renamedBulk.onlineVisible).toBe(false);

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

  // WP-E05c, decisión de José sobre #90: las variantes de un reloj heredan
  // `is_serialized` de `requires_serial` del producto al crearse, no se marcan
  // aparte. La recepción de una variante serializada exige cargar los seriales
  // (RN-SER, WP-C15): un reloj sin serie no puede trabarse al recibirlo, y uno con
  // serie no puede entrar sin registrarla. WP-C08f extiende la misma guarda a
  // `updateVariant`.
  async function createWatchProduct(suffix: string, requiresSerial: boolean) {
    const category = await mutateOk<{ id: string }>("catalog.category.create", {
      slug: `relojeria-${suffix}`,
      name: "Relojería",
    });
    return mutateOk<{ id: string }>("catalog.product.create", {
      kind: "watch",
      slug: `reloj-${suffix}`,
      name: `Reloj ${suffix}`,
      categoryIds: [category.id],
      primaryCategoryId: category.id,
      watchDetails: {
        movement: "automatic",
        caseMaterial: "acero",
        caseDiameterMm: 40,
        waterResistanceM: 100,
        strapMaterial: "cuero",
        crystal: "zafiro",
        warrantyMonths: 24,
        requiresSerial,
      },
    });
  }

  function unitVariantPayload(productId: string, sku: string, extra: Record<string, unknown>) {
    return {
      productId,
      sku,
      variantType: "unit",
      uom: "unit",
      sizeMl: null,
      pricePyg: "3500000",
      ...extra,
    };
  }

  it("WP-E05c · la variante de un reloj con requires_serial = true nace serializada (RN-SER-02)", async () => {
    const watch = await createWatchProduct("serie-e05c", true);
    const variant = await mutateOk<{ isSerialized: boolean }>(
      "catalog.variant.create",
      unitVariantPayload(watch.id, "RELOJ-SERIE-E05C", {}),
    );
    expect(variant.isSerialized).toBe(true);
  });

  it("WP-E05c · la variante de un reloj con requires_serial = false nace sin serie (RN-SER-02)", async () => {
    const watch = await createWatchProduct("sinserie-e05c", false);
    const variant = await mutateOk<{ isSerialized: boolean }>(
      "catalog.variant.create",
      unitVariantPayload(watch.id, "RELOJ-SINSERIE-E05C", {}),
    );
    expect(variant.isSerialized).toBe(false);
  });

  it("WP-E05c · un isSerialized que contradice al producto se rechaza, en los dos sentidos, y no crea la variante", async () => {
    const withSerial = await createWatchProduct("contra-con-e05c", true);
    const withoutSerial = await createWatchProduct("contra-sin-e05c", false);

    const turnedOff = await mutate(
      "catalog.variant.create",
      unitVariantPayload(withSerial.id, "RELOJ-CONTRA-1", { isSerialized: false }),
    );
    expect(turnedOff.statusCode).toBe(400);
    expect(turnedOff.json().error.data.appCode).toBe("VALIDATION_SERIALIZED_INHERITED");

    const turnedOn = await mutate(
      "catalog.variant.create",
      unitVariantPayload(withoutSerial.id, "RELOJ-CONTRA-2", { isSerialized: true }),
    );
    expect(turnedOn.statusCode).toBe(400);
    expect(turnedOn.json().error.data.appCode).toBe("VALIDATION_SERIALIZED_INHERITED");

    const created = await testDb.superuserClient.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM app.product_variants WHERE product_id = ANY($1::uuid[])",
      [[withSerial.id, withoutSerial.id]],
    );
    expect(created.rows[0]!.n).toBe(0);
  });

  it("WP-E05c · un isSerialized que coincide con el producto se acepta (RN-SER-02)", async () => {
    const watch = await createWatchProduct("coincide-e05c", true);
    const variant = await mutateOk<{ isSerialized: boolean }>(
      "catalog.variant.create",
      unitVariantPayload(watch.id, "RELOJ-COINCIDE-E05C", { isSerialized: true }),
    );
    expect(variant.isSerialized).toBe(true);
  });

  // Una variante serializada se mide en unidades enteras (CHECK de 0003). El
  // refine de `createVariantInput` solo ve lo que manda el cliente, no lo que se
  // hereda: sin este chequeo un reloj con serie aceptaría una variante en ml y la
  // base la rechazaría con un conflicto genérico. Es una restricción que antes no
  // existía: un reloj sin herencia aceptaba variantes en ml.
  it("WP-E05c · una variante en ml de un reloj con serie se rechaza con un error claro (RN-SER-02)", async () => {
    const watch = await createWatchProduct("ml-e05c", true);
    const inMl = await mutate("catalog.variant.create", {
      productId: watch.id,
      sku: "RELOJ-ML-E05C",
      variantType: "bulk",
      uom: "ml",
      sizeMl: null,
      pricePyg: "0",
    });
    expect(inMl.statusCode).toBe(400);
    expect(inMl.json().error.data.appCode).toBe("VALIDATION_SERIALIZED_REQUIRES_UNIT");
  });

  it("WP-E05c · las variantes de un accesorio no heredan nada: lo que se manda se respeta (RN-SER-02)", async () => {
    const category = await mutateOk<{ id: string }>("catalog.category.create", {
      slug: "accesorios-e05c",
      name: "Accesorios",
    });
    const accessory = await mutateOk<{ id: string }>("catalog.product.create", {
      kind: "accessory",
      slug: "estuche-e05c",
      name: "Estuche E05c",
      categoryIds: [category.id],
      primaryCategoryId: category.id,
      accessoryDetails: { material: null, color: null, sizeLabel: null },
    });
    const serialized = await mutateOk<{ isSerialized: boolean }>(
      "catalog.variant.create",
      unitVariantPayload(accessory.id, "ESTUCHE-E05C-SERIE", { isSerialized: true }),
    );
    const plain = await mutateOk<{ isSerialized: boolean }>(
      "catalog.variant.create",
      unitVariantPayload(accessory.id, "ESTUCHE-E05C-PLANO", {}),
    );
    expect(serialized.isSerialized).toBe(true);
    expect(plain.isSerialized).toBe(false);
  });

  // WP-C08f. `updateVariant` aceptaba un `isSerialized` sin mirar el producto: se
  // podía apagar en la variante de un reloj con serie (entra sin registrarla) o
  // encender en la de uno sin serie (se traba al recibirlo).
  it("WP-C08f · un isSerialized que contradice al producto se rechaza al actualizar, en los dos sentidos, y la variante queda como estaba (RN-SER-02)", async () => {
    const withSerial = await createWatchProduct("upd-con-c08f", true);
    const withoutSerial = await createWatchProduct("upd-sin-c08f", false);
    const serialized = await mutateOk<{ id: string }>(
      "catalog.variant.create",
      unitVariantPayload(withSerial.id, "RELOJ-UPD-CON-C08F", {}),
    );
    const plain = await mutateOk<{ id: string }>(
      "catalog.variant.create",
      unitVariantPayload(withoutSerial.id, "RELOJ-UPD-SIN-C08F", {}),
    );

    const turnedOff = await mutate("catalog.variant.update", {
      id: serialized.id,
      isSerialized: false,
    });
    expect(turnedOff.statusCode).toBe(400);
    expect(turnedOff.json().error.data.appCode).toBe("VALIDATION_SERIALIZED_INHERITED");
    expect(turnedOff.json().error.message).toBe(
      "Las variantes de un reloj toman el número de serie de requiresSerial del producto (acá: sí); no se marcan aparte.",
    );

    const turnedOn = await mutate("catalog.variant.update", {
      id: plain.id,
      isSerialized: true,
    });
    expect(turnedOn.statusCode).toBe(400);
    expect(turnedOn.json().error.data.appCode).toBe("VALIDATION_SERIALIZED_INHERITED");

    const serializedAfter = await call<{ isSerialized: boolean }>("catalog.variant.byId", {
      id: serialized.id,
    });
    const plainAfter = await call<{ isSerialized: boolean }>("catalog.variant.byId", {
      id: plain.id,
    });
    expect(serializedAfter.isSerialized).toBe(true);
    expect(plainAfter.isSerialized).toBe(false);
  });

  it("WP-C08f · una variante de reloj anterior a E05c que contradice al producto se edita sin tocar isSerialized, y mandar el valor que coincide la repara (RN-SER-02)", async () => {
    const watch = await createWatchProduct("legada-c08f", true);
    const variant = await mutateOk<{ id: string }>(
      "catalog.variant.create",
      unitVariantPayload(watch.id, "RELOJ-LEGADA-C08F", {}),
    );
    await testDb.superuserClient.query(
      `UPDATE app.product_variants SET is_serialized = false WHERE id = $1`,
      [variant.id],
    );

    const repriced = await mutateOk<{ isSerialized: boolean; pricePyg: string }>(
      "catalog.variant.update",
      { id: variant.id, pricePyg: "3600000" },
    );
    expect(repriced.pricePyg).toBe("3600000");
    expect(repriced.isSerialized).toBe(false);

    const repaired = await mutateOk<{ isSerialized: boolean }>("catalog.variant.update", {
      id: variant.id,
      isSerialized: true,
    });
    expect(repaired.isSerialized).toBe(true);
  });

  it("WP-C08f · una variante en ml de un reloj con serie no se serializa al actualizar: error claro y sin cambios (RN-SER-02)", async () => {
    const watch = await createWatchProduct("ml-upd-c08f", true);
    const inMl = await testDb.superuserClient.query<{ id: string }>(
      `INSERT INTO app.product_variants (tenant_id, product_id, sku, variant_type, uom, price_pyg)
       VALUES ($1, $2, 'RELOJ-ML-UPD-C08F', 'bulk', 'ml', 0) RETURNING id`,
      [TENANT_ID, watch.id],
    );

    const response = await mutate("catalog.variant.update", {
      id: inMl.rows[0]!.id,
      isSerialized: true,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.data.appCode).toBe("VALIDATION_SERIALIZED_REQUIRES_UNIT");

    const after = await call<{ isSerialized: boolean }>("catalog.variant.byId", {
      id: inMl.rows[0]!.id,
    });
    expect(after.isSerialized).toBe(false);
  });

  it("WP-C08f · las variantes de un accesorio se serializan y se desserializan al actualizar: no heredan nada (RN-SER-02)", async () => {
    const category = await mutateOk<{ id: string }>("catalog.category.create", {
      slug: "accesorios-c08f",
      name: "Accesorios",
    });
    const accessory = await mutateOk<{ id: string }>("catalog.product.create", {
      kind: "accessory",
      slug: "estuche-c08f",
      name: "Estuche C08f",
      categoryIds: [category.id],
      primaryCategoryId: category.id,
      accessoryDetails: { material: null, color: null, sizeLabel: null },
    });
    const variant = await mutateOk<{ id: string }>(
      "catalog.variant.create",
      unitVariantPayload(accessory.id, "ESTUCHE-C08F", {}),
    );

    const turnedOn = await mutateOk<{ isSerialized: boolean }>("catalog.variant.update", {
      id: variant.id,
      isSerialized: true,
    });
    const turnedOff = await mutateOk<{ isSerialized: boolean }>("catalog.variant.update", {
      id: variant.id,
      isSerialized: false,
    });
    expect(turnedOn.isSerialized).toBe(true);
    expect(turnedOff.isSerialized).toBe(false);
  });

  // WP-B17. Control de no-regresión, no un test del cambio: la normalización de
  // `updateVariant` ya no existe, y esto fija que actualizar una variante que sí
  // se publica (acá un `unit`) no le apaga el flag. La normalización original
  // solo miraba el granel, así que esta prueba también pasaba antes de B17.
  it("WP-B17 · actualizar una variante publicable no cambia online_visible (RN-CAT-02)", async () => {
    const watch = await createWatchProduct("visible-b17", false);
    const variant = await mutateOk<{ id: string }>(
      "catalog.variant.create",
      unitVariantPayload(watch.id, "RELOJ-VISIBLE-B17", {}),
    );
    await testDb.superuserClient.query(
      `UPDATE app.product_variants SET online_visible = true WHERE id = $1`,
      [variant.id],
    );

    const updated = await mutateOk<{ onlineVisible: boolean; pricePyg: string }>(
      "catalog.variant.update",
      { id: variant.id, pricePyg: "3700000" },
    );
    expect(updated.pricePyg).toBe("3700000");
    expect(updated.onlineVisible).toBe(true);
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

    const forbiddenActivation = await mutate("catalog.product.update", {
      id: product.id,
      status: "active",
    });
    expect(forbiddenActivation.statusCode).toBe(400);
    expect(
      (await call<{ status: string }>("catalog.product.byId", { id: product.id })).status,
    ).toBe("draft");

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
