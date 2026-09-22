import { PrismaClient } from "@joda/db";
import type { Clock } from "@joda/domain";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeStaffAuthProvider } from "../adapters/staffAuth/fakeStaffAuthProvider.js";
import { jodaApiConnectionUrl, startTestDb, type TestDb } from "../db/testDb.js";
import { buildServer } from "../index.js";
import type { AuthServiceDeps } from "../modules/auth/service.js";

// UUID v4 válidos de verdad — mismo criterio que permission.integration.test.ts.
const TENANT_ID = "88888888-8888-4888-a888-888888888888";
const STAFF_PASSWORD = "correcta";
const MFA_ENCRYPTION_KEY = Buffer.from("0".repeat(64), "hex");
// El CHECK de staff_users solo exige NOT NULL cuando mfa_enrolled = true — no
// se descifra en este archivo (mismo criterio que permission.integration.test.ts).
const PLACEHOLDER_MFA_SECRET = "placeholder-nunca-se-descifra-en-este-test";
const STAFF_ID = "99999999-9999-4999-a999-999999999991";
const STAFF_EMAIL = "idempotencia@jodaparfums.com";

function createManualClock(initial: Date): Clock {
  return { now: () => initial };
}

function toRequestCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("se esperaba un header Set-Cookie en la respuesta");
  const separator = raw.indexOf(";");
  return separator === -1 ? raw : raw.slice(0, separator);
}

async function irreversibleEffect(
  app: FastifyInstance,
  cookie: string,
  label: string,
  idempotencyKey?: string,
) {
  return app.inject({
    method: "POST",
    url: "/trpc/example.ping.irreversibleEffect",
    headers: {
      cookie,
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    payload: { label },
  });
}

async function effectCount(app: FastifyInstance, cookie: string) {
  return app.inject({
    method: "GET",
    url: "/trpc/example.ping.effectCount?input=%7B%7D",
    headers: { cookie },
  });
}

// docs/api-conventions.md §5 (WP-C06): el middleware de idempotencia general,
// probado de punta a punta — HTTP real (`app.inject`) → tRPC →
// withIdempotentTx → idempotency_keys en Postgres real — contra
// example.ping.irreversibleEffect (apps/api/src/trpc/exampleRouter.ts), el
// mismo criterio que WP-C04/WP-C05 usaron para probar sus propios middlewares
// sin depender de un módulo de negocio real todavía pendiente.
describe("WP-C06 · middleware de idempotencia (example.ping.irreversibleEffect)", () => {
  let testDb: TestDb;
  let redisContainer: StartedRedisContainer;
  let db: PrismaClient;
  let redis: Redis;
  let app: FastifyInstance;

  async function loginPastMfa(): Promise<string> {
    const loginResponse = await app.inject({
      method: "POST",
      url: "/trpc/auth.session.login",
      payload: { email: STAFF_EMAIL, password: STAFF_PASSWORD },
    });
    const cookie = toRequestCookie(loginResponse.headers["set-cookie"]);

    await testDb.superuserClient.query(
      `UPDATE app.staff_sessions SET mfa_verified_at = now()
       WHERE id = (
         SELECT s.id FROM app.staff_sessions s
         JOIN app.staff_users u ON u.id = s.staff_user_id
         WHERE u.email = $1 AND s.revoked_at IS NULL
         ORDER BY s.created_at DESC LIMIT 1
       )`,
      [STAFF_EMAIL],
    );
    await redis.flushall();

    return cookie;
  }

  beforeAll(async () => {
    testDb = await startTestDb();

    await testDb.superuserClient.query(
      `INSERT INTO app.tenants (id, slug, legal_name, trade_name)
       VALUES ($1, 'joda-c06', 'JODA Parfums SRL', 'JODA Parfums')`,
      [TENANT_ID],
    );
    await testDb.superuserClient.query(
      `INSERT INTO app.staff_users
         (id, tenant_id, auth_subject, email, full_name, is_active, mfa_enrolled, mfa_secret_encrypted)
       VALUES ($1, $2, 'auth|idempotencia-c06', $3, 'Test', true, true, $4)`,
      [STAFF_ID, TENANT_ID, STAFF_EMAIL, PLACEHOLDER_MFA_SECRET],
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
          [STAFF_EMAIL, { password: STAFF_PASSWORD, authSubject: "auth|idempotencia-c06" }],
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

  it("sin Idempotency-Key → cada pedido corre el efecto de nuevo", async () => {
    const cookie = await loginPastMfa();

    const first = await irreversibleEffect(app, cookie, "sin-clave");
    const second = await irreversibleEffect(app, cookie, "sin-clave");

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().result.data.id).not.toBe(second.json().result.data.id);

    const count = await effectCount(app, cookie);
    expect(count.json().result.data.count).toBe(2);
  });

  it("reintento con el mismo Idempotency-Key y el mismo cuerpo → la misma respuesta guardada, sin reprocesar", async () => {
    const cookie = await loginPastMfa();

    const first = await irreversibleEffect(app, cookie, "mismo-cuerpo", "clave-1");
    const second = await irreversibleEffect(app, cookie, "mismo-cuerpo", "clave-1");

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().result.data).toEqual(first.json().result.data);

    const count = await effectCount(app, cookie);
    expect(count.json().result.data.count).toBe(1);
  });

  it("reintento con el mismo Idempotency-Key y un cuerpo distinto → 409 CONFLICT_IDEMPOTENCY_KEY_REUSE, sin reprocesar", async () => {
    const cookie = await loginPastMfa();

    const first = await irreversibleEffect(app, cookie, "cuerpo-original", "clave-2");
    const second = await irreversibleEffect(app, cookie, "cuerpo-distinto", "clave-2");

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.data.appCode).toBe("CONFLICT_IDEMPOTENCY_KEY_REUSE");

    const count = await effectCount(app, cookie);
    expect(count.json().result.data.count).toBe(1);
  });

  it("dos claves distintas del mismo tenant no interfieren entre sí", async () => {
    const cookie = await loginPastMfa();

    const first = await irreversibleEffect(app, cookie, "independiente-1", "clave-a");
    const second = await irreversibleEffect(app, cookie, "independiente-2", "clave-b");

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().result.data).not.toEqual(second.json().result.data);

    const count = await effectCount(app, cookie);
    expect(count.json().result.data.count).toBe(2);
  });
});
