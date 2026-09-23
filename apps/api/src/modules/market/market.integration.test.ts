import { PrismaClient } from "@joda/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jodaApiConnectionUrl, startTestDb, type TestDb } from "../../db/testDb.js";
import type { TenantTxContext } from "../../db/withTenantTx.js";
import * as market from "./service.js";

const TENANT = "88888888-8888-4888-a888-888888888881";
const OTHER_TENANT = "88888888-8888-4888-a888-888888888882";
const STAFF = "99999999-9999-4999-a999-999999999981";
const VARIANT = "77777777-7777-4777-a777-777777777781";
const OTHER_VARIANT = "77777777-7777-4777-a777-777777777782";
const ctx: TenantTxContext = { tenantId: TENANT, userId: STAFF, audience: "staff" };

describe("RF-MKT-01…03 · proveedores y órdenes de compra (RN-EST-01)", () => {
  let testDb: TestDb;
  let db: PrismaClient;

  beforeAll(async () => {
    testDb = await startTestDb();
    for (const [id, slug] of [
      [TENANT, "market-a"],
      [OTHER_TENANT, "market-b"],
    ]) {
      await testDb.superuserClient.query(
        "INSERT INTO app.tenants (id, slug, legal_name, trade_name) VALUES ($1, $2, 'JODA', 'JODA')",
        [id, slug],
      );
    }
    await testDb.superuserClient.query(
      "INSERT INTO app.staff_users (id, tenant_id, auth_subject, email, full_name) VALUES ($1, $2, 'market-owner', 'market-owner@test.local', 'Owner')",
      [STAFF, TENANT],
    );
    for (const [tenant, variant, suffix] of [
      [TENANT, VARIANT, "a"],
      [OTHER_TENANT, OTHER_VARIANT, "b"],
    ]) {
      const product = await testDb.superuserClient.query<{ id: string }>(
        "INSERT INTO app.products (tenant_id, kind, slug, name) VALUES ($1, 'accessory', $2, 'Test') RETURNING id",
        [tenant, `market-${suffix}`],
      );
      await testDb.superuserClient.query(
        "INSERT INTO app.product_variants (id, tenant_id, product_id, sku, variant_type, uom, price_pyg) VALUES ($1, $2, $3, $4, 'unit', 'unit', 1000)",
        [variant, tenant, product.rows[0]!.id, `market-${suffix}`],
      );
    }
    db = new PrismaClient({ datasourceUrl: jodaApiConnectionUrl(testDb.container) });
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
    await testDb?.stop();
  });

  it("RF-MKT-01 · crea y edita moneda, plazo y tiempo de entrega del proveedor", async () => {
    const created = await market.createSupplier(db, ctx, {
      code: "MKT-S1",
      name: "Proveedor Uno",
      defaultCurrency: "USD",
      paymentTermsDays: 30,
      leadTimeDays: 14,
    });
    expect(created).toMatchObject({
      code: "MKT-S1",
      defaultCurrency: "USD",
      paymentTermsDays: 30,
      leadTimeDays: 14,
    });
    const updated = await market.updateSupplier(db, ctx, {
      id: created.id,
      paymentTermsDays: 45,
      leadTimeDays: 21,
    });
    expect(updated).toMatchObject({ paymentTermsDays: 45, leadTimeDays: 21 });
    expect(
      (await market.listSuppliers(db, ctx, {})).items.some(
        (supplier) => supplier.id === created.id,
      ),
    ).toBe(true);
  });

  it("RF-MKT-02…03 · crea OC multilínea en USD, audita cada transición y no mueve stock", async () => {
    const supplier = await market.createSupplier(db, ctx, {
      code: "MKT-S2",
      name: "Proveedor Dos",
      defaultCurrency: "USD",
      paymentTermsDays: 0,
    });
    const order = await market.createOrder(db, ctx, {
      supplierId: supplier.id,
      code: "MKT-PO-1",
      currency: "USD",
      fxRateToPyg: "7200.50000000",
      lines: [
        { variantId: VARIANT, qtyOrdered: "2", uom: "unit", unitPriceMinor: "12345" },
        { variantId: VARIANT, qtyOrdered: "3", uom: "unit", unitPriceMinor: "9999" },
      ],
    });
    expect(order.lines).toHaveLength(2);
    expect(order.transitions).toMatchObject([
      { fromStatus: null, toStatus: "draft", actorId: STAFF },
    ]);
    const pending = await market.transitionOrder(db, ctx, {
      id: order.id,
      toStatus: "pending_approval",
    });
    const approved = await market.transitionOrder(db, ctx, { id: order.id, toStatus: "approved" });
    const sent = await market.transitionOrder(db, ctx, { id: order.id, toStatus: "sent" });
    expect([pending.status, approved.status, sent.status]).toEqual([
      "pending_approval",
      "approved",
      "sent",
    ]);
    expect(sent.approvedBy).toBe(STAFF);
    expect(sent.transitions.map((transition) => transition.toStatus)).toEqual([
      "draft",
      "pending_approval",
      "approved",
      "sent",
    ]);
    expect(
      (await testDb.superuserClient.query("SELECT count(*)::int AS n FROM app.inventory_movements"))
        .rows[0].n,
    ).toBe(0);
    expect(
      (
        await testDb.superuserClient.query(
          "SELECT count(*)::int AS n FROM app.audit_log WHERE entity_id = $1",
          [order.id],
        )
      ).rows[0].n,
    ).toBe(4);
  });

  it("RN-EST-01 · rechaza transición inválida con estado de origen y destino", async () => {
    const supplier = await market.createSupplier(db, ctx, {
      code: "MKT-S3",
      name: "Proveedor Tres",
      defaultCurrency: "BRL",
      paymentTermsDays: 0,
    });
    const order = await market.createOrder(db, ctx, {
      supplierId: supplier.id,
      code: "MKT-PO-2",
      currency: "BRL",
      lines: [{ variantId: VARIANT, qtyOrdered: "1", uom: "unit", unitPriceMinor: "500" }],
    });
    await expect(
      market.transitionOrder(db, ctx, { id: order.id, toStatus: "sent" }),
    ).rejects.toThrow("La orden no puede pasar de draft a sent.");
    expect((await market.getOrder(db, ctx, order.id)).transitions).toHaveLength(1);
  });

  it("RF-MKT-02 · rechaza variante de otro tenant antes de insertar líneas", async () => {
    const supplier = await market.createSupplier(db, ctx, {
      code: "MKT-S4",
      name: "Proveedor Cuatro",
      defaultCurrency: "USD",
      paymentTermsDays: 0,
    });
    await expect(
      market.createOrder(db, ctx, {
        supplierId: supplier.id,
        code: "MKT-PO-3",
        currency: "USD",
        lines: [{ variantId: OTHER_VARIANT, qtyOrdered: "1", uom: "unit", unitPriceMinor: "500" }],
      }),
    ).rejects.toThrow("Una variante no está disponible.");
    expect((await market.listOrders(db, ctx, { supplierId: supplier.id })).items).toHaveLength(0);
  });
});
