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
// WP-C08g: un usuario con `catalog.product:read` y `write` pero sin `publish` (no hay rol
// estándar con esa forma: `manager` los tiene todos), para probar que escribir no alcanza.
const STAFF_WRITER_ID = "99999999-9999-4999-a999-999999999993";
const STAFF_WRITER_EMAIL = "escritor@jodaparfums.com";
// WP-C08e: un usuario que solo puede leer el catálogo (rol estándar `vendedor`).
const STAFF_READER_ID = "99999999-9999-4999-a999-999999999994";
const STAFF_READER_EMAIL = "lector@jodaparfums.com";
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

    await testDb.superuserClient.query(
      `INSERT INTO app.staff_users
         (id, tenant_id, auth_subject, email, full_name, is_active, mfa_enrolled, mfa_secret_encrypted)
       VALUES ($1, $2, 'auth|writer-c08g', $3, 'Test Writer', true, true, $4)`,
      [STAFF_WRITER_ID, TENANT_ID, STAFF_WRITER_EMAIL, PLACEHOLDER_MFA_SECRET],
    );
    await testDb.superuserClient.query(
      `INSERT INTO app.staff_users
         (id, tenant_id, auth_subject, email, full_name, is_active, mfa_enrolled, mfa_secret_encrypted)
       VALUES ($1, $2, 'auth|reader-c08e', $3, 'Test Reader', true, true, $4)`,
      [STAFF_READER_ID, TENANT_ID, STAFF_READER_EMAIL, PLACEHOLDER_MFA_SECRET],
    );
    const sellerRole = await testDb.superuserClient.query(
      `SELECT id FROM app.roles WHERE tenant_id = $1 AND code = 'vendedor'`,
      [TENANT_ID],
    );
    await testDb.superuserClient.query(
      `INSERT INTO app.staff_user_roles (tenant_id, staff_user_id, role_id) VALUES ($1, $2, $3)`,
      [TENANT_ID, STAFF_READER_ID, sellerRole.rows[0].id],
    );
    const writerRole = await testDb.superuserClient.query(
      `INSERT INTO app.roles (tenant_id, code, name)
       VALUES ($1, 'test_catalogo_sin_publicar', 'Catálogo sin publicar (test)') RETURNING id`,
      [TENANT_ID],
    );
    await testDb.superuserClient.query(
      `INSERT INTO app.role_permissions (tenant_id, role_id, permission_code)
       VALUES ($1, $2, 'catalog.product:read'), ($1, $2, 'catalog.product:write')`,
      [TENANT_ID, writerRole.rows[0].id],
    );
    await testDb.superuserClient.query(
      `INSERT INTO app.staff_user_roles (tenant_id, staff_user_id, role_id) VALUES ($1, $2, $3)`,
      [TENANT_ID, STAFF_WRITER_ID, writerRole.rows[0].id],
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
        new Map([
          [STAFF_OWNER_EMAIL, { password: STAFF_PASSWORD, authSubject: "auth|owner-c08" }],
          [STAFF_WRITER_EMAIL, { password: STAFF_PASSWORD, authSubject: "auth|writer-c08g" }],
          [STAFF_READER_EMAIL, { password: STAFF_PASSWORD, authSubject: "auth|reader-c08e" }],
        ]),
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

  it("RF-CAT-03 · el movimiento lee la categoría ya con el bloqueo: devolverla a su padre original se aplica aunque otra transacción la acabe de sacar", async () => {
    const parent = await createCategory("mv-vuelta-padre");
    const child = await createCategory("mv-vuelta-hija", parent.id);

    // Otra transacción saca a la hija de su padre y todavía no confirma. Una
    // petición que leyera primero a la hija la vería aún bajo `parent`, tomaría
    // «devolverla a su padre» por un no-op y, al confirmarse la otra, la dejaría
    // como raíz.
    await testDb.superuserClient.query("BEGIN");
    let released = false;
    let pending: ReturnType<typeof mutate> | undefined;
    try {
      await testDb.superuserClient.query(
        "UPDATE app.categories SET parent_id = NULL, path = 'mv-vuelta-hija' WHERE id = $1",
        [child.id],
      );
      pending = mutate("catalog.category.update", { id: child.id, parentId: parent.id });
      await waitUntilABackendIsBlockedOnALock();
      await testDb.superuserClient.query("COMMIT");
      released = true;

      expect((await pending).statusCode).toBe(200);
    } finally {
      if (!released) {
        await testDb.superuserClient.query("ROLLBACK");
        await pending?.catch(() => undefined);
      }
    }
    expect(await categoryBySlug("mv-vuelta-hija")).toMatchObject({
      parentId: parent.id,
      path: "mv-vuelta-padre/mv-vuelta-hija",
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

  // WP-C08i. `resolveIsSerialized` solo mira la unidad de medida cuando el producto
  // es un reloj con serie; en cualquier otro producto devolvía lo que mandaba el
  // cliente, y el CHECK `NOT is_serialized OR uom = 'unit'` de 0003 llegaba como un
  // error interno. El granel y el decant se miden en ml y no se serializan.
  it("WP-C08i · isSerialized: true sobre una variante en ml de un producto que no es reloj se rechaza con un 400 claro y sin cambios (RN-SER-02)", async () => {
    const category = await createCategory("perfumeria-c08i");
    const perfume = await mutateOk<{ id: string }>("catalog.product.create", {
      kind: "perfume",
      slug: "perfume-c08i",
      name: "Perfume C08i",
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
        wasteFactor: 0.05,
        unusableResidueMl: 2,
        evaporationMlYear: 0.5,
      },
    });
    const sealed = await mutateOk<{ id: string }>("catalog.variant.create", {
      productId: perfume.id,
      sku: "PERFUME-C08I-SELLADO",
      variantType: "sealed",
      uom: "unit",
      sizeMl: 125,
      pricePyg: "2850000",
    });
    const bulk = await mutateOk<{ id: string }>("catalog.variant.create", {
      productId: perfume.id,
      sku: "PERFUME-C08I-GRANEL",
      variantType: "bulk",
      uom: "ml",
      sizeMl: null,
      pricePyg: "0",
    });
    const decant = await mutateOk<{ id: string }>("catalog.variant.create", {
      productId: perfume.id,
      sku: "PERFUME-C08I-DECANT-10",
      variantType: "decant",
      uom: "ml",
      sizeMl: 10,
      pricePyg: "245000",
      productionMode: "made_to_order",
      sourceVariantId: bulk.id,
    });

    for (const variant of [bulk, decant]) {
      const response = await mutate("catalog.variant.update", {
        id: variant.id,
        isSerialized: true,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.data.appCode).toBe("VALIDATION_SERIALIZED_REQUIRES_UNIT");

      const after = await call<{ isSerialized: boolean }>("catalog.variant.byId", {
        id: variant.id,
      });
      expect(after.isSerialized).toBe(false);
    }

    // Control: el rechazo es por la unidad de medida, no por el producto. Una variante
    // en unidades de un perfume sí se serializa.
    const serialized = await mutateOk<{ isSerialized: boolean }>("catalog.variant.update", {
      id: sealed.id,
      isSerialized: true,
    });
    expect(serialized.isSerialized).toBe(true);
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

  // WP-C08h, decisión de José (2026-10-11): cambiar `requires_serial` de un reloj se
  // propaga a las variantes que ya existen, que heredan `is_serialized` de él.
  async function variantsOf(productId: string) {
    return call<{ id: string; sku: string; isSerialized: boolean }[]>("catalog.variant.list", {
      productId,
    });
  }

  function setRequiresSerial(productId: string, requiresSerial: boolean, extra = {}) {
    return mutate("catalog.product.update", {
      id: productId,
      watchDetails: { requiresSerial },
      ...extra,
    });
  }

  it("WP-C08h · pasar requiresSerial a «sí» serializa las variantes del reloj y no toca las de otro (RN-SER-02)", async () => {
    const watch = await createWatchProduct("prop-si-c08h", false);
    const other = await createWatchProduct("prop-si-otro-c08h", false);
    await mutateOk("catalog.variant.create", unitVariantPayload(watch.id, "RELOJ-PROP-SI-1", {}));
    await mutateOk("catalog.variant.create", unitVariantPayload(watch.id, "RELOJ-PROP-SI-2", {}));
    await mutateOk("catalog.variant.create", unitVariantPayload(other.id, "RELOJ-PROP-OTRO", {}));

    const response = await setRequiresSerial(watch.id, true);
    expect(response.statusCode).toBe(200);

    const changed = await variantsOf(watch.id);
    const untouched = await variantsOf(other.id);
    expect(changed.map((variant) => variant.isSerialized)).toEqual([true, true]);
    expect(untouched.map((variant) => variant.isSerialized)).toEqual([false]);
  });

  it("WP-C08h · pasar requiresSerial a «no» desserializa las variantes del reloj (RN-SER-02)", async () => {
    const watch = await createWatchProduct("prop-no-c08h", true);
    await mutateOk("catalog.variant.create", unitVariantPayload(watch.id, "RELOJ-PROP-NO-1", {}));
    await mutateOk("catalog.variant.create", unitVariantPayload(watch.id, "RELOJ-PROP-NO-2", {}));

    const response = await setRequiresSerial(watch.id, false);
    expect(response.statusCode).toBe(200);

    const changed = await variantsOf(watch.id);
    expect(changed.map((variant) => variant.isSerialized)).toEqual([false, false]);
  });

  it("WP-C08h · guardar el reloj con el mismo requiresSerial «sí» no propaga ni revalida una variante anterior a E05c (RN-SER-02)", async () => {
    const watch = await createWatchProduct("prop-igual-si-c08h", true);
    const variant = await mutateOk<{ id: string }>(
      "catalog.variant.create",
      unitVariantPayload(watch.id, "RELOJ-PROP-IGUAL-SI", {}),
    );
    await testDb.superuserClient.query(
      `UPDATE app.product_variants SET is_serialized = false WHERE id = $1`,
      [variant.id],
    );

    const response = await setRequiresSerial(watch.id, true, { name: "Reloj renombrado" });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.data.name).toBe("Reloj renombrado");

    const after = await variantsOf(watch.id);
    expect(after.map((v) => v.isSerialized)).toEqual([false]);
  });

  // El caso que justifica «solo si cambia»: el formulario del admin reenvía
  // `watchDetails` completo en cada guardado. Con unidades registradas en una
  // variante anterior a E05c, propagar siempre frenaría una edición del nombre.
  it("WP-C08h · guardar el reloj con el mismo requiresSerial «no» no se frena por unidades registradas en una variante anterior a E05c (RN-SER-02)", async () => {
    const watch = await createWatchProduct("prop-igual-no-c08h", false);
    const variant = await mutateOk<{ id: string }>(
      "catalog.variant.create",
      unitVariantPayload(watch.id, "RELOJ-PROP-IGUAL-NO", {}),
    );
    await testDb.superuserClient.query(
      `UPDATE app.product_variants SET is_serialized = true WHERE id = $1`,
      [variant.id],
    );
    await testDb.superuserClient.query(
      `INSERT INTO app.serialized_units (tenant_id, variant_id, serial_number)
       VALUES ($1, $2, 'SN-PROP-IGUAL-NO')`,
      [TENANT_ID, variant.id],
    );

    const response = await setRequiresSerial(watch.id, false, { name: "Reloj renombrado" });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.data.name).toBe("Reloj renombrado");

    const after = await variantsOf(watch.id);
    expect(after.map((v) => v.isSerialized)).toEqual([true]);
  });

  it("WP-C08h · requiresSerial a «sí» con una variante en ml se rechaza, nombra el SKU y no cambia nada (RN-SER-02)", async () => {
    const watch = await createWatchProduct("prop-ml-c08h", false);
    await mutateOk("catalog.variant.create", unitVariantPayload(watch.id, "RELOJ-PROP-UNIT", {}));
    await testDb.superuserClient.query(
      `INSERT INTO app.product_variants (tenant_id, product_id, sku, variant_type, uom, price_pyg)
       VALUES ($1, $2, 'RELOJ-PROP-ML', 'bulk', 'ml', 0)`,
      [TENANT_ID, watch.id],
    );

    const response = await setRequiresSerial(watch.id, true);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.data.appCode).toBe("CONFLICT_REQUIRES_SERIAL_VARIANT_NOT_UNIT");
    expect(response.json().error.message).toContain("RELOJ-PROP-ML");
    expect(response.json().error.data.details).toEqual({ skus: ["RELOJ-PROP-ML"] });

    const product = await call<{ watchDetails: { requiresSerial: boolean } }>(
      "catalog.product.byId",
      { id: watch.id },
    );
    const variants = await variantsOf(watch.id);
    expect(product.watchDetails.requiresSerial).toBe(false);
    expect(variants.map((variant) => variant.isSerialized)).toEqual([false, false]);
  });

  it("WP-C08h · requiresSerial a «no» con unidades registradas se rechaza y no cambia nada (RN-SER-02)", async () => {
    const watch = await createWatchProduct("prop-unidades-c08h", true);
    const variant = await mutateOk<{ id: string }>(
      "catalog.variant.create",
      unitVariantPayload(watch.id, "RELOJ-PROP-UNIDADES", {}),
    );
    await testDb.superuserClient.query(
      `INSERT INTO app.serialized_units (tenant_id, variant_id, serial_number)
       VALUES ($1, $2, 'SN-PROP-UNIDADES')`,
      [TENANT_ID, variant.id],
    );

    const response = await setRequiresSerial(watch.id, false);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.data.appCode).toBe("CONFLICT_REQUIRES_SERIAL_UNITS_REGISTERED");
    expect(response.json().error.data.details).toEqual({ registeredUnits: 1 });

    const product = await call<{ watchDetails: { requiresSerial: boolean } }>(
      "catalog.product.byId",
      { id: watch.id },
    );
    const variants = await variantsOf(watch.id);
    expect(product.watchDetails.requiresSerial).toBe(true);
    expect(variants.map((v) => v.isSerialized)).toEqual([true]);
  });

  it("WP-C08h · un reloj sin variantes cambia requiresSerial sin más (RN-SER-02)", async () => {
    const watch = await createWatchProduct("prop-vacio-c08h", false);

    const response = await setRequiresSerial(watch.id, true);
    expect(response.statusCode).toBe(200);
    expect(response.json().result.data.watchDetails.requiresSerial).toBe(true);
  });

  // La propagación lee las variantes y después escribe; crear o actualizar una
  // variante lee `requires_serial` y después escribe. Cada prueba retiene el
  // bloqueo del otro lado desde otra conexión (como en los movimientos de
  // categorías) y espera a que la petición quede detenida: sin eso, «todavía no
  // terminó» daría falso verde en una máquina lenta. Si algo falla antes del
  // COMMIT, el ROLLBACK libera la fila y se espera a la petición pendiente, para
  // que no siga viva durante la prueba siguiente sobre la misma conexión.
  async function whileHolding(
    hold: () => Promise<unknown>,
    request: () => ReturnType<typeof mutate>,
  ): Promise<Awaited<ReturnType<typeof mutate>>> {
    await testDb.superuserClient.query("BEGIN");
    let committed = false;
    let pending: ReturnType<typeof mutate> | undefined;
    try {
      await hold();
      pending = request();
      await waitUntilABackendIsBlockedOnALock();
      await testDb.superuserClient.query("COMMIT");
      committed = true;
      return await pending;
    } finally {
      if (!committed) await testDb.superuserClient.query("ROLLBACK");
      await pending?.catch(() => undefined);
    }
  }

  // La espera del bloqueo puede tardar más que los 5 s por defecto de Vitest.
  const RACE_TEST_TIMEOUT_MS = 20_000;

  it(
    "WP-C08h · una variante que se crea mientras el reloj cambia espera y nace con el valor nuevo (RN-SER-02)",
    async () => {
      const watch = await createWatchProduct("carrera-alta-c08h", false);

      const response = await whileHolding(
        () =>
          testDb.superuserClient.query(
            `UPDATE app.watch_details SET requires_serial = true WHERE product_id = $1`,
            [watch.id],
          ),
        () =>
          mutate("catalog.variant.create", unitVariantPayload(watch.id, "RELOJ-CARRERA-ALTA", {})),
      );

      expect(response.statusCode).toBe(200);
      expect(response.json().result.data.isSerialized).toBe(true);
    },
    RACE_TEST_TIMEOUT_MS,
  );

  it(
    "WP-C08h · una variante que se actualiza mientras el reloj cambia espera y se compara con el valor nuevo (RN-SER-02)",
    async () => {
      const watch = await createWatchProduct("carrera-upd-c08h", false);
      const variant = await mutateOk<{ id: string }>(
        "catalog.variant.create",
        unitVariantPayload(watch.id, "RELOJ-CARRERA-UPD", {}),
      );

      const response = await whileHolding(
        () =>
          testDb.superuserClient.query(
            `UPDATE app.watch_details SET requires_serial = true WHERE product_id = $1`,
            [watch.id],
          ),
        () => mutate("catalog.variant.update", { id: variant.id, isSerialized: false }),
      );

      expect(response.statusCode).toBe(400);
      expect(response.json().error.data.appCode).toBe("VALIDATION_SERIALIZED_INHERITED");
    },
    RACE_TEST_TIMEOUT_MS,
  );

  it(
    "WP-C08h · el cambio del reloj espera a una variante que se está creando y la propaga también (RN-SER-02)",
    async () => {
      const watch = await createWatchProduct("carrera-prod-c08h", false);

      const response = await whileHolding(
        async () => {
          // Lo que hace `createVariant` a mitad de camino: leyó `false` y todavía no confirmó.
          await testDb.superuserClient.query(
            `SELECT 1 FROM app.watch_details WHERE product_id = $1 FOR SHARE`,
            [watch.id],
          );
          await testDb.superuserClient.query(
            `INSERT INTO app.product_variants
               (tenant_id, product_id, sku, variant_type, uom, price_pyg, is_serialized)
             VALUES ($1, $2, 'RELOJ-CARRERA-PROD', 'unit', 'unit', 0, false)`,
            [TENANT_ID, watch.id],
          );
        },
        () => setRequiresSerial(watch.id, true),
      );

      expect(response.statusCode).toBe(200);
      const variants = await variantsOf(watch.id);
      expect(variants.map((variant) => variant.isSerialized)).toEqual([true]);
    },
    RACE_TEST_TIMEOUT_MS,
  );

  // Un guardado que leyó el valor viejo y esperó el bloqueo tiene que comparar con
  // el valor VIGENTE, el que dejó el que confirmó antes. Con el valor viejo vería
  // «igual», no propagaría y dejaría las variantes serializadas bajo un reloj que
  // ya no lo pide: el estado contradictorio que C08f impide.
  it(
    "WP-C08h · un guardado que leyó el valor viejo espera, compara con el vigente y propaga el suyo (RN-SER-02)",
    async () => {
      const watch = await createWatchProduct("carrera-vigente-c08h", false);
      const variant = await mutateOk<{ id: string }>(
        "catalog.variant.create",
        unitVariantPayload(watch.id, "RELOJ-CARRERA-VIGENTE", {}),
      );

      const response = await whileHolding(
        async () => {
          // Otro guardado que ya pasó el reloj a «sí» y serializó la variante, sin confirmar.
          await testDb.superuserClient.query(
            `UPDATE app.watch_details SET requires_serial = true WHERE product_id = $1`,
            [watch.id],
          );
          await testDb.superuserClient.query(
            `UPDATE app.product_variants SET is_serialized = true WHERE id = $1`,
            [variant.id],
          );
        },
        () => setRequiresSerial(watch.id, false),
      );

      expect(response.statusCode).toBe(200);
      expect(response.json().result.data.watchDetails.requiresSerial).toBe(false);
      const variants = await variantsOf(watch.id);
      expect(variants.map((v) => v.isSerialized)).toEqual([false]);
    },
    RACE_TEST_TIMEOUT_MS,
  );

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

  // -------------------------------------------------------------------
  // WP-C08b · docs/api-conventions.md §8.4. `brandId` y `sourceVariantId` se
  // leen bajo RLS antes del INSERT/UPDATE: un id de otro tenant (o inexistente)
  // da 404, el mismo que una categoría ajena, y no revela cuál de las dos cosas
  // pasó. La FK compuesta de 0023 ya lo rechazaba en la base, pero como un
  // conflicto genérico; acá se prueba la respuesta del servicio y que nada se
  // escriba a medias.
  // -------------------------------------------------------------------
  const FOREIGN_TENANT_ID = "88888888-8888-4888-a888-8888888888b8";
  const FOREIGN_BRAND_ID = "77777777-7777-4777-a777-7777777777b1";
  const FOREIGN_PRODUCT_ID = "77777777-7777-4777-a777-7777777777b2";
  const FOREIGN_VARIANT_ID = "77777777-7777-4777-a777-7777777777b3";
  const UNKNOWN_ID = "77777777-7777-4777-a777-7777777777ff";

  /** Un tenant ajeno con una marca, un producto y una variante de granel; idempotente. */
  async function seedForeignCatalog(): Promise<void> {
    const sql = testDb.superuserClient;
    await sql.query(
      `INSERT INTO app.tenants (id, slug, legal_name, trade_name)
       VALUES ($1, 'otro-c08b', 'Otra SRL', 'Otra') ON CONFLICT DO NOTHING`,
      [FOREIGN_TENANT_ID],
    );
    await sql.query(
      `INSERT INTO app.brands (id, tenant_id, slug, name)
       VALUES ($1, $2, 'marca-ajena', 'Marca ajena') ON CONFLICT DO NOTHING`,
      [FOREIGN_BRAND_ID, FOREIGN_TENANT_ID],
    );
    await sql.query(
      `INSERT INTO app.products (id, tenant_id, kind, slug, name)
       VALUES ($1, $2, 'accessory', 'producto-ajeno', 'Producto ajeno') ON CONFLICT DO NOTHING`,
      [FOREIGN_PRODUCT_ID, FOREIGN_TENANT_ID],
    );
    await sql.query(
      `INSERT INTO app.product_variants
         (id, tenant_id, product_id, sku, variant_type, uom, price_pyg)
       VALUES ($1, $2, $3, 'GRANEL-AJENO', 'bulk', 'ml', 0) ON CONFLICT DO NOTHING`,
      [FOREIGN_VARIANT_ID, FOREIGN_TENANT_ID, FOREIGN_PRODUCT_ID],
    );
  }

  /** Una marca del tenant de la sesión: no hay procedimiento para crearlas, se siembra. */
  async function seedOwnBrand(id: string, slug: string): Promise<void> {
    await testDb.superuserClient.query(
      `INSERT INTO app.brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)`,
      [id, TENANT_ID, slug, slug],
    );
  }

  async function createAccessory(slug: string, brandId?: string) {
    const category = await createCategory(`c08b-cat-${slug}`);
    return mutateOk<{ id: string; brandId: string | null }>("catalog.product.create", {
      kind: "accessory",
      slug,
      name: slug,
      ...(brandId ? { brandId } : {}),
      categoryIds: [category.id],
      primaryCategoryId: category.id,
      accessoryDetails: { material: null, color: null, sizeLabel: null },
    });
  }

  it("docs/api-conventions.md §8.4 · crear un producto con la marca de otro tenant da 404 y no lo crea", async () => {
    await seedForeignCatalog();
    const category = await createCategory("c08b-cat-marca-ajena");

    const response = await mutate("catalog.product.create", {
      kind: "accessory",
      slug: "c08b-marca-ajena",
      name: "Con marca ajena",
      brandId: FOREIGN_BRAND_ID,
      categoryIds: [category.id],
      primaryCategoryId: category.id,
      accessoryDetails: { material: null, color: null, sizeLabel: null },
    });

    expect(response.statusCode).toBe(404);
    const page = await call<{ items: { slug: string }[] }>("catalog.product.list", {
      kind: "accessory",
      limit: 100,
    });
    expect(page.items.map((item) => item.slug)).not.toContain("c08b-marca-ajena");
  });

  it("docs/api-conventions.md §8.4 · una marca inexistente da exactamente la misma respuesta que una ajena", async () => {
    await seedForeignCatalog();
    const category = await createCategory("c08b-cat-marca-inexistente");
    const create = (slug: string, brandId: string) =>
      mutate("catalog.product.create", {
        kind: "accessory",
        slug,
        name: slug,
        brandId,
        categoryIds: [category.id],
        primaryCategoryId: category.id,
        accessoryDetails: { material: null, color: null, sizeLabel: null },
      });

    const foreign = await create("c08b-marca-ajena-2", FOREIGN_BRAND_ID);
    const unknown = await create("c08b-marca-inexistente", UNKNOWN_ID);

    // Mismo estado, mismo código y mismo mensaje: nada que revele si el id existe en otro tenant.
    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(foreign.json().error.data.appCode).toBe("NOT_FOUND");
    expect(unknown.json().error.data.appCode).toBe("NOT_FOUND");
    expect(foreign.json().error.message).toBe("No encontrado.");
    expect(unknown.json().error.message).toBe("No encontrado.");
    expect(foreign.json().error.data.details).toBeUndefined();
    expect(unknown.json().error.data.details).toBeUndefined();
  });

  it("docs/api-conventions.md §8.4 · actualizar un producto con la marca de otro tenant da 404 y conserva la suya", async () => {
    await seedForeignCatalog();
    const ownBrandId = "66666666-6666-4666-a666-6666666666b1";
    await seedOwnBrand(ownBrandId, "c08b-marca-propia-a");
    const product = await createAccessory("c08b-conserva-marca", ownBrandId);

    const response = await mutate("catalog.product.update", {
      id: product.id,
      brandId: FOREIGN_BRAND_ID,
    });

    expect(response.statusCode).toBe(404);
    const fetched = await call<{ brandId: string | null }>("catalog.product.byId", {
      id: product.id,
    });
    expect(fetched.brandId).toBe(ownBrandId);
  });

  it("docs/api-conventions.md §8.4 · una marca propia se acepta al crear y al actualizar, y null la quita", async () => {
    const firstBrandId = "66666666-6666-4666-a666-6666666666b2";
    const secondBrandId = "66666666-6666-4666-a666-6666666666b3";
    await seedOwnBrand(firstBrandId, "c08b-marca-propia-b");
    await seedOwnBrand(secondBrandId, "c08b-marca-propia-c");

    const product = await createAccessory("c08b-marca-propia", firstBrandId);
    const moved = await mutateOk<{ brandId: string | null }>("catalog.product.update", {
      id: product.id,
      brandId: secondBrandId,
    });
    const cleared = await mutateOk<{ brandId: string | null }>("catalog.product.update", {
      id: product.id,
      brandId: null,
    });

    expect(product.brandId).toBe(firstBrandId);
    expect(moved.brandId).toBe(secondBrandId);
    expect(cleared.brandId).toBeNull();
  });

  it("docs/api-conventions.md §8.4 · crear una variante con el granel de otro tenant como origen da 404 y no la crea", async () => {
    await seedForeignCatalog();
    const product = await createAccessory("c08b-variante-origen-ajeno");

    const response = await mutate("catalog.variant.create", {
      productId: product.id,
      sku: "C08B-ORIGEN-AJENO",
      variantType: "decant",
      uom: "ml",
      sizeMl: 10,
      pricePyg: "285000",
      productionMode: "made_to_order",
      sourceVariantId: FOREIGN_VARIANT_ID,
    });

    expect(response.statusCode).toBe(404);
    const variants = await call<{ sku: string }[]>("catalog.variant.list", {
      productId: product.id,
    });
    expect(variants).toEqual([]);
  });

  it("docs/api-conventions.md §8.4 · actualizar el origen de una variante con un granel de otro tenant da 404 y conserva el suyo", async () => {
    await seedForeignCatalog();
    const product = await createAccessory("c08b-variante-conserva-origen");
    const bulk = await mutateOk<{ id: string }>("catalog.variant.create", {
      productId: product.id,
      sku: "C08B-GRANEL-PROPIO",
      variantType: "bulk",
      uom: "ml",
      sizeMl: null,
      pricePyg: "0",
    });
    const decant = await mutateOk<{ id: string }>("catalog.variant.create", {
      productId: product.id,
      sku: "C08B-DECANT",
      variantType: "decant",
      uom: "ml",
      sizeMl: 10,
      pricePyg: "285000",
      productionMode: "made_to_order",
      sourceVariantId: bulk.id,
    });

    const foreign = await mutate("catalog.variant.update", {
      id: decant.id,
      sourceVariantId: FOREIGN_VARIANT_ID,
    });
    const unknown = await mutate("catalog.variant.update", {
      id: decant.id,
      sourceVariantId: UNKNOWN_ID,
    });

    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(foreign.json().error.data.appCode).toBe("NOT_FOUND");
    expect(unknown.json().error.data.appCode).toBe("NOT_FOUND");
    expect(foreign.json().error.message).toBe("No encontrado.");
    expect(unknown.json().error.message).toBe("No encontrado.");
    expect(foreign.json().error.data.details).toBeUndefined();
    expect(unknown.json().error.data.details).toBeUndefined();
    const fetched = await call<{ sourceVariantId: string | null }>("catalog.variant.byId", {
      id: decant.id,
    });
    expect(fetched.sourceVariantId).toBe(bulk.id);
  });

  it("docs/api-conventions.md §8.4 · actualizar el origen de una variante con otra variante propia se acepta, y null lo quita", async () => {
    const product = await createAccessory("c08b-variante-origen-propio");
    const firstSource = await mutateOk<{ id: string }>("catalog.variant.create", {
      productId: product.id,
      sku: "C08B-ORIGEN-1",
      variantType: "bulk",
      uom: "ml",
      sizeMl: null,
      pricePyg: "0",
    });
    // Un insumo y no un segundo granel: el índice único de 0028 permite un solo granel por
    // producto. Qué variantes valen como origen es la pregunta abierta de WP-C08m; si se
    // restringe a `bulk`, esta prueba se reescribe sin que haya una regresión.
    const secondSource = await mutateOk<{ id: string }>("catalog.variant.create", {
      productId: product.id,
      sku: "C08B-ORIGEN-2",
      variantType: "supply",
      uom: "unit",
      sizeMl: null,
      pricePyg: "0",
    });
    const decant = await mutateOk<{ id: string }>("catalog.variant.create", {
      productId: product.id,
      sku: "C08B-DECANT-PROPIO",
      variantType: "decant",
      uom: "ml",
      sizeMl: 10,
      pricePyg: "285000",
      productionMode: "made_to_order",
      sourceVariantId: firstSource.id,
    });

    const moved = await mutateOk<{ sourceVariantId: string | null }>("catalog.variant.update", {
      id: decant.id,
      sourceVariantId: secondSource.id,
    });
    const cleared = await mutateOk<{ sourceVariantId: string | null; productionMode: string }>(
      "catalog.variant.update",
      { id: decant.id, productionMode: "stocked", sourceVariantId: null },
    );

    expect(moved.sourceVariantId).toBe(secondSource.id);
    expect(cleared.sourceVariantId).toBeNull();
    expect(cleared.productionMode).toBe("stocked");
  });

  // -------------------------------------------------------------------
  // WP-C08g · RF-CAT-09, RN-CAT-03. Publicar y despublicar mueven `published_at`
  // con independencia del `status`; mostrar u ocultar una variante mueve
  // `online_visible`. Solo con `catalog.product:publish`. La tienda ve un
  // producto cuando está `active` Y publicado, y de él solo las variantes
  // visibles (public.v_catalog_*). Activar un borrador tiene procedimiento propio
  // desde WP-C08e (`catalog.product.activate`); estas pruebas lo hacen por SQL para
  // no depender de él.
  // -------------------------------------------------------------------
  const PUBLISH_CLOCK_ISO = "2026-01-01T12:00:00.000Z";

  /** Entra como otro usuario de personal y deja su sesión con el segundo factor satisfecho (mismo criterio que el `beforeEach`). */
  async function loginPastMfa(email: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/trpc/auth.session.login",
      payload: { email, password: STAFF_PASSWORD },
    });
    const userCookie = toRequestCookie(response.headers["set-cookie"]);
    await testDb.superuserClient.query(
      `UPDATE app.staff_sessions SET mfa_verified_at = now()
       WHERE id = (
         SELECT s.id FROM app.staff_sessions s
         JOIN app.staff_users u ON u.id = s.staff_user_id
         WHERE u.email = $1 AND s.revoked_at IS NULL
         ORDER BY s.created_at DESC LIMIT 1
       )`,
      [email],
    );
    await redis.flushall();
    return userCookie;
  }

  async function mutateAs(userCookie: string, procedure: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/trpc/${procedure}`,
      headers: { cookie: userCookie },
      payload,
    });
  }

  async function activate(productId: string): Promise<void> {
    await testDb.superuserClient.query(`UPDATE app.products SET status = 'active' WHERE id = $1`, [
      productId,
    ]);
  }

  /**
   * WP-C08n, RN-CAT-03: publicar exige una variante visible con precio mayor que cero. Un
   * accesorio con una variante en unidades de Gs. 100.000, ya mostrada, y sin imagen.
   */
  async function createPublishableAccessory(slug: string) {
    const product = await createAccessory(slug);
    const variant = await mutateOk<{ id: string }>(
      "catalog.variant.create",
      unitVariantPayload(product.id, `${slug}-v`.toUpperCase(), { pricePyg: "100000" }),
    );
    await mutateOk("catalog.variant.setVisibility", { id: variant.id, onlineVisible: true });
    return product;
  }

  /** Marca el producto como publicado por SQL, sin pasar por lo que exige publicar: para las pruebas donde la publicación es solo el escenario. */
  async function markPublished(productId: string): Promise<void> {
    await testDb.superuserClient.query(
      `UPDATE app.products SET published_at = '2025-06-15T10:00:00Z' WHERE id = $1`,
      [productId],
    );
  }

  async function publicProductSlugs(): Promise<string[]> {
    const rows = await testDb.superuserClient.query(
      `SELECT slug FROM public.v_catalog_products WHERE tenant_id = $1`,
      [TENANT_ID],
    );
    return rows.rows.map((row: { slug: string }) => row.slug);
  }

  async function publicVariantSkus(): Promise<string[]> {
    const rows = await testDb.superuserClient.query(
      `SELECT sku FROM public.v_catalog_variants WHERE tenant_id = $1`,
      [TENANT_ID],
    );
    return rows.rows.map((row: { sku: string }) => row.sku);
  }

  async function auditActions(entityId: string): Promise<string[]> {
    const rows = await testDb.superuserClient.query(
      `SELECT action FROM app.audit_log WHERE entity_id = $1 ORDER BY occurred_at, id`,
      [entityId],
    );
    return rows.rows.map((row: { action: string }) => row.action);
  }

  it("RF-CAT-09 · publicar estampa published_at con el reloj y no toca el estado interno", async () => {
    const product = await createPublishableAccessory("c08g-publica");

    const published = await mutateOk<{ status: string; publishedAt: string | null }>(
      "catalog.product.publish",
      { id: product.id },
    );

    expect(published.publishedAt).toBe(PUBLISH_CLOCK_ISO);
    expect(published.status).toBe("draft");
  });

  it("RF-CAT-09 · publicar un borrador no lo muestra en la tienda: hacen falta el estado activo y la publicación", async () => {
    const product = await createPublishableAccessory("c08g-borrador");
    await mutateOk("catalog.product.publish", { id: product.id });
    const whileDraft = await publicProductSlugs();

    await activate(product.id);
    const whileActive = await publicProductSlugs();
    await mutateOk("catalog.product.unpublish", { id: product.id });
    const afterUnpublish = await publicProductSlugs();

    expect(whileDraft).not.toContain("c08g-borrador");
    expect(whileActive).toContain("c08g-borrador");
    expect(afterUnpublish).not.toContain("c08g-borrador");
  });

  it("RF-CAT-09 · despublicar deja published_at en nulo y el producto activo; hacerlo dos veces no cambia nada", async () => {
    const product = await createPublishableAccessory("c08g-despublica");
    await activate(product.id);
    await mutateOk("catalog.product.publish", { id: product.id });

    const first = await mutateOk<{ status: string; publishedAt: string | null }>(
      "catalog.product.unpublish",
      { id: product.id },
    );
    const second = await mutateOk<{ status: string; publishedAt: string | null }>(
      "catalog.product.unpublish",
      { id: product.id },
    );

    expect(first).toMatchObject({ status: "active", publishedAt: null });
    expect(second).toMatchObject({ status: "active", publishedAt: null });
    expect(await auditActions(product.id)).toEqual([
      "catalog.product.publish",
      "catalog.product.unpublish",
    ]);
  });

  it("RF-CAT-09 · despublicar no toca las variantes: siguen marcadas como visibles y reaparecen al volver a publicar", async () => {
    const product = await createAccessory("c08g-despublica-variantes");
    const variant = await mutateOk<{ id: string }>("catalog.variant.create", {
      productId: product.id,
      sku: "C08G-DESPUBLICA",
      variantType: "unit",
      uom: "unit",
      sizeMl: null,
      pricePyg: "100000",
    });
    await activate(product.id);
    await mutateOk("catalog.variant.setVisibility", { id: variant.id, onlineVisible: true });
    await mutateOk("catalog.product.publish", { id: product.id });

    await mutateOk("catalog.product.unpublish", { id: product.id });
    const whileUnpublished = await publicVariantSkus();
    const variantsAfter = await call<{ onlineVisible: boolean }[]>("catalog.variant.list", {
      productId: product.id,
    });
    await mutateOk("catalog.product.publish", { id: product.id });
    const afterRepublish = await publicVariantSkus();

    expect(whileUnpublished).not.toContain("C08G-DESPUBLICA");
    expect(variantsAfter.map((item) => item.onlineVisible)).toEqual([true]);
    expect(afterRepublish).toContain("C08G-DESPUBLICA");
  });

  it("RF-CAT-09 · si otro pedido publica el producto mientras éste espera, no le pisa la fecha ni deja otra entrada en la bitácora", async () => {
    const product = await createPublishableAccessory("c08g-publicacion-simultanea");

    // Otra transacción publica el producto y todavía no confirma. Una petición que
    // decidiera con lo que leyó antes (sin publicar) estamparía su propia hora al
    // desbloquearse y pisaría la del primero.
    await testDb.superuserClient.query("BEGIN");
    let released = false;
    let pending: ReturnType<typeof mutate> | undefined;
    try {
      await testDb.superuserClient.query(
        `UPDATE app.products SET published_at = '2025-06-15T10:00:00Z' WHERE id = $1`,
        [product.id],
      );
      pending = mutate("catalog.product.publish", { id: product.id });
      await waitUntilABackendIsBlockedOnALock();
      await testDb.superuserClient.query("COMMIT");
      released = true;
      const response = await pending;

      expect(response.statusCode).toBe(200);
      expect(response.json().result.data.publishedAt).toBe("2025-06-15T10:00:00.000Z");
    } finally {
      if (!released) {
        await testDb.superuserClient.query("ROLLBACK");
        await pending?.catch(() => undefined);
      }
    }
    expect(await auditActions(product.id)).toEqual([]);
  });

  it("RF-CAT-09 · si otro pedido despublica el producto mientras éste espera, no deja otra entrada en la bitácora", async () => {
    const product = await createAccessory("c08g-despublicacion-simultanea");
    await testDb.superuserClient.query(
      `UPDATE app.products SET published_at = '2025-06-15T10:00:00Z' WHERE id = $1`,
      [product.id],
    );

    // Otra transacción lo despublica y todavía no confirma. La petición leyó el producto
    // publicado, pero al desbloquearse ya no hay nada que despublicar.
    await testDb.superuserClient.query("BEGIN");
    let released = false;
    let pending: ReturnType<typeof mutate> | undefined;
    try {
      await testDb.superuserClient.query(
        `UPDATE app.products SET published_at = NULL WHERE id = $1`,
        [product.id],
      );
      pending = mutate("catalog.product.unpublish", { id: product.id });
      await waitUntilABackendIsBlockedOnALock();
      await testDb.superuserClient.query("COMMIT");
      released = true;

      expect((await pending).statusCode).toBe(200);
    } finally {
      if (!released) {
        await testDb.superuserClient.query("ROLLBACK");
        await pending?.catch(() => undefined);
      }
    }
    expect(await auditActions(product.id)).toEqual([]);
  });

  it("RF-CAT-09 · si otro pedido ya mostró la variante mientras éste espera, no deja otra entrada en la bitácora", async () => {
    const product = await createAccessory("c08g-visibilidad-simultanea");
    const variant = await mutateOk<{ id: string }>("catalog.variant.create", {
      productId: product.id,
      sku: "C08G-SIMULTANEA",
      variantType: "unit",
      uom: "unit",
      sizeMl: null,
      pricePyg: "100000",
    });

    await testDb.superuserClient.query("BEGIN");
    let released = false;
    let pending: ReturnType<typeof mutate> | undefined;
    try {
      await testDb.superuserClient.query(
        `UPDATE app.product_variants SET online_visible = true WHERE id = $1`,
        [variant.id],
      );
      pending = mutate("catalog.variant.setVisibility", { id: variant.id, onlineVisible: true });
      await waitUntilABackendIsBlockedOnALock();
      await testDb.superuserClient.query("COMMIT");
      released = true;

      expect((await pending).statusCode).toBe(200);
    } finally {
      if (!released) {
        await testDb.superuserClient.query("ROLLBACK");
        await pending?.catch(() => undefined);
      }
    }
    expect(await auditActions(variant.id)).toEqual([]);
  });

  it("RF-CAT-09 · publicar un producto ya publicado conserva la fecha original y no deja otra entrada en la bitácora", async () => {
    const product = await createAccessory("c08g-ya-publicado");
    await testDb.superuserClient.query(
      `UPDATE app.products SET published_at = '2025-06-15T10:00:00Z' WHERE id = $1`,
      [product.id],
    );

    const again = await mutateOk<{ publishedAt: string | null }>("catalog.product.publish", {
      id: product.id,
    });

    expect(again.publishedAt).toBe("2025-06-15T10:00:00.000Z");
    expect(await auditActions(product.id)).toEqual([]);
  });

  it("RF-CAT-09 · publicar deja en la bitácora quién, qué y el antes y el después", async () => {
    const product = await createPublishableAccessory("c08g-bitacora");

    await mutateOk("catalog.product.publish", { id: product.id });

    const rows = await testDb.superuserClient.query(
      `SELECT action, entity, actor_id, before, after FROM app.audit_log WHERE entity_id = $1`,
      [product.id],
    );
    expect(rows.rows).toEqual([
      {
        action: "catalog.product.publish",
        entity: "products",
        actor_id: STAFF_OWNER_ID,
        before: { publishedAt: null },
        after: { publishedAt: PUBLISH_CLOCK_ISO },
      },
    ]);
  });

  it("caso borde 17 · un producto sin categoría primaria no se publica", async () => {
    const product = await createAccessory("c08g-sin-primaria");
    await testDb.superuserClient.query(`DELETE FROM app.product_categories WHERE product_id = $1`, [
      product.id,
    ]);

    const response = await mutate("catalog.product.publish", { id: product.id });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.data.appCode).toBe("CONFLICT_PRODUCT_WITHOUT_PRIMARY_CATEGORY");
    const fetched = await call<{ publishedAt: string | null }>("catalog.product.byId", {
      id: product.id,
    });
    expect(fetched.publishedAt).toBeNull();
    expect(await auditActions(product.id)).toEqual([]);
  });

  it("caso borde 17 · un producto con categorías pero ninguna primaria tampoco se publica", async () => {
    const product = await createAccessory("c08g-ninguna-primaria");
    await testDb.superuserClient.query(
      `UPDATE app.product_categories SET is_primary = false WHERE product_id = $1`,
      [product.id],
    );

    const response = await mutate("catalog.product.publish", { id: product.id });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.data.appCode).toBe("CONFLICT_PRODUCT_WITHOUT_PRIMARY_CATEGORY");
  });

  // WP-C08n, RN-CAT-03 (decisión de José, 2026-10-12). Publicar exige un producto no
  // archivado y al menos una variante `online_visible` con `price_pyg` mayor que cero, las
  // dos condiciones en la misma variante. La imagen no es obligatoria.
  it("RN-CAT-03 · un producto sin variantes no se publica: 409 y sigue sin publicar", async () => {
    const product = await createAccessory("c08n-sin-variantes");

    const response = await mutate("catalog.product.publish", { id: product.id });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.data.appCode).toBe("CONFLICT_PRODUCT_WITHOUT_SELLABLE_VARIANT");
    const fetched = await call<{ publishedAt: string | null }>("catalog.product.byId", {
      id: product.id,
    });
    expect(fetched.publishedAt).toBeNull();
    expect(await auditActions(product.id)).toEqual([]);
  });

  it("RN-CAT-03 · una variante visible sin precio y otra con precio pero oculta no alcanzan: tiene que ser la misma variante; con una que cumple las dos, se publica sin imagen", async () => {
    const product = await createAccessory("c08n-no-misma-variante");
    const free = await mutateOk<{ id: string }>(
      "catalog.variant.create",
      unitVariantPayload(product.id, "C08N-GRATIS", { pricePyg: "0" }),
    );
    const priced = await mutateOk<{ id: string }>(
      "catalog.variant.create",
      unitVariantPayload(product.id, "C08N-CON-PRECIO", { pricePyg: "100000" }),
    );
    await mutateOk("catalog.variant.setVisibility", { id: free.id, onlineVisible: true });

    const rejected = await mutate("catalog.product.publish", { id: product.id });
    await mutateOk("catalog.variant.setVisibility", { id: priced.id, onlineVisible: true });
    const published = await mutateOk<{ publishedAt: string | null }>("catalog.product.publish", {
      id: product.id,
    });

    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.data.appCode).toBe("CONFLICT_PRODUCT_WITHOUT_SELLABLE_VARIANT");
    expect(published.publishedAt).toBe(PUBLISH_CLOCK_ISO);
  });

  it("RN-CAT-03 · un borrador y un activo con una variante visible con precio se publican", async () => {
    const draft = await createPublishableAccessory("c08n-borrador-ok");
    const active = await createPublishableAccessory("c08n-activo-ok");
    await activate(active.id);

    const draftResult = await mutateOk<{ publishedAt: string | null; status: string }>(
      "catalog.product.publish",
      { id: draft.id },
    );
    const activeResult = await mutateOk<{ publishedAt: string | null; status: string }>(
      "catalog.product.publish",
      { id: active.id },
    );

    expect(draftResult).toMatchObject({ publishedAt: PUBLISH_CLOCK_ISO, status: "draft" });
    expect(activeResult).toMatchObject({ publishedAt: PUBLISH_CLOCK_ISO, status: "active" });
  });

  it("RN-CAT-03 · un producto archivado no se publica, ni siquiera si conservó published_at: 409 y la fecha no cambia", async () => {
    const neverPublished = await createPublishableAccessory("c08n-archivado");
    const wasPublished = await createPublishableAccessory("c08n-archivado-publicado");
    await mutateOk("catalog.product.publish", { id: wasPublished.id });
    await mutateOk("catalog.product.archive", { id: neverPublished.id });
    await mutateOk("catalog.product.archive", { id: wasPublished.id });

    const first = await mutate("catalog.product.publish", { id: neverPublished.id });
    const second = await mutate("catalog.product.publish", { id: wasPublished.id });

    for (const response of [first, second]) {
      expect(response.statusCode).toBe(409);
      expect(response.json().error.data.appCode).toBe("CONFLICT_PRODUCT_ARCHIVED");
    }
    const never = await call<{ publishedAt: string | null }>("catalog.product.byId", {
      id: neverPublished.id,
    });
    const was = await call<{ publishedAt: string | null }>("catalog.product.byId", {
      id: wasPublished.id,
    });
    expect(never.publishedAt).toBeNull();
    expect(was.publishedAt).toBe(PUBLISH_CLOCK_ISO);
    expect(await auditActions(neverPublished.id)).toEqual([]);
  });

  it(
    "RN-CAT-03 · si otro pedido archiva el producto mientras la publicación espera, se rechaza como archivado y no queda publicado",
    async () => {
      const product = await createPublishableAccessory("c08n-archivado-en-vuelo");

      // Otra transacción lo archiva y todavía no confirma: la lectura de quien publica ve
      // el producto sin archivar, y su escritura espera la fila.
      const response = await whileHolding(
        () =>
          testDb.superuserClient.query(
            `UPDATE app.products SET status = 'archived' WHERE id = $1`,
            [product.id],
          ),
        () => mutate("catalog.product.publish", { id: product.id }),
      );

      expect(response.statusCode).toBe(409);
      expect(response.json().error.data.appCode).toBe("CONFLICT_PRODUCT_ARCHIVED");
      const fetched = await call<{ publishedAt: string | null }>("catalog.product.byId", {
        id: product.id,
      });
      expect(fetched.publishedAt).toBeNull();
      expect(await auditActions(product.id)).toEqual([]);
    },
    RACE_TEST_TIMEOUT_MS,
  );

  it("RF-CAT-09 · un producto o una variante inexistente o de otro tenant da exactamente la misma respuesta, al publicar, despublicar y mostrar", async () => {
    await seedForeignCatalog();

    const responses = [
      await mutate("catalog.product.publish", { id: FOREIGN_PRODUCT_ID }),
      await mutate("catalog.product.publish", { id: UNKNOWN_ID }),
      await mutate("catalog.product.unpublish", { id: FOREIGN_PRODUCT_ID }),
      await mutate("catalog.product.unpublish", { id: UNKNOWN_ID }),
      await mutate("catalog.variant.setVisibility", {
        id: FOREIGN_VARIANT_ID,
        onlineVisible: true,
      }),
      await mutate("catalog.variant.setVisibility", { id: UNKNOWN_ID, onlineVisible: true }),
    ];

    expect(responses.map((response) => response.statusCode)).toEqual([
      404, 404, 404, 404, 404, 404,
    ]);
    expect(responses.map((response) => response.json().error.data.appCode)).toEqual(
      Array(6).fill("NOT_FOUND"),
    );
    expect(responses.map((response) => response.json().error.message)).toEqual(
      Array(6).fill("No encontrado."),
    );
    expect(responses.map((response) => response.json().error.data.details)).toEqual(
      Array(6).fill(undefined),
    );
  });

  it("RF-CAT-09 · quien tiene catalog.product:write sin publish no puede publicar, despublicar ni mostrar una variante", async () => {
    const product = await createAccessory("c08g-sin-permiso");
    const variant = await mutateOk<{ id: string }>("catalog.variant.create", {
      productId: product.id,
      sku: "C08G-SIN-PERMISO",
      variantType: "unit",
      uom: "unit",
      sizeMl: null,
      pricePyg: "100000",
    });
    const writerCookie = await loginPastMfa(STAFF_WRITER_EMAIL);

    const publish = await mutateAs(writerCookie, "catalog.product.publish", { id: product.id });
    const unpublish = await mutateAs(writerCookie, "catalog.product.unpublish", {
      id: product.id,
    });
    const show = await mutateAs(writerCookie, "catalog.variant.setVisibility", {
      id: variant.id,
      onlineVisible: true,
    });

    expect(publish.statusCode).toBe(403);
    expect(unpublish.statusCode).toBe(403);
    expect(show.statusCode).toBe(403);
    const fetched = await call<{ publishedAt: string | null }>("catalog.product.byId", {
      id: product.id,
    });
    expect(fetched.publishedAt).toBeNull();
    const variants = await call<{ onlineVisible: boolean }[]>("catalog.variant.list", {
      productId: product.id,
    });
    expect(variants.map((item) => item.onlineVisible)).toEqual([false]);
  });

  it("RF-CAT-09 · editar con catalog.product:write no puede colar published_at, status ni online_visible", async () => {
    const product = await createAccessory("c08g-no-cuela");
    const variant = await mutateOk<{ id: string }>("catalog.variant.create", {
      productId: product.id,
      sku: "C08G-NO-CUELA",
      variantType: "unit",
      uom: "unit",
      sizeMl: null,
      pricePyg: "100000",
    });
    const writerCookie = await loginPastMfa(STAFF_WRITER_EMAIL);

    const productUpdate = await mutateAs(writerCookie, "catalog.product.update", {
      id: product.id,
      publishedAt: PUBLISH_CLOCK_ISO,
    });
    const statusUpdate = await mutateAs(writerCookie, "catalog.product.update", {
      id: product.id,
      status: "active",
    });
    const variantUpdate = await mutateAs(writerCookie, "catalog.variant.update", {
      id: variant.id,
      onlineVisible: true,
    });

    expect(productUpdate.statusCode).toBe(400);
    expect(statusUpdate.statusCode).toBe(400);
    expect(variantUpdate.statusCode).toBe(400);
  });

  it("RF-CAT-09 · mostrar una variante vendible la deja visible en la tienda; ocultarla la saca, y repetirlo no cambia nada", async () => {
    const product = await createAccessory("c08g-variante-visible");
    const variant = await mutateOk<{ id: string; sku: string }>("catalog.variant.create", {
      productId: product.id,
      sku: "C08G-VISIBLE",
      variantType: "unit",
      uom: "unit",
      sizeMl: null,
      pricePyg: "100000",
    });
    await activate(product.id);
    await markPublished(product.id);
    const beforeShow = await publicVariantSkus();

    const shown = await mutateOk<{ onlineVisible: boolean }>("catalog.variant.setVisibility", {
      id: variant.id,
      onlineVisible: true,
    });
    const shownAgain = await mutateOk<{ onlineVisible: boolean }>("catalog.variant.setVisibility", {
      id: variant.id,
      onlineVisible: true,
    });
    const afterShow = await publicVariantSkus();
    const hidden = await mutateOk<{ onlineVisible: boolean }>("catalog.variant.setVisibility", {
      id: variant.id,
      onlineVisible: false,
    });
    const afterHide = await publicVariantSkus();

    expect(shown.onlineVisible).toBe(true);
    expect(shownAgain.onlineVisible).toBe(true);
    expect(hidden.onlineVisible).toBe(false);
    expect(beforeShow).not.toContain("C08G-VISIBLE");
    expect(afterShow).toContain("C08G-VISIBLE");
    expect(afterHide).not.toContain("C08G-VISIBLE");
    expect(await auditActions(variant.id)).toEqual([
      "catalog.variant.setVisibility",
      "catalog.variant.setVisibility",
    ]);
  });

  it("RN-CAT-02 · una variante de granel, insumo o tester no se puede mostrar, ni con el permiso de publicar: 409 en español, no un error interno", async () => {
    const product = await createAccessory("c08g-no-vendibles");
    const make = (sku: string, variantType: string, uom: string, sizeMl: number | null) =>
      mutateOk<{ id: string }>("catalog.variant.create", {
        productId: product.id,
        sku,
        variantType,
        uom,
        sizeMl,
        pricePyg: "0",
      });
    const bulk = await make("C08G-GRANEL", "bulk", "ml", null);
    const supply = await make("C08G-INSUMO", "supply", "unit", null);
    const tester = await make("C08G-TESTER", "tester", "unit", 100);

    const responses = [
      await mutate("catalog.variant.setVisibility", { id: bulk.id, onlineVisible: true }),
      await mutate("catalog.variant.setVisibility", { id: supply.id, onlineVisible: true }),
      await mutate("catalog.variant.setVisibility", { id: tester.id, onlineVisible: true }),
    ];

    expect(responses.map((response) => response.statusCode)).toEqual([409, 409, 409]);
    expect(responses.map((response) => response.json().error.data.appCode)).toEqual([
      "CONFLICT_VARIANT_NOT_PUBLISHABLE",
      "CONFLICT_VARIANT_NOT_PUBLISHABLE",
      "CONFLICT_VARIANT_NOT_PUBLISHABLE",
    ]);
    expect(responses[0]?.json().error.message).toBe(
      "Solo las variantes sellado, decant y unidad se pueden mostrar en la tienda.",
    );
    const variants = await call<{ onlineVisible: boolean }[]>("catalog.variant.list", {
      productId: product.id,
    });
    expect(variants.map((item) => item.onlineVisible)).toEqual([false, false, false]);
  });

  it("RF-CAT-09 · una variante inexistente o de otro tenant da 404 al mostrarla", async () => {
    await seedForeignCatalog();

    const foreign = await mutate("catalog.variant.setVisibility", {
      id: FOREIGN_VARIANT_ID,
      onlineVisible: true,
    });
    const unknown = await mutate("catalog.variant.setVisibility", {
      id: UNKNOWN_ID,
      onlineVisible: true,
    });

    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
  });

  // -------------------------------------------------------------------
  // WP-C08e · RN-CAT-04. `catalog.product.activate` pasa un borrador a activo.
  // Con `catalog.product:write` si el producto no está publicado; si ya tiene
  // `published_at`, hace falta además `catalog.product:publish`, porque
  // activarlo lo muestra en la tienda. `status` no viaja por `update`.
  // -------------------------------------------------------------------
  type ActivatedProduct = { status: string; publishedAt: string | null };

  it("RN-CAT-04 · activar un borrador lo pasa a activo, deja la entrada en la bitácora y no lo publica", async () => {
    const product = await createAccessory("c08e-activa");

    const activated = await mutateOk<ActivatedProduct>("catalog.product.activate", {
      id: product.id,
    });

    expect(activated).toMatchObject({ status: "active", publishedAt: null });
    expect(await auditActions(product.id)).toEqual(["catalog.product.activate"]);
    expect(await publicProductSlugs()).not.toContain("c08e-activa");
  });

  it("RN-CAT-04 · quien tiene write sin publish puede activar un producto que no está publicado", async () => {
    const product = await createAccessory("c08e-activa-escritor");
    const writerCookie = await loginPastMfa(STAFF_WRITER_EMAIL);

    const response = await mutateAs(writerCookie, "catalog.product.activate", { id: product.id });

    expect(response.statusCode).toBe(200);
    expect(response.json().result.data.status).toBe("active");
  });

  it("RN-CAT-04 · quien tiene write sin publish no puede activar un producto que ya tiene published_at; con publish sí, y recién ahí la tienda lo ve", async () => {
    const product = await createAccessory("c08e-ya-publicado");
    await markPublished(product.id);
    const writerCookie = await loginPastMfa(STAFF_WRITER_EMAIL);

    const denied = await mutateAs(writerCookie, "catalog.product.activate", { id: product.id });
    const stillDraft = await call<ActivatedProduct>("catalog.product.byId", { id: product.id });
    const visibleBefore = await publicProductSlugs();
    const allowed = await mutateOk<ActivatedProduct>("catalog.product.activate", {
      id: product.id,
    });
    const visibleAfter = await publicProductSlugs();

    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.data.appCode).toBe("FORBIDDEN_INSUFFICIENT_PERMISSION");
    expect(stillDraft.status).toBe("draft");
    expect(visibleBefore).not.toContain("c08e-ya-publicado");
    expect(allowed.status).toBe("active");
    expect(visibleAfter).toContain("c08e-ya-publicado");
  });

  // WP-C08k, RN-CAT-05. Mostrar u ocultar una categoría es publicar: `isVisible` exige
  // `catalog.product:publish`; renombrar, mover y reordenar siguen en `write`.
  type CategoryState = { id: string; name: string; path: string; isVisible: boolean };
  async function categoryState(id: string): Promise<CategoryState> {
    const result = await testDb.superuserClient.query<{
      id: string;
      name: string;
      path: string;
      is_visible: boolean;
    }>(`SELECT id, name, path, is_visible FROM app.categories WHERE id = $1`, [id]);
    const row = result.rows[0]!;
    return { id: row.id, name: row.name, path: row.path, isVisible: row.is_visible };
  }

  it("RN-CAT-05 · quien tiene write sin publish renombra, mueve y reordena una categoría; con el mismo isVisible que ya tiene no pide publish", async () => {
    const parent = await createCategory("c08k-padre");
    const other = await createCategory("c08k-otro-padre");
    const child = await createCategory("c08k-hija", parent.id);
    const writerCookie = await loginPastMfa(STAFF_WRITER_EMAIL);

    const renamed = await mutateAs(writerCookie, "catalog.category.update", {
      id: parent.id,
      name: "Padre renombrado",
    });
    const moved = await mutateAs(writerCookie, "catalog.category.update", {
      id: child.id,
      parentId: other.id,
    });
    const reordered = await mutateAs(writerCookie, "catalog.category.update", {
      id: other.id,
      position: 7,
    });
    const sameVisibility = await mutateAs(writerCookie, "catalog.category.update", {
      id: parent.id,
      name: "Padre, misma visibilidad",
      isVisible: true,
    });

    expect([renamed, moved, reordered, sameVisibility].map((r) => r.statusCode)).toEqual([
      200, 200, 200, 200,
    ]);
    expect(await categoryState(parent.id)).toMatchObject({
      name: "Padre, misma visibilidad",
      isVisible: true,
    });
    expect((await categoryState(child.id)).path).toBe("c08k-otro-padre/c08k-hija");
  });

  it("RN-CAT-05 · quien tiene write sin publish no puede ocultar ni mostrar una categoría: 403 y no cambia nada de lo que venía en el pedido", async () => {
    const parent = await createCategory("c08k-bloq-padre");
    const other = await createCategory("c08k-bloq-otro");
    const child = await createCategory("c08k-bloq-hija", parent.id);
    const hidden = await createCategory("c08k-bloq-oculta");
    await mutateOk("catalog.category.update", { id: hidden.id, isVisible: false });
    const writerCookie = await loginPastMfa(STAFF_WRITER_EMAIL);

    const hide = await mutateAs(writerCookie, "catalog.category.update", {
      id: parent.id,
      isVisible: false,
    });
    const show = await mutateAs(writerCookie, "catalog.category.update", {
      id: hidden.id,
      isVisible: true,
    });
    // Un pedido que mezcla lo permitido con lo que no lo es no cambia ninguna de las dos cosas.
    const renameAndHide = await mutateAs(writerCookie, "catalog.category.update", {
      id: parent.id,
      name: "No debería quedar",
      isVisible: false,
    });
    const moveAndHide = await mutateAs(writerCookie, "catalog.category.update", {
      id: child.id,
      parentId: other.id,
      isVisible: false,
    });

    for (const response of [hide, show, renameAndHide, moveAndHide]) {
      expect(response.statusCode).toBe(403);
      expect(response.json().error.data.appCode).toBe("FORBIDDEN_INSUFFICIENT_PERMISSION");
    }
    expect(await categoryState(parent.id)).toMatchObject({
      name: "c08k-bloq-padre",
      isVisible: true,
    });
    expect(await categoryState(hidden.id)).toMatchObject({ isVisible: false });
    expect(await categoryState(child.id)).toMatchObject({
      path: "c08k-bloq-padre/c08k-bloq-hija",
      isVisible: true,
    });
  });

  it("RN-CAT-05 · quien tiene publish muestra y oculta una categoría", async () => {
    const category = await createCategory("c08k-con-publish");

    const hidden = await mutateOk<{ isVisible: boolean }>("catalog.category.update", {
      id: category.id,
      isVisible: false,
    });
    const shown = await mutateOk<{ isVisible: boolean }>("catalog.category.update", {
      id: category.id,
      isVisible: true,
    });

    expect(hidden.isVisible).toBe(false);
    expect(shown.isVisible).toBe(true);
  });

  it(
    "RN-CAT-05 · si otro pedido oculta la categoría mientras la escritura de quien no puede publicar espera, esa escritura no la vuelve a mostrar",
    async () => {
      const category = await createCategory("c08k-carrera");
      const writerCookie = await loginPastMfa(STAFF_WRITER_EMAIL);

      // Otra transacción oculta la categoría y todavía no confirma. La lectura de quien
      // escribe todavía ve «visible» (el mismo valor que manda), así que el pedido está
      // permitido; su UPDATE espera la fila, y al desbloquearse no tiene que reescribir
      // `is_visible` con el valor viejo.
      const response = await whileHolding(
        () =>
          testDb.superuserClient.query(
            `UPDATE app.categories SET is_visible = false WHERE id = $1`,
            [category.id],
          ),
        () =>
          mutateAs(writerCookie, "catalog.category.update", {
            id: category.id,
            name: "Renombrada en la carrera",
            isVisible: true,
          }),
      );

      expect(response.statusCode).toBe(200);
      expect(await categoryState(category.id)).toMatchObject({
        name: "Renombrada en la carrera",
        isVisible: false,
      });
    },
    RACE_TEST_TIMEOUT_MS,
  );

  it("RN-CAT-04 · quien solo puede leer el catálogo no puede activar: 403 y el producto sigue en borrador", async () => {
    const product = await createAccessory("c08e-solo-lectura");
    const readerCookie = await loginPastMfa(STAFF_READER_EMAIL);

    const response = await mutateAs(readerCookie, "catalog.product.activate", { id: product.id });

    expect(response.statusCode).toBe(403);
    const fetched = await call<ActivatedProduct>("catalog.product.byId", { id: product.id });
    expect(fetched.status).toBe("draft");
  });

  it("RN-CAT-04 · activar un producto que ya está activo no hace nada ni deja otra entrada en la bitácora", async () => {
    const product = await createAccessory("c08e-ya-activo");
    await mutateOk("catalog.product.activate", { id: product.id });

    const again = await mutateOk<ActivatedProduct>("catalog.product.activate", { id: product.id });

    expect(again.status).toBe("active");
    expect(await auditActions(product.id)).toEqual(["catalog.product.activate"]);
  });

  it("RN-CAT-04 · un producto archivado no se activa: 409 y sigue archivado", async () => {
    const product = await createAccessory("c08e-archivado");
    await mutateOk("catalog.product.archive", { id: product.id });

    const response = await mutate("catalog.product.activate", { id: product.id });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.data.appCode).toBe("CONFLICT_PRODUCT_ARCHIVED");
    const fetched = await call<ActivatedProduct>("catalog.product.byId", { id: product.id });
    expect(fetched.status).toBe("archived");
  });

  it("RN-CAT-04 · un producto inexistente o de otro tenant da exactamente la misma respuesta", async () => {
    await seedForeignCatalog();

    const foreign = await mutate("catalog.product.activate", { id: FOREIGN_PRODUCT_ID });
    const unknown = await mutate("catalog.product.activate", { id: UNKNOWN_ID });

    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(foreign.json().error.data.appCode).toBe("NOT_FOUND");
    expect(unknown.json().error.data.appCode).toBe("NOT_FOUND");
    expect(foreign.json().error.message).toBe("No encontrado.");
    expect(unknown.json().error.message).toBe("No encontrado.");
  });

  it("RN-CAT-04 · si otro pedido publica el producto mientras quien no puede publicar lo activa, no se activa", async () => {
    const product = await createAccessory("c08e-publicado-en-vuelo");
    const writerCookie = await loginPastMfa(STAFF_WRITER_EMAIL);

    // Otra transacción publica el producto y todavía no confirma. La petición se queda
    // esperando la fila; al desbloquearse el producto ya está publicado, y activarlo lo
    // mostraría en la tienda sin que esa persona tenga permiso para eso.
    await testDb.superuserClient.query("BEGIN");
    let released = false;
    let pending: ReturnType<typeof mutateAs> | undefined;
    try {
      await testDb.superuserClient.query(
        `UPDATE app.products SET published_at = '2025-06-15T10:00:00Z' WHERE id = $1`,
        [product.id],
      );
      pending = mutateAs(writerCookie, "catalog.product.activate", { id: product.id });
      await waitUntilABackendIsBlockedOnALock();
      await testDb.superuserClient.query("COMMIT");
      released = true;
      const response = await pending;

      expect(response.statusCode).toBe(403);
    } finally {
      if (!released) {
        await testDb.superuserClient.query("ROLLBACK");
        await pending?.catch(() => undefined);
      }
    }
    const fetched = await call<ActivatedProduct>("catalog.product.byId", { id: product.id });
    expect(fetched.status).toBe("draft");
    expect(await auditActions(product.id)).toEqual([]);
  });

  it("RN-CAT-04 · si otro pedido archiva el producto mientras éste espera, se rechaza como archivado", async () => {
    const product = await createAccessory("c08e-archivado-en-vuelo");

    await testDb.superuserClient.query("BEGIN");
    let released = false;
    let pending: ReturnType<typeof mutate> | undefined;
    try {
      await testDb.superuserClient.query(
        `UPDATE app.products SET status = 'archived' WHERE id = $1`,
        [product.id],
      );
      pending = mutate("catalog.product.activate", { id: product.id });
      await waitUntilABackendIsBlockedOnALock();
      await testDb.superuserClient.query("COMMIT");
      released = true;
      const response = await pending;

      expect(response.statusCode).toBe(409);
      expect(response.json().error.data.appCode).toBe("CONFLICT_PRODUCT_ARCHIVED");
    } finally {
      if (!released) {
        await testDb.superuserClient.query("ROLLBACK");
        await pending?.catch(() => undefined);
      }
    }
    expect(await auditActions(product.id)).toEqual([]);
  });
});
