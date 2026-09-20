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

// UUID v4 válidos de verdad (nibble de versión "4", variante "a") — no el
// "11111111-1111-1111-1111-111111111111" de packages/db/tests/
// smoke_business_flow.sql: Postgres acepta ese literal sin quejarse, pero
// packages/contracts/src/shared/id.ts (`z.string().uuid()`, Zod 4) valida
// RFC 4122 de verdad, y un id que la API devuelve en el body (el perfil de
// auth.session.login) pasa por ese esquema de salida.
const TENANT_ID = "11111111-1111-4111-a111-111111111111";
const STAFF_USER_ID = "22222222-2222-4222-a222-222222222222";
const STAFF_EMAIL = "jose@jodaparfums.com";
const STAFF_PASSWORD = "correcta";
const AUTH_SUBJECT = "auth|jose";
const SESSION_SECRET = "0".repeat(32);

/** Reloj de test (docs/testing-strategy.md, determinismo: reloj inyectado — nunca `Date` real). */
function createManualClock(initial: Date): Clock & { advanceMs(ms: number): void } {
  let current = initial;
  return {
    now: () => current,
    advanceMs(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

/** `Set-Cookie: __Host-joda_a=xyz; Path=/; ...` → `__Host-joda_a=xyz`, lo único que un `Cookie:` de request necesita. */
function toRequestCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("se esperaba un header Set-Cookie en la respuesta");
  const separator = raw.indexOf(";");
  return separator === -1 ? raw : raw.slice(0, separator);
}

async function login(app: FastifyInstance, password = STAFF_PASSWORD) {
  return app.inject({
    method: "POST",
    url: "/trpc/auth.session.login",
    payload: { email: STAFF_EMAIL, password },
  });
}

async function refresh(app: FastifyInstance, cookie: string) {
  return app.inject({
    method: "POST",
    url: "/trpc/auth.session.refresh",
    headers: { cookie },
    payload: {},
  });
}

describe("WP-C03 · sesión de personal (auth.session.login/refresh/logout)", () => {
  let testDb: TestDb;
  let redisContainer: StartedRedisContainer;
  let db: PrismaClient;
  let redis: Redis;
  let clock: ReturnType<typeof createManualClock>;
  let app: FastifyInstance;

  beforeAll(async () => {
    testDb = await startTestDb();
    await testDb.superuserClient.query(
      `INSERT INTO app.tenants (id, slug, legal_name, trade_name)
       VALUES ($1, 'joda', 'JODA Parfums SRL', 'JODA Parfums')`,
      [TENANT_ID],
    );
    await testDb.superuserClient.query(
      `INSERT INTO app.staff_users (id, tenant_id, auth_subject, email, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'José', true)`,
      [STAFF_USER_ID, TENANT_ID, AUTH_SUBJECT, STAFF_EMAIL],
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
    clock = createManualClock(new Date("2026-01-01T12:00:00.000Z"));
    const authDeps: AuthServiceDeps = {
      db,
      redis,
      authProvider: createFakeStaffAuthProvider(
        new Map([[STAFF_EMAIL, { password: STAFF_PASSWORD, authSubject: AUTH_SUBJECT }]]),
      ),
      clock,
    };
    app = buildServer(authDeps, SESSION_SECRET);
  });

  afterEach(async () => {
    await app.close();
    await redis.flushall();
    redis.disconnect();
  });

  describe("docs/backlog.md WP-C03 · login", () => {
    it("credenciales correctas: responde el perfil sin tokens y deja la cookie __Host-joda_a firmada", async () => {
      const response = await login(app);

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.result.data).toEqual({ id: STAFF_USER_ID, email: STAFF_EMAIL, fullName: "José" });
      expect(JSON.stringify(body)).not.toContain(STAFF_PASSWORD);

      const setCookie = response.headers["set-cookie"];
      expect(String(setCookie)).toContain("__Host-joda_a=");
      expect(String(setCookie)).toContain("HttpOnly");
      expect(String(setCookie)).toContain("Secure");
    });

    it("contraseña incorrecta: 401 con el mismo mensaje genérico que un email inexistente (docs/security-spec.md §5.1)", async () => {
      const wrongPassword = await login(app, "incorrecta");
      const unknownEmail = await app.inject({
        method: "POST",
        url: "/trpc/auth.session.login",
        payload: { email: "no-existe@jodaparfums.com", password: "cualquiera" },
      });

      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownEmail.statusCode).toBe(401);
      expect(wrongPassword.json().error.message).toBe(unknownEmail.json().error.message);
    });
  });

  describe("docs/backlog.md WP-C03 · criterio de aceptación — reusar un refresco invalida toda la familia", () => {
    it("refresh rota el token: la cookie vieja ya no sirve para un refresh posterior", async () => {
      const loginResponse = await login(app);
      const firstCookie = toRequestCookie(loginResponse.headers["set-cookie"]);

      const refreshResponse = await refresh(app, firstCookie);
      expect(refreshResponse.statusCode).toBe(200);
      const rotatedCookie = toRequestCookie(refreshResponse.headers["set-cookie"]);
      expect(rotatedCookie).not.toBe(firstCookie);

      // La cookie vieja quedó consumida por la rotación de arriba — reusarla
      // es EXACTAMENTE el escenario que el criterio de aceptación nombra.
      const reuseResponse = await refresh(app, firstCookie);
      expect(reuseResponse.statusCode).toBe(401);
      expect(reuseResponse.json().error.data.appCode).toBe(
        "UNAUTHENTICATED_SESSION_REUSE_DETECTED",
      );
    });

    it("tras el reúso, la familia entera queda revocada: ni siquiera el token recién rotado (legítimo) sigue sirviendo", async () => {
      const loginResponse = await login(app);
      const firstCookie = toRequestCookie(loginResponse.headers["set-cookie"]);

      const refreshResponse = await refresh(app, firstCookie);
      const rotatedCookie = toRequestCookie(refreshResponse.headers["set-cookie"]);

      await refresh(app, firstCookie); // dispara la detección de reúso

      const afterReuse = await refresh(app, rotatedCookie);
      expect(afterReuse.statusCode).toBe(401);
      expect(afterReuse.json().error.data.appCode).toBe("UNAUTHENTICATED_SESSION_EXPIRED");
    });
  });

  describe("docs/security-spec.md §1 · ventana absoluta de 8 h", () => {
    it("un refresh después de 8 h de la sesión original se rechaza, aunque el token nunca se haya usado", async () => {
      const loginResponse = await login(app);
      const cookie = toRequestCookie(loginResponse.headers["set-cookie"]);

      clock.advanceMs(8 * 60 * 60 * 1000 + 1);

      const response = await refresh(app, cookie);
      expect(response.statusCode).toBe(401);
      expect(response.json().error.data.appCode).toBe("UNAUTHENTICATED_SESSION_EXPIRED");
    });
  });

  describe("docs/security-spec.md §4 · logout", () => {
    it("revoca la sesión: un refresh posterior a la cookie de logout se rechaza", async () => {
      const loginResponse = await login(app);
      const cookie = toRequestCookie(loginResponse.headers["set-cookie"]);

      const logoutResponse = await app.inject({
        method: "POST",
        url: "/trpc/auth.session.logout",
        headers: { cookie },
        payload: {},
      });
      expect(logoutResponse.statusCode).toBe(200);
      expect(logoutResponse.json().result.data).toEqual({ ok: true });

      const response = await refresh(app, cookie);
      expect(response.statusCode).toBe(401);
    });

    it("es idempotente: cerrar sesión sin una cookie válida no es un error", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/trpc/auth.session.logout",
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().result.data).toEqual({ ok: true });
    });
  });

  describe("modules/auth/service.ts resolveRequestSession · camino lento (caché de 15 min vencido)", () => {
    it("con el caché de Redis vacío, una request igual se resuelve contra Postgres y logout sigue revocando la sesión", async () => {
      const loginResponse = await login(app);
      const cookie = toRequestCookie(loginResponse.headers["set-cookie"]);

      // Fuerza el camino lento: sin esto, auth.session.logout resolvería el
      // contexto por el caché de Redis (camino rápido) y nunca ejercitaría
      // la validación contra `staff_refresh_tokens`.
      await redis.flushall();

      const logoutResponse = await app.inject({
        method: "POST",
        url: "/trpc/auth.session.logout",
        headers: { cookie },
        payload: {},
      });
      expect(logoutResponse.json().result.data).toEqual({ ok: true });

      const response = await refresh(app, cookie);
      expect(response.statusCode).toBe(401);
    });

    it("un reúso detectado por el camino lento (una request cualquiera, no auth.session.refresh) también revoca toda la familia", async () => {
      const loginResponse = await login(app);
      const firstCookie = toRequestCookie(loginResponse.headers["set-cookie"]);

      const refreshResponse = await refresh(app, firstCookie);
      const rotatedCookie = toRequestCookie(refreshResponse.headers["set-cookie"]);

      // El token viejo (`firstCookie`) ya está consumido por la rotación de
      // arriba. Presentarlo en CUALQUIER request — acá, un logout, no un
      // refresh — tiene que disparar la misma detección de reúso.
      await redis.flushall();
      await app.inject({
        method: "POST",
        url: "/trpc/auth.session.logout",
        headers: { cookie: firstCookie },
        payload: {},
      });

      const afterReuse = await refresh(app, rotatedCookie);
      expect(afterReuse.statusCode).toBe(401);
      expect(afterReuse.json().error.data.appCode).toBe("UNAUTHENTICATED_SESSION_EXPIRED");
    });
  });
});
