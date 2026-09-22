import { PrismaClient } from "@joda/db";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isApiError } from "../middleware/errorMapper.js";
import { jodaApiConnectionUrl, startTestDb, type TestDb } from "./testDb.js";
import { withIdempotentTx, type IdempotencyRequest } from "./withIdempotentTx.js";

const TENANT_ID = "33333333-3333-4333-a333-333333333333";
const ACTOR = {
  userId: "44444444-4444-4444-a444-444444444444",
  tenantId: TENANT_ID,
  audience: "staff" as const,
};

// docs/api-conventions.md §5: middleware de idempotencia general, distinto
// del mecanismo de payment_events para webhooks (§5.1). Corre contra
// Postgres real vía Testcontainers, no un simulacro de Prisma
// (.claude/rules/testing.md) — es la única forma de probar de verdad que el
// registro se inserta DENTRO de la transacción del efecto (trampa explícita
// de la Sesión 26 del playbook).
describe("withIdempotentTx (docs/api-conventions.md §5, WP-C06)", () => {
  let testDb: TestDb;
  let db: PrismaClient;

  beforeAll(async () => {
    testDb = await startTestDb();
    await testDb.superuserClient.query(
      `INSERT INTO app.tenants (id, slug, legal_name, trade_name)
       VALUES ($1, 'joda-c06', 'JODA Parfums SRL', 'JODA Parfums')`,
      [TENANT_ID],
    );
    db = new PrismaClient({ datasourceUrl: jodaApiConnectionUrl(testDb.container) });
  }, 60_000);

  afterAll(async () => {
    await db.$disconnect();
    await testDb.stop();
  });

  it("sin Idempotency-Key (null) → fn corre en cada llamada, sin dejar rastro en idempotency_keys", async () => {
    let effectCalls = 0;
    const fn = async () => {
      effectCalls += 1;
      return { result: { call: effectCalls }, statusCode: 200 };
    };

    const first = await withIdempotentTx(db, ACTOR, null, fn);
    const second = await withIdempotentTx(db, ACTOR, null, fn);

    expect(first).toEqual({ result: { call: 1 }, statusCode: 200, replayed: false });
    expect(second).toEqual({ result: { call: 2 }, statusCode: 200, replayed: false });
    expect(effectCalls).toBe(2);
  });

  it("primera vez con una clave → corre fn y persiste la respuesta, replayed: false", async () => {
    const idempotency: IdempotencyRequest = {
      scope: "api",
      key: "primera-vez",
      requestHash: "hash-primera-vez",
    };
    let effectCalls = 0;
    const fn = async () => {
      effectCalls += 1;
      return { result: { orderId: "abc" }, statusCode: 200 };
    };

    const outcome = await withIdempotentTx(db, ACTOR, idempotency, fn);

    expect(outcome).toEqual({ result: { orderId: "abc" }, statusCode: 200, replayed: false });
    expect(effectCalls).toBe(1);
  });

  it("reintento con la misma clave y el mismo cuerpo → devuelve la respuesta guardada, sin reprocesar", async () => {
    const idempotency: IdempotencyRequest = {
      scope: "api",
      key: "mismo-cuerpo",
      requestHash: "hash-x",
    };
    let effectCalls = 0;
    const fn = async () => {
      effectCalls += 1;
      return { result: { orderId: `orden-${effectCalls}` }, statusCode: 200 };
    };

    const first = await withIdempotentTx(db, ACTOR, idempotency, fn);
    const second = await withIdempotentTx(db, ACTOR, idempotency, fn);

    expect(first).toEqual({ result: { orderId: "orden-1" }, statusCode: 200, replayed: false });
    expect(second).toEqual({ result: { orderId: "orden-1" }, statusCode: 200, replayed: true });
    expect(effectCalls).toBe(1);
  });

  it("reintento con la misma clave y un cuerpo distinto → 409 CONFLICT_IDEMPOTENCY_KEY_REUSE, fn no corre de nuevo", async () => {
    const key = "cuerpo-distinto";
    let effectCalls = 0;
    const fn = async () => {
      effectCalls += 1;
      return { result: { orderId: "unica" }, statusCode: 200 };
    };

    await withIdempotentTx(db, ACTOR, { scope: "api", key, requestHash: "hash-a" }, fn);

    await expect(
      withIdempotentTx(db, ACTOR, { scope: "api", key, requestHash: "hash-b" }, fn),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TRPCError);
      const trpcError = error as TRPCError;
      expect(trpcError.code).toBe("CONFLICT");
      expect(isApiError(trpcError.cause)).toBe(true);
      expect(trpcError.cause).toMatchObject({
        code: "CONFLICT_IDEMPOTENCY_KEY_REUSE",
        httpStatus: 409,
      });
      return true;
    });
    expect(effectCalls).toBe(1);
  });

  it("docs/runbooks/prompts-playbook.md Sesión 26 · si fn falla, la transacción entera hace rollback y la clave no queda quemada", async () => {
    const idempotency: IdempotencyRequest = {
      scope: "api",
      key: "efecto-que-falla",
      requestHash: "hash-y",
    };
    let effectCalls = 0;
    const failingFn = async () => {
      effectCalls += 1;
      throw new Error("el efecto de negocio falló a mitad de camino");
    };

    await expect(withIdempotentTx(db, ACTOR, idempotency, failingFn)).rejects.toThrow(
      "el efecto de negocio falló a mitad de camino",
    );
    expect(effectCalls).toBe(1);

    const succeedingFn = async () => {
      effectCalls += 1;
      return { result: { recovered: true }, statusCode: 200 };
    };
    const retried = await withIdempotentTx(db, ACTOR, idempotency, succeedingFn);

    expect(retried).toEqual({ result: { recovered: true }, statusCode: 200, replayed: false });
    expect(effectCalls).toBe(2);
  });
});
