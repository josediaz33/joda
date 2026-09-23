import { PrismaClient } from "@joda/db";
import { fastifyTRPCPlugin, type CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jodaApiConnectionUrl, startTestDb, type TestDb } from "../../db/testDb.js";
import { router } from "../../trpc/trpc.js";
import { createMarketRouter } from "./router.js";
import * as market from "./service.js";

const TENANT = "88888888-8888-4888-a888-888888888881";
const OTHER_TENANT = "88888888-8888-4888-a888-888888888882";
const STAFF = "99999999-9999-4999-a999-999999999981";
const OTHER_STAFF = "99999999-9999-4999-a999-999999999982";
const VARIANT = "77777777-7777-4777-a777-777777777781";
const OTHER_VARIANT = "77777777-7777-4777-a777-777777777782";
const ctx: market.MarketContext = {
  tenantId: TENANT,
  userId: STAFF,
  audience: "staff",
  auditMeta: { ip: "127.0.0.1", userAgent: "market-test", requestId: "req-market-test" },
};

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
    await testDb.superuserClient.query(
      "INSERT INTO app.staff_users (id, tenant_id, auth_subject, email, full_name) VALUES ($1, $2, 'market-other', 'market-other@test.local', 'Other')",
      [OTHER_STAFF, OTHER_TENANT],
    );
    await testDb.superuserClient.query("SELECT app.seed_roles($1)", [TENANT]);
    const ownerRole = await testDb.superuserClient.query<{ id: string }>(
      "SELECT id FROM app.roles WHERE tenant_id = $1 AND code = 'owner'",
      [TENANT],
    );
    await testDb.superuserClient.query(
      "INSERT INTO app.staff_user_roles (tenant_id, staff_user_id, role_id) VALUES ($1, $2, $3)",
      [TENANT, STAFF, ownerRole.rows[0]!.id],
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

  it("ADR-016 · no lee ni modifica proveedores y órdenes de otro tenant, ni vincula una OC propia a proveedor ajeno", async () => {
    const supplierResult = await testDb.superuserClient.query<{ id: string }>(
      "INSERT INTO app.suppliers (tenant_id, code, name) VALUES ($1, 'FOREIGN-S1', 'Ajeno') RETURNING id",
      [OTHER_TENANT],
    );
    const foreignSupplierId = supplierResult.rows[0]!.id;
    const orderResult = await testDb.superuserClient.query<{ id: string }>(
      "INSERT INTO app.purchase_orders (tenant_id, supplier_id, code, currency, created_by) VALUES ($1, $2, 'FOREIGN-PO1', 'USD', $3) RETURNING id",
      [OTHER_TENANT, foreignSupplierId, OTHER_STAFF],
    );
    const foreignOrderId = orderResult.rows[0]!.id;

    expect((await market.listSuppliers(db, ctx, {})).items.map((row) => row.id)).not.toContain(
      foreignSupplierId,
    );
    await expect(market.getSupplier(db, ctx, foreignSupplierId)).rejects.toThrow("No encontrado.");
    await expect(
      market.updateSupplier(db, ctx, { id: foreignSupplierId, notes: "No permitido" }),
    ).rejects.toThrow("No encontrado.");
    await expect(
      market.createOrder(db, ctx, {
        supplierId: foreignSupplierId,
        code: "MKT-PO-FOREIGN",
        currency: "USD",
        lines: [{ variantId: VARIANT, qtyOrdered: "1", uom: "unit", unitPriceMinor: "500" }],
      }),
    ).rejects.toThrow("El proveedor no está disponible.");
    expect((await market.listOrders(db, ctx, {})).items.map((row) => row.id)).not.toContain(
      foreignOrderId,
    );
    await expect(market.getOrder(db, ctx, foreignOrderId)).rejects.toThrow("No encontrado.");
    await expect(
      market.transitionOrder(db, ctx, { id: foreignOrderId, toStatus: "pending_approval" }),
    ).rejects.toThrow("No encontrado.");
    expect(
      (
        await testDb.superuserClient.query("SELECT status FROM app.purchase_orders WHERE id = $1", [
          foreignOrderId,
        ])
      ).rows[0].status,
    ).toBe("draft");
    expect(
      (
        await testDb.superuserClient.query(
          "SELECT count(*)::int AS n FROM app.purchase_orders WHERE tenant_id = $1 AND supplier_id = $2",
          [TENANT, foreignSupplierId],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("docs/security-spec.md §7 · audita una edición solo de país y notas con contexto de petición", async () => {
    const supplier = await market.createSupplier(db, ctx, {
      code: "MKT-S5",
      name: "Proveedor Cinco",
      defaultCurrency: "USD",
      paymentTermsDays: 0,
      country: "PY",
      notes: "Antes",
    });
    await market.updateSupplier(db, ctx, { id: supplier.id, country: "BR", notes: "Después" });
    const result = await testDb.superuserClient.query<{
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      ip: string | null;
      user_agent: string | null;
      request_id: string | null;
    }>(
      "SELECT before, after, host(ip) AS ip, user_agent, request_id FROM app.audit_log WHERE entity_id = $1 AND action = 'market.supplier.update' ORDER BY id DESC LIMIT 1",
      [supplier.id],
    );
    expect(result.rows[0]).toMatchObject({
      before: { country: "PY", notes: "Antes" },
      after: { country: "BR", notes: "Después" },
      ip: "127.0.0.1",
      user_agent: "market-test",
      request_id: "req-market-test",
    });
  });

  it("RF-MKT-03 · aprobar por HTTP rechaza permiso de escritura y acepta permiso de aprobación", async () => {
    const supplier = await market.createSupplier(db, ctx, {
      code: "MKT-S6",
      name: "Proveedor Seis",
      defaultCurrency: "USD",
      paymentTermsDays: 0,
    });
    const order = await market.createOrder(db, ctx, {
      supplierId: supplier.id,
      code: "MKT-PO-6",
      currency: "USD",
      lines: [{ variantId: VARIANT, qtyOrdered: "1", uom: "unit", unitPriceMinor: "500" }],
    });
    await market.transitionOrder(db, ctx, { id: order.id, toStatus: "pending_approval" });
    let granted = new Set(["market.purchase_order:write"]);
    const app = Fastify();
    app.register(fastifyTRPCPlugin, {
      prefix: "/trpc",
      trpcOptions: {
        router: router({ market: createMarketRouter(db) }),
        createContext: ({ req, res }: CreateFastifyContextOptions) => ({
          requestId: req.id,
          userId: STAFF,
          tenantId: TENANT,
          audience: "staff" as const,
          sessionId: null,
          mfaStatus: "satisfied" as const,
          grantedPermissions: granted,
          req,
          res,
        }),
      },
    });
    try {
      const denied = await app.inject({
        method: "POST",
        url: "/trpc/market.purchaseOrder.approve",
        payload: { id: order.id },
      });
      expect(denied.statusCode).toBe(403);
      expect((await market.getOrder(db, ctx, order.id)).status).toBe("pending_approval");
      granted = new Set(["market.purchase_order:approve"]);
      const allowed = await app.inject({
        method: "POST",
        url: "/trpc/market.purchaseOrder.approve",
        headers: { "user-agent": "market-http-test" },
        payload: { id: order.id },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().result.data.status).toBe("approved");
      const auditRow = await testDb.superuserClient.query<{
        ip: string;
        user_agent: string;
        request_id: string;
      }>(
        "SELECT host(ip) AS ip, user_agent, request_id FROM app.audit_log WHERE entity_id = $1 AND action = 'market.purchaseOrder.approve'",
        [order.id],
      );
      expect(auditRow.rows[0]).toMatchObject({ ip: "127.0.0.1", user_agent: "market-http-test" });
      expect(auditRow.rows[0]!.request_id).toBeTruthy();
    } finally {
      await app.close();
    }
  });
});
