import { PrismaClient } from "@joda/db";
import type { Clock } from "@joda/domain";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encryptMfaSecret } from "../../adapters/mfaSecretCipher.js";
import { computeValidTotpCodes } from "../../adapters/totp.js";
import { createFakeStaffAuthProvider } from "../../adapters/staffAuth/fakeStaffAuthProvider.js";
import { jodaApiConnectionUrl, startTestDb, type TestDb } from "../../db/testDb.js";
import { buildServer } from "../../index.js";
import { recordFailedMfaAttempt } from "./mfaBruteForceGuard.js";
import type { AuthServiceDeps } from "./service.js";

const LOCALHOST_IP = "127.0.0.1";

const TENANT_ID = "33333333-3333-4333-a333-333333333333";
const STAFF_PASSWORD = "correcta";
const MFA_ENCRYPTION_KEY = Buffer.from("0".repeat(64), "hex");

const STAFF_UNENROLLED_ID = "44444444-4444-4444-a444-444444444444";
const STAFF_UNENROLLED_EMAIL = "ana@jodaparfums.com";
const AUTH_SUBJECT_UNENROLLED = "auth|ana";

// Secreto FIJO, no generado en el test — así los códigos válidos de abajo
// (704044/500171/046558) son datos literales, no algo que el test calcule
// (.claude/rules/testing.md: "sin lógica en los tests", "el valor esperado
// se escribe literal"). Calculados una sola vez contra
// apps/api/src/adapters/totp.ts para T = 2026-01-01T12:00:00.000Z (el reloj
// manual de abajo) y verificados contra el vector de RFC 6238 en
// adapters/totp.test.ts — no es una fe ciega en la implementación.
const STAFF_ENROLLED_ID = "55555555-5555-4555-a555-555555555555";
const STAFF_ENROLLED_EMAIL = "sofia@jodaparfums.com";
const AUTH_SUBJECT_ENROLLED = "auth|sofia";
const STAFF_ENROLLED_TOTP_SECRET = "JBSWY3DPEHPK3PXP";
/** Código vigente en T = 2026-01-01T12:00:00.000Z (paso 58908960). */
const VALID_CODE_AT_NOON = "704044";
/** Un código que no es válido ni un paso antes ni un paso después de VALID_CODE_AT_NOON — nunca "000000" a secas por si acaso. */
const WRONG_CODE = "000000";

function createManualClock(initial: Date): Clock & { advanceMs(ms: number): void } {
  let current = initial;
  return {
    now: () => current,
    advanceMs(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

function toRequestCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("se esperaba un header Set-Cookie en la respuesta");
  const separator = raw.indexOf(";");
  return separator === -1 ? raw : raw.slice(0, separator);
}

async function login(app: FastifyInstance, email: string) {
  return app.inject({
    method: "POST",
    url: "/trpc/auth.session.login",
    payload: { email, password: STAFF_PASSWORD },
  });
}

// Cualquier procedimiento de negocio que NO sea auth.session.* / auth.mfa.* —
// demuestra que el gate es estructural, no por ruta (docs/runbooks/
// prompts-playbook.md, Sesión 24).
async function pingWithCookie(app: FastifyInstance, cookie: string) {
  return app.inject({
    method: "GET",
    url: "/trpc/example.ping.list?input=%7B%7D",
    headers: { cookie },
  });
}

async function enroll(app: FastifyInstance, cookie: string) {
  return app.inject({
    method: "POST",
    url: "/trpc/auth.mfa.enroll",
    headers: { cookie },
    payload: {},
  });
}

async function confirmEnroll(app: FastifyInstance, cookie: string, code: string) {
  return app.inject({
    method: "POST",
    url: "/trpc/auth.mfa.confirmEnroll",
    headers: { cookie },
    payload: { code },
  });
}

async function verify(app: FastifyInstance, cookie: string, code: string) {
  return app.inject({
    method: "POST",
    url: "/trpc/auth.mfa.verify",
    headers: { cookie },
    payload: { code },
  });
}

describe("WP-C04 · segundo factor obligatorio para personal (auth.mfa.enroll/confirmEnroll/verify)", () => {
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
       VALUES ($1, $2, $3, $4, 'Ana', true)`,
      [STAFF_UNENROLLED_ID, TENANT_ID, AUTH_SUBJECT_UNENROLLED, STAFF_UNENROLLED_EMAIL],
    );
    // Ya inscripta desde el vamos, con un secreto conocido — cifrado con la
    // MISMA clave que authDeps.mfaEncryptionKey de abajo, igual que
    // adapters/mfaSecretCipher.ts lo haría en runtime.
    await testDb.superuserClient.query(
      `INSERT INTO app.staff_users
         (id, tenant_id, auth_subject, email, full_name, is_active, mfa_enrolled, mfa_secret_encrypted)
       VALUES ($1, $2, $3, $4, 'Sofía', true, true, $5)`,
      [
        STAFF_ENROLLED_ID,
        TENANT_ID,
        AUTH_SUBJECT_ENROLLED,
        STAFF_ENROLLED_EMAIL,
        encryptMfaSecret(STAFF_ENROLLED_TOTP_SECRET, MFA_ENCRYPTION_KEY),
      ],
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
        new Map([
          [
            STAFF_UNENROLLED_EMAIL,
            { password: STAFF_PASSWORD, authSubject: AUTH_SUBJECT_UNENROLLED },
          ],
          [STAFF_ENROLLED_EMAIL, { password: STAFF_PASSWORD, authSubject: AUTH_SUBJECT_ENROLLED }],
        ]),
      ),
      clock,
      mfaEncryptionKey: MFA_ENCRYPTION_KEY,
    };
    app = buildServer(authDeps, "0".repeat(32));
  });

  afterEach(async () => {
    await app.close();
    await redis.flushall();
    redis.disconnect();
  });

  describe("docs/security-spec.md §4.3 · criterio de aceptación — usuario sin inscribir solo accede a la pantalla de inscripción", () => {
    it("login de un usuario sin inscribir responde 200 con mfaStatus pending_enrollment, no un error", async () => {
      const response = await login(app, STAFF_UNENROLLED_EMAIL);

      expect(response.statusCode).toBe(200);
      expect(response.json().result.data.mfaStatus).toBe("pending_enrollment");
    });

    it("con la sesión en pending_enrollment, CUALQUIER otro procedimiento (acá, example.ping) queda bloqueado — el gate es estructural, no por ruta", async () => {
      const loginResponse = await login(app, STAFF_UNENROLLED_EMAIL);
      const cookie = toRequestCookie(loginResponse.headers["set-cookie"]);

      const response = await pingWithCookie(app, cookie);

      expect(response.statusCode).toBe(401);
      expect(response.json().error.data.appCode).toBe("UNAUTHENTICATED_MFA_ENROLLMENT_REQUIRED");
    });

    it("auth.session.refresh y auth.session.logout siguen funcionando con la inscripción pendiente — si no, la sesión quedaría sin forma de renovarse ni cerrarse", async () => {
      const loginResponse = await login(app, STAFF_UNENROLLED_EMAIL);
      const cookie = toRequestCookie(loginResponse.headers["set-cookie"]);

      const refreshResponse = await app.inject({
        method: "POST",
        url: "/trpc/auth.session.refresh",
        headers: { cookie },
        payload: {},
      });
      expect(refreshResponse.statusCode).toBe(200);

      const logoutResponse = await app.inject({
        method: "POST",
        url: "/trpc/auth.session.logout",
        headers: { cookie: toRequestCookie(refreshResponse.headers["set-cookie"]) },
        payload: {},
      });
      expect(logoutResponse.statusCode).toBe(200);
    });

    it("auth.mfa.verify antes de inscribir: 409 — no hay nada que verificar todavía", async () => {
      const loginResponse = await login(app, STAFF_UNENROLLED_EMAIL);
      const cookie = toRequestCookie(loginResponse.headers["set-cookie"]);

      const response = await verify(app, cookie, WRONG_CODE);

      expect(response.statusCode).toBe(409);
      expect(response.json().error.data.appCode).toBe("CONFLICT_MFA_NOT_ENROLLED");
    });

    it("auth.mfa.confirmEnroll antes de auth.mfa.enroll: 409 — no hay un secreto pendiente que confirmar", async () => {
      const loginResponse = await login(app, STAFF_UNENROLLED_EMAIL);
      const cookie = toRequestCookie(loginResponse.headers["set-cookie"]);

      const response = await confirmEnroll(app, cookie, WRONG_CODE);

      expect(response.statusCode).toBe(409);
      expect(response.json().error.data.appCode).toBe("CONFLICT_MFA_ENROLLMENT_NOT_STARTED");
    });
  });

  describe("docs/security-spec.md §4.3 · ciclo completo de inscripción", () => {
    it("enroll → confirmEnroll con código inválido no inscribe, sigue bloqueado; con el código correcto, inscribe y desbloquea", async () => {
      const loginResponse = await login(app, STAFF_UNENROLLED_EMAIL);
      const cookie = toRequestCookie(loginResponse.headers["set-cookie"]);

      const enrollResponse = await enroll(app, cookie);
      expect(enrollResponse.statusCode).toBe(200);
      const { secret, otpauthUri } = enrollResponse.json().result.data;
      expect(typeof secret).toBe("string");
      expect(otpauthUri).toContain(encodeURIComponent(STAFF_UNENROLLED_EMAIL));

      const wrongConfirm = await confirmEnroll(app, cookie, WRONG_CODE);
      expect(wrongConfirm.statusCode).toBe(401);
      expect(wrongConfirm.json().error.data.appCode).toBe("UNAUTHENTICATED_MFA_INVALID_CODE");
      expect((await pingWithCookie(app, cookie)).statusCode).toBe(401);

      // El secreto lo generó el servidor — no hay forma de tener un código
      // válido "literal" de antemano como con STAFF_ENROLLED_TOTP_SECRET.
      // Calcularlo acá con el mismo adaptador que usa el servidor es
      // exactamente lo que haría una app autenticadora real leyendo el QR;
      // no es "recalcular el resultado esperado" (la corrección del cálculo
      // en sí ya la prueba adapters/totp.test.ts contra RFC 6238).
      const validCodes = computeValidTotpCodes(secret, clock.now().getTime(), 0);
      const confirmResponse = await confirmEnroll(app, cookie, validCodes[0] ?? "");
      expect(confirmResponse.statusCode).toBe(200);
      expect(confirmResponse.json().result.data).toEqual({ mfaStatus: "satisfied" });

      expect((await pingWithCookie(app, cookie)).statusCode).toBe(200);
    });

    // STAFF_ENROLLED_EMAIL, no STAFF_UNENROLLED_EMAIL: este último ya quedó
    // inscripto por el test anterior (mismo fixture, misma fila de
    // staff_users durante todo el describe de arriba) — reusarlo acá
    // encadenaría el resultado de un test al del otro. STAFF_ENROLLED_EMAIL
    // nace inscripto desde `beforeAll`, sin pasar por ningún test previo.
    it("un usuario ya inscripto que llama a auth.mfa.enroll de nuevo recibe 409 — no hay reinscripción en este WP", async () => {
      const loginResponse = await login(app, STAFF_ENROLLED_EMAIL);
      const cookie = toRequestCookie(loginResponse.headers["set-cookie"]);

      const response = await enroll(app, cookie);

      expect(response.statusCode).toBe(409);
      expect(response.json().error.data.appCode).toBe("CONFLICT_MFA_ALREADY_ENROLLED");
    });
  });

  describe("docs/security-spec.md §4.3 · un usuario YA inscripto también satisface el desafío en CADA sesión nueva", () => {
    it("el login de un usuario inscripto nace en pending_verification, no en satisfied — si no, el segundo factor dejaría de tener efecto después de la primera vez", async () => {
      const response = await login(app, STAFF_ENROLLED_EMAIL);

      expect(response.json().result.data.mfaStatus).toBe("pending_verification");
    });

    it('con pending_verification, example.ping también queda bloqueado, con un código de error distinto al de "sin inscribir"', async () => {
      const loginResponse = await login(app, STAFF_ENROLLED_EMAIL);
      const cookie = toRequestCookie(loginResponse.headers["set-cookie"]);

      const response = await pingWithCookie(app, cookie);

      expect(response.statusCode).toBe(401);
      expect(response.json().error.data.appCode).toBe("UNAUTHENTICATED_MFA_VERIFICATION_REQUIRED");
    });

    it("auth.mfa.verify con código incorrecto no desbloquea; con el correcto, sí", async () => {
      const loginResponse = await login(app, STAFF_ENROLLED_EMAIL);
      const cookie = toRequestCookie(loginResponse.headers["set-cookie"]);

      const wrongVerify = await verify(app, cookie, WRONG_CODE);
      expect(wrongVerify.statusCode).toBe(401);
      expect(wrongVerify.json().error.data.appCode).toBe("UNAUTHENTICATED_MFA_INVALID_CODE");
      expect((await pingWithCookie(app, cookie)).statusCode).toBe(401);

      const verifyResponse = await verify(app, cookie, VALID_CODE_AT_NOON);
      expect(verifyResponse.statusCode).toBe(200);
      expect(verifyResponse.json().result.data).toEqual({ mfaStatus: "satisfied" });
      expect((await pingWithCookie(app, cookie)).statusCode).toBe(200);
    });

    it("una SEGUNDA sesión (nuevo login) del mismo usuario vuelve a nacer pending_verification, aunque la primera ya esté satisfied", async () => {
      const firstLogin = await login(app, STAFF_ENROLLED_EMAIL);
      const firstCookie = toRequestCookie(firstLogin.headers["set-cookie"]);
      await verify(app, firstCookie, VALID_CODE_AT_NOON);
      expect((await pingWithCookie(app, firstCookie)).statusCode).toBe(200);

      const secondLogin = await login(app, STAFF_ENROLLED_EMAIL);
      expect(secondLogin.json().result.data.mfaStatus).toBe("pending_verification");
      const secondCookie = toRequestCookie(secondLogin.headers["set-cookie"]);
      expect((await pingWithCookie(app, secondCookie)).statusCode).toBe(401);
    });
  });

  describe("docs/security-spec.md §5.1 · fuerza bruta sobre auth.mfa.verify", () => {
    it("bloquea con 429 y Retry-After tras 10 intentos fallidos registrados, incluso si el siguiente intento es el código correcto", async () => {
      const loginResponse = await login(app, STAFF_ENROLLED_EMAIL);
      const cookie = toRequestCookie(loginResponse.headers["set-cookie"]);

      // 10 fallos vía recordFailedMfaAttempt directo, no 10 POST reales a
      // auth.mfa.verify: cada intento fallido por HTTP dispara el retardo
      // progresivo real de mfaBruteForceGuard.ts (hasta 5 s por intento,
      // con setTimeout de verdad — no algo que el reloj inyectado adelante),
      // igual que el test análogo de auth.integration.test.ts (WP-C03) evita
      // 10 POST reales a auth.session.login por el mismo motivo.
      const { rows } = await testDb.superuserClient.query<{ id: string }>(
        `SELECT id FROM app.staff_sessions
          WHERE staff_user_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [STAFF_ENROLLED_ID],
      );
      const sessionId = rows[0]?.id;
      if (!sessionId) throw new Error("no se encontró la sesión recién creada");
      for (let i = 0; i < 10; i++) {
        await recordFailedMfaAttempt(redis, LOCALHOST_IP, sessionId);
      }

      const response = await verify(app, cookie, VALID_CODE_AT_NOON);

      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBe(String(15 * 60));
      expect(response.json().error.data.appCode).toBe("RATE_LIMITED_MFA_LOCKED");
    });
  });
});
