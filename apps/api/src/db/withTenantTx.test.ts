import { PrismaClient, type Prisma } from "@joda/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jodaApiConnectionUrl, startTestDb, type TestDb } from "./testDb.js";
import { withTenantTx } from "./withTenantTx.js";

interface SessionRow {
  tenant_id: string | null;
  pid: number;
}

// SELECT sin FROM/WHERE siempre devuelve exactamente una fila — la
// aserción de tipo documenta esa garantía en vez de una comprobación en
// cada test (.claude/rules/testing.md: sin lógica en los tests).
async function readSession(tx: Prisma.TransactionClient): Promise<SessionRow> {
  const rows = await tx.$queryRaw<SessionRow[]>`
    SELECT current_setting('app.tenant_id', true) AS tenant_id, pg_backend_pid() AS pid`;
  return rows[0] as SessionRow;
}

// docs/api-conventions.md §8.1: el tercer parámetro `true` de `set_config`
// hace el valor LOCAL a la transacción — sin él, el contexto sobrevive al
// COMMIT y queda pegado a la conexión física, así que la siguiente petición
// que el pool le asigne a esa misma conexión heredaría un tenant/usuario
// ajeno (AGENTS.md § Seguridad). `connection_limit=1` fuerza al pool interno
// de Prisma a reutilizar una única conexión física entre transacciones, para
// que esta prueba sea determinística y no dependa de en qué conexión de un
// pool más grande caiga cada llamada.
describe("withTenantTx no filtra contexto entre transacciones que reusan la conexión del pool (docs/api-conventions.md §8.1)", () => {
  let testDb: TestDb;
  let db: PrismaClient;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = new PrismaClient({ datasourceUrl: jodaApiConnectionUrl(testDb.container) });
  }, 60_000);

  afterAll(async () => {
    await db.$disconnect();
    await testDb.stop();
  });

  it("dos transacciones consecutivas de tenants distintos, sobre la misma conexión física, no comparten app.tenant_id", async () => {
    const TENANT_ONE = "11111111-1111-1111-1111-111111111111";
    const TENANT_TWO = "22222222-2222-2222-2222-222222222222";

    const first = await withTenantTx(
      db,
      { userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", tenantId: TENANT_ONE, audience: "staff" },
      readSession,
    );

    const second = await withTenantTx(
      db,
      { userId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", tenantId: TENANT_TWO, audience: "staff" },
      readSession,
    );

    expect(first.tenant_id).toBe(TENANT_ONE);
    expect(second.pid).toBe(first.pid);
    expect(second.tenant_id).toBe(TENANT_TWO);
  });

  it("una transacción que no pasa por withTenantTx no hereda el tenant de la transacción anterior sobre la misma conexión", async () => {
    const TENANT_ONE = "11111111-1111-1111-1111-111111111111";

    await withTenantTx(
      db,
      { userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", tenantId: TENANT_ONE, audience: "staff" },
      async (tx) => {
        await tx.$queryRaw`SELECT 1`;
      },
    );

    const leaked = await db.$transaction(readSession);

    expect(leaked.tenant_id).toBeFalsy();
  });
});
