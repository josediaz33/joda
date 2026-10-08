import { PrismaClient } from "@joda/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jodaApiConnectionUrl, startTestDb, type TestDb } from "../db/testDb.js";
import { withTenantTx, type TenantTxContext } from "../db/withTenantTx.js";
import { isPrismaKnownError, mapPrismaError } from "./errorMapper.js";

// Un error REAL de Prisma, no uno armado a mano: el test unitario de
// errorMapper.test.ts construye `{ code, constraint }`, una forma que Prisma
// nunca entrega, y por eso no vio que el borrado de un pedido con seña llegaba
// como un 500 (hallazgo de la revisión cruzada de WP-B11d). Acá se borra de
// verdad, como `joda_api` y con la sesión de un vendedor, y se mira qué sale.
// No hay una RN que citar: es la convención de frontera de
// docs/api-conventions.md §4.4 (traducción de errores de la base).
const TENANT_ID = "77777777-7777-4777-a777-777777777790";
const USER_ID = "99999999-9999-4999-a999-999999999990";
const SESSION_ID = "99999999-9999-4999-a999-99999999999a";

describe("docs/api-conventions.md §4.4 · el error real de Prisma al borrar un pedido con seña llega traducido (WP-B11d)", () => {
  let testDb: TestDb;
  let db: PrismaClient;
  let ctx: TenantTxContext;
  let saleOrderId: string;

  beforeAll(async () => {
    testDb = await startTestDb();
    const sql = testDb.superuserClient;

    await sql.query(
      `INSERT INTO app.tenants (id, slug, legal_name, trade_name)
       VALUES ($1, 'joda-mapper', 'JODA Parfums SRL', 'JODA Parfums')`,
      [TENANT_ID],
    );
    await sql.query(`SELECT app.seed_roles($1)`, [TENANT_ID]);
    await sql.query(
      `INSERT INTO app.staff_users (id, tenant_id, auth_subject, email, full_name)
       VALUES ($1, $2, 'auth|vendedor-mapper', 'vendedor@mapper.test', 'Vendedor')`,
      [USER_ID, TENANT_ID],
    );
    const role = await sql.query(
      `SELECT id FROM app.roles WHERE tenant_id = $1 AND code = 'vendedor'`,
      [TENANT_ID],
    );
    await sql.query(
      `INSERT INTO app.staff_user_roles (tenant_id, staff_user_id, role_id) VALUES ($1, $2, $3)`,
      [TENANT_ID, USER_ID, role.rows[0].id],
    );
    // `has_permission()` exige una sesión viva (WP-B13).
    await sql.query(
      `INSERT INTO app.staff_sessions (id, tenant_id, staff_user_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '8 hours')`,
      [SESSION_ID, TENANT_ID, USER_ID],
    );

    const channel = await sql.query(
      `INSERT INTO app.sales_channels (tenant_id, code, name)
       VALUES ($1, 'presencial', 'Presencial') RETURNING id`,
      [TENANT_ID],
    );
    const customer = await sql.query(
      `INSERT INTO app.customers (tenant_id, full_name) VALUES ($1, 'Cliente') RETURNING id`,
      [TENANT_ID],
    );
    const sale = await sql.query(
      `INSERT INTO app.sale_orders (tenant_id, channel_id, code)
       VALUES ($1, $2, 'VTA-MAPPER-1') RETURNING id`,
      [TENANT_ID, channel.rows[0].id],
    );
    saleOrderId = sale.rows[0].id;
    // Una seña enganchada a un borrador: la FK es RESTRICT desde 0034.
    await sql.query(
      `INSERT INTO app.customer_deposits (tenant_id, customer_id, sale_order_id, amount_pyg)
       VALUES ($1, $2, $3, 100000)`,
      [TENANT_ID, customer.rows[0].id, saleOrderId],
    );

    db = new PrismaClient({ datasourceUrl: jodaApiConnectionUrl(testDb.container) });
    ctx = { userId: USER_ID, tenantId: TENANT_ID, audience: "staff", sessionId: SESSION_ID };
  }, 120_000);

  afterAll(async () => {
    await db.$disconnect();
    await testDb.stop();
  });

  async function caught(action: () => Promise<unknown>): Promise<unknown> {
    try {
      await action();
    } catch (error) {
      return error;
    }
    throw new Error("se esperaba que la operación fallara");
  }

  it("borrar con el cliente tipado de Prisma lanza P2003 con el nombre de la restricción, y se traduce a CONFLICT_ORDER_HAS_DEPOSIT", async () => {
    const error = await caught(() =>
      withTenantTx(db, ctx, (tx) => tx.sale_orders.delete({ where: { id: saleOrderId } })),
    );

    expect(isPrismaKnownError(error)).toBe(true);
    expect(mapPrismaError(error as Parameters<typeof mapPrismaError>[0])).toEqual({
      code: "CONFLICT_ORDER_HAS_DEPOSIT",
      httpStatus: 409,
      message:
        "No se puede borrar el pedido porque tiene una seña asociada. Desvinculá la seña del pedido y volvé a intentarlo.",
    });
  });

  it("el borrado fallido no pierde nada: el pedido y su seña siguen enganchados", async () => {
    await caught(() =>
      withTenantTx(db, ctx, (tx) => tx.sale_orders.delete({ where: { id: saleOrderId } })),
    );

    const rows = await testDb.superuserClient.query(
      `SELECT count(*)::int AS n FROM app.customer_deposits WHERE sale_order_id = $1`,
      [saleOrderId],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  // Documenta el límite: con SQL crudo, Prisma entrega P2010 y deja el nombre
  // de la restricción solo dentro del texto de `meta.message`, que el mapeador
  // no lee (api-conventions.md §4.4: ningún mensaje de Postgres se interpreta).
  // Sale el 409 genérico, nunca un 500; el mensaje específico es del cliente tipado.
  it("borrar con SQL crudo llega como un 409 genérico, no como un 500", async () => {
    const error = await caught(() =>
      withTenantTx(
        db,
        ctx,
        (tx) => tx.$executeRaw`DELETE FROM app.sale_orders WHERE id = ${saleOrderId}::uuid`,
      ),
    );

    expect(isPrismaKnownError(error)).toBe(true);
    expect(mapPrismaError(error as Parameters<typeof mapPrismaError>[0])).toMatchObject({
      code: "CONFLICT_FOREIGN_KEY",
      httpStatus: 409,
    });
  });
});
