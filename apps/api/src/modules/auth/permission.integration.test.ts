import { PrismaClient } from "@joda/db";
import type { Clock } from "@joda/domain";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeStaffAuthProvider } from "../../adapters/staffAuth/fakeStaffAuthProvider.js";
import { jodaApiConnectionUrl, startTestDb, type TestDb } from "../../db/testDb.js";
import { buildServer } from "../../index.js";
import type { AuthServiceDeps } from "./service.js";

// UUID v4 válidos de verdad — mismo criterio que auth.integration.test.ts
// (packages/contracts/src/shared/id.ts los valida en la salida de
// auth.session.login).
const TENANT_ID = "66666666-6666-4666-a666-666666666666";
const STAFF_PASSWORD = "correcta";
const MFA_ENCRYPTION_KEY = Buffer.from("0".repeat(64), "hex");
// El CHECK de staff_users solo exige NOT NULL cuando mfa_enrolled = true
// (packages/db/migrations/0013_staff_mfa.sql) — nunca se descifra en este
// archivo, porque el desafío TOTP se satisface a mano, directo en la base
// (ver `loginPastMfa` abajo), no a través de auth.mfa.verify: lo que este
// test ejercita es el middleware de permisos (WP-C05), no el segundo factor
// (ya cubierto por mfa.integration.test.ts, WP-C04).
const PLACEHOLDER_MFA_SECRET = "placeholder-nunca-se-descifra-en-este-test";

const STAFF_VENDEDOR_ID = "77777777-7777-4777-a777-777777777771";
const STAFF_VENDEDOR_EMAIL = "vendedor@jodaparfums.com";
const STAFF_SIN_ROL_ID = "77777777-7777-4777-a777-777777777772";
const STAFF_SIN_ROL_EMAIL = "sinrol@jodaparfums.com";
const STAFF_SOLO_ESCRITURA_ID = "77777777-7777-4777-a777-777777777773";
const STAFF_SOLO_ESCRITURA_EMAIL = "soloescritura@jodaparfums.com";
// Usuario APARTE para el test de caché de abajo: ese test revoca el rol a
// mitad de camino, un efecto permanente sobre `staff_user_roles` que no
// puede compartir usuario con "con el permiso exacto → 200" sin acoplar el
// resultado al ORDEN en que Vitest corre los `it()`.
const STAFF_CACHE_ID = "77777777-7777-4777-a777-777777777774";
const STAFF_CACHE_EMAIL = "cache@jodaparfums.com";

function createManualClock(initial: Date): Clock {
  return { now: () => initial };
}

function toRequestCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("se esperaba un header Set-Cookie en la respuesta");
  const separator = raw.indexOf(";");
  return separator === -1 ? raw : raw.slice(0, separator);
}

async function requiresPermission(app: FastifyInstance, cookie?: string) {
  return app.inject({
    method: "GET",
    url: "/trpc/example.ping.requiresPermission?input=%7B%7D",
    headers: cookie ? { cookie } : {},
  });
}

describe("WP-C05 · middleware de permisos (example.ping.requiresPermission, catalog.product:read)", () => {
  let testDb: TestDb;
  let redisContainer: StartedRedisContainer;
  let db: PrismaClient;
  let redis: Redis;
  let app: FastifyInstance;

  async function insertStaffUser(id: string, email: string, authSubject: string) {
    await testDb.superuserClient.query(
      `INSERT INTO app.staff_users
         (id, tenant_id, auth_subject, email, full_name, is_active, mfa_enrolled, mfa_secret_encrypted)
       VALUES ($1, $2, $3, $4, 'Test', true, true, $5)`,
      [id, TENANT_ID, authSubject, email, PLACEHOLDER_MFA_SECRET],
    );
  }

  /**
   * Login real + satisface el segundo factor DIRECTO en la base (sin pasar
   * por auth.mfa.verify — ver el comentario de PLACEHOLDER_MFA_SECRET
   * arriba), para poder llegar al middleware de permisos.
   */
  async function loginPastMfa(email: string): Promise<string> {
    const loginResponse = await app.inject({
      method: "POST",
      url: "/trpc/auth.session.login",
      payload: { email, password: STAFF_PASSWORD },
    });
    const cookie = toRequestCookie(loginResponse.headers["set-cookie"]);

    // Cada test crea su propia sesión nueva (login), pero staff_sessions no
    // se limpia entre `it()` — apunta a la más reciente sin revocar, no a
    // "todas", para no depender de que actualizar sesiones viejas sea inocuo.
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

    // `login()` (service.ts) ya cacheó `mfaStatus: "pending_verification"` en
    // Redis con el TTL de 15 min de sessionCache.ts ANTES del UPDATE de
    // arriba — el camino rápido de resolveRequestSession lo devolvería tal
    // cual, ignorando la base. Fuerza el camino lento (mismo recurso que
    // auth.integration.test.ts) para que la próxima request recalcule
    // `mfaStatus` fresco contra Postgres.
    await redis.flushall();

    return cookie;
  }

  beforeAll(async () => {
    testDb = await startTestDb();

    await testDb.superuserClient.query(
      `INSERT INTO app.tenants (id, slug, legal_name, trade_name)
       VALUES ($1, 'joda-c05', 'JODA Parfums SRL', 'JODA Parfums')`,
      [TENANT_ID],
    );
    // Roles estándar del negocio (docs/security-spec.md §2.1), sembrados con
    // la misma función que usa onboarding real — no se reinventa la matriz
    // acá (la trampa explícita de la Sesión 25 del playbook: "no inventes un
    // permiso nuevo que 'parece que falta' sin confirmarlo primero").
    await testDb.superuserClient.query(`SELECT app.seed_roles($1)`, [TENANT_ID]);

    await insertStaffUser(STAFF_VENDEDOR_ID, STAFF_VENDEDOR_EMAIL, "auth|vendedor-c05");
    await insertStaffUser(STAFF_SIN_ROL_ID, STAFF_SIN_ROL_EMAIL, "auth|sinrol-c05");
    await insertStaffUser(
      STAFF_SOLO_ESCRITURA_ID,
      STAFF_SOLO_ESCRITURA_EMAIL,
      "auth|escritura-c05",
    );
    await insertStaffUser(STAFF_CACHE_ID, STAFF_CACHE_EMAIL, "auth|cache-c05");

    const vendedorRole = await testDb.superuserClient.query(
      `SELECT id FROM app.roles WHERE tenant_id = $1 AND code = 'vendedor'`,
      [TENANT_ID],
    );
    await testDb.superuserClient.query(
      `INSERT INTO app.staff_user_roles (tenant_id, staff_user_id, role_id) VALUES ($1, $2, $3), ($1, $4, $3)`,
      [TENANT_ID, STAFF_VENDEDOR_ID, vendedorRole.rows[0].id, STAFF_CACHE_ID],
    );

    // Rol a medida, SOLO con catalog.product:write (sin :read) — no hay
    // ningún rol estándar con esa forma (todos los que tienen :write también
    // tienen :read, docs/security-spec.md §2.1), así que la única manera de
    // probar la excepción del 403 ("tiene acceso al MÓDULO pero no a la
    // ACCIÓN concreta") es un rol construido a propósito para este test.
    const writeOnlyRole = await testDb.superuserClient.query(
      `INSERT INTO app.roles (tenant_id, code, name) VALUES ($1, 'test_solo_escritura', 'Solo escritura (test)') RETURNING id`,
      [TENANT_ID],
    );
    await testDb.superuserClient.query(
      `INSERT INTO app.role_permissions (tenant_id, role_id, permission_code) VALUES ($1, $2, 'catalog.product:write')`,
      [TENANT_ID, writeOnlyRole.rows[0].id],
    );
    await testDb.superuserClient.query(
      `INSERT INTO app.staff_user_roles (tenant_id, staff_user_id, role_id) VALUES ($1, $2, $3)`,
      [TENANT_ID, STAFF_SOLO_ESCRITURA_ID, writeOnlyRole.rows[0].id],
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
          [STAFF_VENDEDOR_EMAIL, { password: STAFF_PASSWORD, authSubject: "auth|vendedor-c05" }],
          [STAFF_SIN_ROL_EMAIL, { password: STAFF_PASSWORD, authSubject: "auth|sinrol-c05" }],
          [
            STAFF_SOLO_ESCRITURA_EMAIL,
            { password: STAFF_PASSWORD, authSubject: "auth|escritura-c05" },
          ],
          [STAFF_CACHE_EMAIL, { password: STAFF_PASSWORD, authSubject: "auth|cache-c05" }],
        ]),
      ),
      clock: createManualClock(new Date("2026-01-01T12:00:00.000Z")),
      mfaEncryptionKey: MFA_ENCRYPTION_KEY,
    };
    app = buildServer(authDeps, "0".repeat(32));
  });

  afterEach(async () => {
    await app.close();
    await redis.flushall();
    redis.disconnect();
  });

  describe("docs/api-conventions.md §4.3 · la regla del 404", () => {
    it("sin cookie (sin sesión de personal) → 404", async () => {
      const response = await requiresPermission(app);

      expect(response.statusCode).toBe(404);
      expect(response.json().error.data.appCode).toBe("NOT_FOUND");
    });

    it("con sesión pero sin ningún rol asignado → 404, no 403 — no hay módulo que reconocer", async () => {
      const cookie = await loginPastMfa(STAFF_SIN_ROL_EMAIL);

      const response = await requiresPermission(app, cookie);

      expect(response.statusCode).toBe(404);
      expect(response.json().error.data.appCode).toBe("NOT_FOUND");
    });
  });

  it("con el permiso exacto (vendedor tiene catalog.product:read) → 200", async () => {
    const cookie = await loginPastMfa(STAFF_VENDEDOR_EMAIL);

    const response = await requiresPermission(app, cookie);

    expect(response.statusCode).toBe(200);
    expect(response.json().result.data).toEqual({ ok: true });
  });

  describe("docs/security-spec.md §3.4 · permisos para guardas de UX (WP-E04)", () => {
    it("antes del desafío MFA no publica permisos aunque el vendedor tenga rol", async () => {
      const loginResponse = await app.inject({
        method: "POST",
        url: "/trpc/auth.session.login",
        payload: { email: STAFF_VENDEDOR_EMAIL, password: STAFF_PASSWORD },
      });
      const cookie = toRequestCookie(loginResponse.headers["set-cookie"]);
      const response = await app.inject({
        method: "GET",
        url: "/trpc/auth.session.current",
        headers: { cookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().result.data.profile.mfaStatus).toBe("pending_verification");
      expect(response.json().result.data.permissions).toEqual([]);
    });

    it("la sesión de vendedor incluye catálogo y excluye contabilidad", async () => {
      const cookie = await loginPastMfa(STAFF_VENDEDOR_EMAIL);
      const response = await app.inject({
        method: "GET",
        url: "/trpc/auth.session.current",
        headers: { cookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().result.data.profile.mfaStatus).toBe("satisfied");
      expect(response.json().result.data.permissions).toContain("catalog.product:read");
      expect(response.json().result.data.permissions).not.toContain("accounting.journal:read");
    });
  });

  it("docs/runbooks/prompts-playbook.md Sesión 25 · con otro permiso del mismo módulo pero no el exacto → 403, no 404", async () => {
    const cookie = await loginPastMfa(STAFF_SOLO_ESCRITURA_EMAIL);

    const response = await requiresPermission(app, cookie);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.data.appCode).toBe("FORBIDDEN_INSUFFICIENT_PERMISSION");
  });

  describe("docs/security-spec.md §3.2 · caché de permisos en Redis, TTL 60 s", () => {
    it("revocar el rol no tiene efecto mientras el caché siga vigente, y sí lo tiene apenas se vence", async () => {
      const cookie = await loginPastMfa(STAFF_CACHE_EMAIL);

      const beforeRevoke = await requiresPermission(app, cookie);
      expect(beforeRevoke.statusCode).toBe(200);

      await testDb.superuserClient.query(
        `DELETE FROM app.staff_user_roles WHERE staff_user_id = $1`,
        [STAFF_CACHE_ID],
      );

      const staleCache = await requiresPermission(app, cookie);
      expect(staleCache.statusCode).toBe(200);

      // Simula el vencimiento del TTL de 60 s sin esperarlo de verdad — mismo
      // recurso que auth.integration.test.ts ya usa para forzar el "camino
      // lento" del caché de sesión.
      await redis.flushall();

      const afterExpiry = await requiresPermission(app, cookie);
      expect(afterExpiry.statusCode).toBe(404);
      expect(afterExpiry.json().error.data.appCode).toBe("NOT_FOUND");
    });
  });
});
