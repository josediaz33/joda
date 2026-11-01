import { PrismaClient } from "@joda/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { releaseExpiredReservations } from "../../jobs/releaseExpiredReservations.js";
import { uuidGenerator } from "../../adapters/uuidGenerator.js";
import { jodaApiConnectionUrl, startTestDb, type TestDb } from "../../db/testDb.js";
import { withTenantTx } from "../../db/withTenantTx.js";
import type { RequestContext } from "../../trpc/context.js";
import * as decant from "../decant/service.js";
import * as inventory from "../inventory/service.js";
import * as sales from "../sales/service.js";
import { SALE_ORDER_REFERENCE, releaseReservationsOf } from "./service.js";

// Reservas de stock (WP-C18b): RF-VTA-04, RN-RES-02…07, RN-LOT-02. Postgres real
// (Testcontainers), conectado como `joda_api`: lo que no pasa por la política de
// la tabla no se prueba acá. El decant (plan que reserva, ejecución que libera)
// vive en `decant.integration.test.ts`, que ya tiene el escenario completo.
const TENANT = "c18b0000-0000-4000-a000-000000000001";
const OTHER_TENANT = "c18b0000-0000-4000-a000-000000000002";
const OWNER = "c18b0000-0000-4000-a000-0000000000a1";
const SELLER = "c18b0000-0000-4000-a000-0000000000a2";
const OTHER_OWNER = "c18b0000-0000-4000-a000-0000000000a3";
const WAREHOUSE = "c18b0000-0000-4000-a000-0000000000a4";
const OWNER_SESSION = "c18b0000-0000-4000-a000-0000000000b1";
const SELLER_SESSION = "c18b0000-0000-4000-a000-0000000000b2";
const OTHER_SESSION = "c18b0000-0000-4000-a000-0000000000b3";
const WAREHOUSE_SESSION = "c18b0000-0000-4000-a000-0000000000b4";
const CHANNEL = "c18b0000-0000-4000-a000-0000000000c1";
const OTHER_CHANNEL = "c18b0000-0000-4000-a000-0000000000c2";

const auditMeta = { ip: "127.0.0.1", userAgent: "reservations-test", requestId: "req-c18b" };
const ownerCtx: sales.SalesContext = {
  tenantId: TENANT,
  userId: OWNER,
  audience: "staff",
  sessionId: OWNER_SESSION,
  auditMeta,
};
const sellerCtx: sales.SalesContext = {
  tenantId: TENANT,
  userId: SELLER,
  audience: "staff",
  sessionId: SELLER_SESSION,
  auditMeta,
};
// El depósito: lee y mueve stock, pero no vende (no tiene sales.order:write).
const warehouseCtx: sales.SalesContext = {
  tenantId: TENANT,
  userId: WAREHOUSE,
  audience: "staff",
  sessionId: WAREHOUSE_SESSION,
  auditMeta,
};
const otherCtx: sales.SalesContext = {
  tenantId: OTHER_TENANT,
  userId: OTHER_OWNER,
  audience: "staff",
  sessionId: OTHER_SESSION,
  auditMeta,
};

const HOUR_MS = 3_600_000;

describe(
  "WP-C18b · reservas de stock: pedidos, TTL, job de liberación y apertura de frasco",
  { timeout: 60_000 },
  () => {
    let testDb: TestDb;
    let db: PrismaClient;
    // Se fija con el reloj de la base: una reserva "viva" se mide contra `now()` de Postgres
    // (la misma fórmula que `v_stock_available`), y no se puede inyectar ahí.
    let NOW: Date;
    const clock = { now: () => NOW };
    const deps: sales.SalesServiceDeps = { clock };

    const q = <Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ) => testDb.superuserClient.query<Row>(text, values);

    let sequence = 0;
    const next = () => ++sequence;

    async function seedTenant(
      tenantId: string,
      slug: string,
      owner: string,
      session: string,
      channel: string,
    ) {
      await q(
        "INSERT INTO app.tenants (id, slug, legal_name, trade_name) VALUES ($1, $2, 'JODA', 'JODA')",
        [tenantId, slug],
      );
      await q("SELECT app.seed_roles($1)", [tenantId]);
      await q(
        "INSERT INTO app.staff_users (id, tenant_id, auth_subject, email, full_name) VALUES ($1, $2, $3, $4, 'Owner')",
        [owner, tenantId, `c18b-${slug}`, `c18b-${slug}@test.local`],
      );
      await q(
        "INSERT INTO app.staff_user_roles (tenant_id, staff_user_id, role_id) SELECT $1, $2, id FROM app.roles WHERE tenant_id = $1 AND code = 'owner'",
        [tenantId, owner],
      );
      await q(
        "INSERT INTO app.staff_sessions (id, tenant_id, staff_user_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')",
        [session, tenantId, owner],
      );
      await q(
        "INSERT INTO app.sales_channels (id, tenant_id, code, name) VALUES ($1, $2, 'presencial', 'Mostrador')",
        [channel, tenantId],
      );
    }

    /** Un producto con una variante y, si hay saldo, un lote con su recepción de compra. */
    async function seedVariant(
      tenantId: string,
      fields: {
        stock?: number;
        kind?: "accessory" | "perfume" | "watch";
        type?: "unit" | "sealed" | "bulk" | "decant";
        uom?: "unit" | "ml";
        sizeMl?: number;
        serialized?: boolean;
        madeToOrder?: boolean;
        sourceVariantId?: string;
        lotQtyInitial?: number;
      } = {},
    ): Promise<{ variantId: string; lotId: string | null }> {
      const n = next();
      const kind = fields.kind ?? "accessory";
      const product = await q<{ id: string }>(
        "INSERT INTO app.products (tenant_id, kind, slug, name) VALUES ($1, $2::app.product_kind, $3, $4) RETURNING id",
        [tenantId, kind, `c18b-${n}`, `Producto ${n}`],
      );
      if (kind === "perfume") {
        await q(
          "INSERT INTO app.perfume_details (product_id, tenant_id, concentration, nominal_volume_ml, olfactory_family) VALUES ($1, $2, 'edp', 100, 'amaderado')",
          [product.rows[0]!.id, tenantId],
        );
      }
      const uom = fields.uom ?? "unit";
      const variant = await q<{ id: string }>(
        `INSERT INTO app.product_variants
           (tenant_id, product_id, sku, variant_type, uom, size_ml, price_pyg, is_serialized, production_mode, source_variant_id)
         VALUES ($1, $2, $3, $4::app.variant_type, $5::app.uom, $6, 100000, $7, $8::app.production_mode, $9)
         RETURNING id`,
        [
          tenantId,
          product.rows[0]!.id,
          `C18B-${n}`,
          fields.type ?? "unit",
          uom,
          fields.sizeMl ?? null,
          fields.serialized ?? false,
          fields.madeToOrder ? "made_to_order" : "stocked",
          fields.sourceVariantId ?? null,
        ],
      );
      const variantId = variant.rows[0]!.id;
      if (fields.stock === undefined) return { variantId, lotId: null };
      const lotId = await seedLot(tenantId, variantId, uom, fields.stock, fields.lotQtyInitial);
      return { variantId, lotId };
    }

    async function seedLot(
      tenantId: string,
      variantId: string,
      uom: "unit" | "ml",
      qty: number,
      qtyInitial = qty,
    ): Promise<string> {
      const lot = await q<{ id: string }>(
        "INSERT INTO app.inventory_lots (tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency, fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg) VALUES ($1, $2, $3, $4::app.uom, 0, 'PYG', 1, 0, 0) RETURNING id",
        [tenantId, variantId, qtyInitial, uom],
      );
      await q(
        "INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type, total_cost_pyg) VALUES ($1, $2, $3, $4, $5::app.uom, 'purchase_receipt', 0)",
        [tenantId, lot.rows[0]!.id, variantId, qty, uom],
      );
      return lot.rows[0]!.id;
    }

    async function seedUnit(tenantId: string, variantId: string, status = "available") {
      const unit = await q<{ id: string }>(
        "INSERT INTO app.serialized_units (tenant_id, variant_id, serial_number, status) VALUES ($1, $2, $3, $4::app.serial_status) RETURNING id",
        [tenantId, variantId, `SN-${next()}`, status],
      );
      return unit.rows[0]!.id;
    }

    async function draft(
      ctx: sales.SalesContext,
      channel: string,
      lines: { variantId: string; qty: string; serialUnitId?: string }[],
    ) {
      return sales.createOrder(db, ctx, { channelId: channel, lines }, deps);
    }

    const toAwaiting = (ctx: sales.SalesContext, id: string) =>
      sales.transitionOrder(db, ctx, { id, toStatus: "awaiting_payment" }, deps);
    const cancel = (ctx: sales.SalesContext, id: string) =>
      sales.transitionOrder(db, ctx, { id, toStatus: "cancelled", reason: "Se arrepintió" }, deps);

    async function stockOf(variantId: string) {
      const row = await q<{ on_hand: string; reserved: string; available: string }>(
        "SELECT on_hand::text, reserved::text, available::text FROM app.v_stock_available WHERE variant_id = $1",
        [variantId],
      );
      const { on_hand, reserved, available } = row.rows[0]!;
      return { onHand: Number(on_hand), reserved: Number(reserved), available: Number(available) };
    }

    async function reservationRows(referenceId: string) {
      const rows = await q<{
        variant_id: string;
        lot_id: string | null;
        serial_unit_id: string | null;
        qty: string;
        reason: string;
        reference_type: string;
        expires_at: Date;
        released_at: Date | null;
        created_by: string | null;
      }>(
        "SELECT variant_id, lot_id, serial_unit_id, qty::text, reason, reference_type, expires_at, released_at, created_by FROM app.stock_reservations WHERE reference_id = $1 ORDER BY created_at, id",
        [referenceId],
      );
      return rows.rows;
    }

    async function errorOf(promise: Promise<unknown>): Promise<{
      code: string | undefined;
      details: Record<string, unknown> | undefined;
    }> {
      try {
        await promise;
      } catch (error) {
        const shaped = error as { cause?: { code?: string; details?: Record<string, unknown> } };
        return { code: shaped.cause?.code, details: shaped.cause?.details };
      }
      throw new Error("se esperaba un rechazo");
    }

    function requestContext(who: sales.SalesContext): RequestContext {
      return {
        requestId: "req-c18b",
        userId: who.userId,
        tenantId: who.tenantId,
        audience: "staff",
        sessionId: who.sessionId,
        mfaStatus: "satisfied",
        grantedPermissions: new Set<string>(),
        req: { ip: "127.0.0.1", headers: {} } as unknown as FastifyRequest,
        res: {} as unknown as FastifyReply,
      };
    }

    beforeAll(async () => {
      testDb = await startTestDb();
      NOW = (await q<{ now: Date }>("SELECT date_trunc('second', now()) AS now")).rows[0]!.now;
      await seedTenant(TENANT, "c18b-a", OWNER, OWNER_SESSION, CHANNEL);
      await seedTenant(OTHER_TENANT, "c18b-b", OTHER_OWNER, OTHER_SESSION, OTHER_CHANNEL);
      await q(
        "INSERT INTO app.staff_users (id, tenant_id, auth_subject, email, full_name) VALUES ($1, $2, 'c18b-seller', 'c18b-seller@test.local', 'Vendedor')",
        [SELLER, TENANT],
      );
      await q(
        "INSERT INTO app.staff_user_roles (tenant_id, staff_user_id, role_id) SELECT $1, $2, id FROM app.roles WHERE tenant_id = $1 AND code = 'vendedor'",
        [TENANT, SELLER],
      );
      await q(
        "INSERT INTO app.staff_sessions (id, tenant_id, staff_user_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')",
        [SELLER_SESSION, TENANT, SELLER],
      );
      // Varias conexiones: la carrera de dos aperturas necesita dos transacciones de joda_api a la vez.
      await q(
        "INSERT INTO app.staff_users (id, tenant_id, auth_subject, email, full_name) VALUES ($1, $2, 'c18b-warehouse', 'c18b-warehouse@test.local', 'Depósito')",
        [WAREHOUSE, TENANT],
      );
      await q(
        "INSERT INTO app.staff_user_roles (tenant_id, staff_user_id, role_id) SELECT $1, $2, id FROM app.roles WHERE tenant_id = $1 AND code = 'deposito'",
        [TENANT, WAREHOUSE],
      );
      await q(
        "INSERT INTO app.staff_sessions (id, tenant_id, staff_user_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')",
        [WAREHOUSE_SESSION, TENANT, WAREHOUSE],
      );
      db = new PrismaClient({
        datasourceUrl: jodaApiConnectionUrl(testDb.container, { connection_limit: "8" }),
      });
    }, 120_000);

    afterAll(async () => {
      await db?.$disconnect();
      await testDb?.stop();
    });

    // -------------------------------------------------------------------
    describe("RF-VTA-04, RN-RES-02, RN-RES-06 · pasar a awaiting_payment reserva en la misma transacción", () => {
      it("reserva por variante, sin lote, con el vencimiento de 24 h; el disponible baja y la respuesta lo muestra", async () => {
        const { variantId } = await seedVariant(TENANT, { stock: 5 });
        const order = await draft(ownerCtx, CHANNEL, [{ variantId, qty: "2" }]);
        expect(order.reservations).toEqual([]);

        const awaiting = await toAwaiting(ownerCtx, order.id);

        expect(awaiting.reservations).toEqual([
          {
            id: expect.any(String),
            variantId,
            serialUnitId: null,
            qty: "2",
            reason: "order_pending_payment",
            expiresAt: new Date(NOW.getTime() + 24 * HOUR_MS).toISOString(),
            releasedAt: null,
          },
        ]);
        expect(await stockOf(variantId)).toEqual({
          onHand: 5,
          reserved: 2,
          available: 3,
        });
        const rows = await reservationRows(order.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          lot_id: null,
          serial_unit_id: null,
          reference_type: SALE_ORDER_REFERENCE,
          created_by: OWNER,
        });
        const audit = await q<{ after: Record<string, unknown> }>(
          "SELECT after FROM app.audit_log WHERE entity_id = $1 AND action = 'sales.order.transition'",
          [order.id],
        );
        expect(audit.rows[0]!.after).toEqual({
          status: "awaiting_payment",
          reservationsCreated: 1,
        });
      });

      it("la lectura del pedido trae sus reservas, también en el listado", async () => {
        const { variantId } = await seedVariant(TENANT, { stock: 5 });
        const order = await draft(ownerCtx, CHANNEL, [{ variantId, qty: "1" }]);
        await toAwaiting(ownerCtx, order.id);

        const byId = await sales.getOrder(db, ownerCtx, order.id);
        const listed = (await sales.listOrders(db, ownerCtx, { limit: 200 })).items.find(
          (item) => item.id === order.id,
        );

        expect(byId.reservations).toHaveLength(1);
        expect(listed?.reservations).toEqual(byId.reservations);
      });

      it("RN-RES-02 · el TTL es del tenant: con 48 h configuradas vence a las 48 h, y el otro tenant sigue en 24", async () => {
        await q("UPDATE app.tenants SET reservation_ttl_hours = 48 WHERE id = $1", [OTHER_TENANT]);
        const mine = await seedVariant(TENANT, { stock: 5 });
        const theirs = await seedVariant(OTHER_TENANT, { stock: 5 });
        const myOrder = await draft(ownerCtx, CHANNEL, [{ variantId: mine.variantId, qty: "1" }]);
        const theirOrder = await draft(otherCtx, OTHER_CHANNEL, [
          { variantId: theirs.variantId, qty: "1" },
        ]);

        const mineAwaiting = await toAwaiting(ownerCtx, myOrder.id);
        const theirsAwaiting = await toAwaiting(otherCtx, theirOrder.id);

        expect(mineAwaiting.reservations[0]!.expiresAt).toBe(
          new Date(NOW.getTime() + 24 * HOUR_MS).toISOString(),
        );
        expect(theirsAwaiting.reservations[0]!.expiresAt).toBe(
          new Date(NOW.getTime() + 48 * HOUR_MS).toISOString(),
        );
        await q("UPDATE app.tenants SET reservation_ttl_hours = 24 WHERE id = $1", [OTHER_TENANT]);
      });

      it("RN-RES-03 · el segundo pedido ve el disponible que dejó el primero: 3 en stock, 2 + 2 no caben", async () => {
        const { variantId } = await seedVariant(TENANT, { stock: 3 });
        const first = await draft(ownerCtx, CHANNEL, [{ variantId, qty: "2" }]);
        const second = await draft(ownerCtx, CHANNEL, [{ variantId, qty: "2" }]);
        await toAwaiting(ownerCtx, first.id);

        const error = await errorOf(toAwaiting(ownerCtx, second.id));

        expect(error.code).toBe("CONFLICT_INSUFFICIENT_STOCK");
        expect(error.details).toEqual({
          shortages: [{ variantId, sku: expect.any(String), requested: 2, available: 1 }],
        });
        expect((await sales.getOrder(db, ownerCtx, second.id)).status).toBe("draft");
        expect(await reservationRows(second.id)).toEqual([]);
      });

      it("dos líneas de la misma variante se suman contra el disponible: 3 + 3 no caben en 5", async () => {
        const { variantId } = await seedVariant(TENANT, { stock: 5 });
        const order = await draft(ownerCtx, CHANNEL, [
          { variantId, qty: "3" },
          { variantId, qty: "3" },
        ]);

        const error = await errorOf(toAwaiting(ownerCtx, order.id));

        expect(error.code).toBe("CONFLICT_INSUFFICIENT_STOCK");
        expect(error.details).toEqual({
          shortages: [{ variantId, sku: expect.any(String), requested: 6, available: 5 }],
        });
      });

      it("RN-RES-07 · dos pedidos que piden a la vez más de lo que hay no reservan los dos: con 3 en stock, 2 + 2 deja pasar uno solo", async () => {
        const { variantId } = await seedVariant(TENANT, { stock: 3 });
        const first = await draft(ownerCtx, CHANNEL, [{ variantId, qty: "2" }]);
        const second = await draft(ownerCtx, CHANNEL, [{ variantId, qty: "2" }]);

        const outcomes = await Promise.allSettled([
          toAwaiting(ownerCtx, first.id),
          toAwaiting(sellerCtx, second.id),
        ]);

        expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
        expect(await stockOf(variantId)).toEqual({ onHand: 3, reserved: 2, available: 1 });
      });

      it("todo o nada: si una línea no alcanza no se reserva ninguna de las que sí, ni cambia el estado", async () => {
        const enough = await seedVariant(TENANT, { stock: 10 });
        const scarce = await seedVariant(TENANT, { stock: 1 });
        const order = await draft(ownerCtx, CHANNEL, [
          { variantId: enough.variantId, qty: "2" },
          { variantId: scarce.variantId, qty: "5" },
        ]);

        const error = await errorOf(toAwaiting(ownerCtx, order.id));

        expect(error.code).toBe("CONFLICT_INSUFFICIENT_STOCK");
        expect(await reservationRows(order.id)).toEqual([]);
        expect((await stockOf(enough.variantId)).reserved).toBe(0);
        expect((await sales.getOrder(db, ownerCtx, order.id)).status).toBe("draft");
      });

      it("una variante que nunca tuvo un lote (sin fila en el disponible) no se reserva", async () => {
        const { variantId } = await seedVariant(TENANT);
        const order = await draft(ownerCtx, CHANNEL, [{ variantId, qty: "1" }]);

        const error = await errorOf(toAwaiting(ownerCtx, order.id));

        expect(error.code).toBe("CONFLICT_INSUFFICIENT_STOCK");
        expect(error.details).toEqual({
          shortages: [{ variantId, sku: expect.any(String), requested: 1, available: 0 }],
        });
      });

      it("RN-RES-06 · un decant bajo pedido no reserva con el pedido: su compromiso es el plan del fraccionamiento", async () => {
        const bulk = await seedVariant(TENANT, { kind: "perfume", type: "bulk", uom: "ml" });
        const decant = await seedVariant(TENANT, {
          kind: "perfume",
          type: "decant",
          uom: "ml",
          sizeMl: 10,
          madeToOrder: true,
          sourceVariantId: bulk.variantId,
        });
        const common = await seedVariant(TENANT, { stock: 5 });
        const order = await draft(ownerCtx, CHANNEL, [
          { variantId: decant.variantId, qty: "3" },
          { variantId: common.variantId, qty: "1" },
        ]);

        const awaiting = await toAwaiting(ownerCtx, order.id);

        expect(awaiting.status).toBe("awaiting_payment");
        expect(awaiting.reservations.map((reservation) => reservation.variantId)).toEqual([
          common.variantId,
        ]);
      });

      it("el vendedor sembrado reserva (la política de la tabla le da sales.order:write) y nada de lo que ve es un costo", async () => {
        const { variantId } = await seedVariant(TENANT, { stock: 5 });
        const order = await draft(sellerCtx, CHANNEL, [{ variantId, qty: "1" }]);

        const awaiting = await toAwaiting(sellerCtx, order.id);

        expect(awaiting.reservations).toHaveLength(1);
        expect((await reservationRows(order.id))[0]!.created_by).toBe(SELLER);
        const keys = JSON.stringify(awaiting).match(/"[A-Za-z_]+":/g) ?? [];
        expect(
          keys.filter((key) => /cost|landed|supplier|margin|fx_?rate|cogs/i.test(key)),
        ).toEqual([]);
      });
    });

    // -------------------------------------------------------------------
    describe("RN-RES-04, RN-RES-06 · cancelar suelta las reservas", () => {
      it("marca released_at con el reloj, conserva la fila y devuelve el disponible", async () => {
        const { variantId } = await seedVariant(TENANT, { stock: 4 });
        const order = await draft(ownerCtx, CHANNEL, [{ variantId, qty: "3" }]);
        await toAwaiting(ownerCtx, order.id);
        expect((await stockOf(variantId)).available).toBe(1);

        const cancelled = await cancel(ownerCtx, order.id);

        expect(cancelled.reservations).toEqual([
          expect.objectContaining({ qty: "3", releasedAt: NOW.toISOString() }),
        ]);
        expect(await stockOf(variantId)).toEqual({
          onHand: 4,
          reserved: 0,
          available: 4,
        });
        expect(await reservationRows(order.id)).toHaveLength(1);
        const audit = await q<{ after: Record<string, unknown> }>(
          "SELECT after FROM app.audit_log WHERE entity_id = $1 AND action = 'sales.order.transition' ORDER BY id DESC LIMIT 1",
          [order.id],
        );
        expect(audit.rows[0]!.after).toEqual({ status: "cancelled", reservationsReleased: 1 });
      });

      it("lo liberado se vuelve a reservar: el pedido siguiente entra donde el cancelado ocupaba", async () => {
        const { variantId } = await seedVariant(TENANT, { stock: 2 });
        const first = await draft(ownerCtx, CHANNEL, [{ variantId, qty: "2" }]);
        const second = await draft(ownerCtx, CHANNEL, [{ variantId, qty: "2" }]);
        await toAwaiting(ownerCtx, first.id);
        expect((await errorOf(toAwaiting(ownerCtx, second.id))).code).toBe(
          "CONFLICT_INSUFFICIENT_STOCK",
        );

        await cancel(ownerCtx, first.id);
        const awaiting = await toAwaiting(ownerCtx, second.id);

        expect(awaiting.reservations).toHaveLength(1);
      });

      it("cancelar un borrador no tiene reservas que soltar", async () => {
        const { variantId } = await seedVariant(TENANT, { stock: 1 });
        const order = await draft(ownerCtx, CHANNEL, [{ variantId, qty: "1" }]);

        const cancelled = await cancel(ownerCtx, order.id);

        expect(cancelled.reservations).toEqual([]);
        const audit = await q<{ after: Record<string, unknown> }>(
          "SELECT after FROM app.audit_log WHERE entity_id = $1 AND action = 'sales.order.transition'",
          [order.id],
        );
        expect(audit.rows[0]!.after).toEqual({ status: "cancelled", reservationsReleased: 0 });
      });

      it("una reserva ya vencida pero sin liberar también se libera al cancelar", async () => {
        const { variantId } = await seedVariant(TENANT, { stock: 1 });
        const order = await draft(ownerCtx, CHANNEL, [{ variantId, qty: "1" }]);
        await toAwaiting(ownerCtx, order.id);
        await q(
          "UPDATE app.stock_reservations SET expires_at = now() - interval '1 hour' WHERE reference_id = $1",
          [order.id],
        );

        const cancelled = await cancel(ownerCtx, order.id);

        expect(cancelled.reservations[0]!.releasedAt).toBe(NOW.toISOString());
      });

      it("quien no puede liberarlas (el depósito no vende: sin sales.order:write) recibe 403 y no queda nada liberado, no un 0 en silencio", async () => {
        const { variantId } = await seedVariant(TENANT, { stock: 2 });
        const order = await draft(ownerCtx, CHANNEL, [{ variantId, qty: "1" }]);
        await toAwaiting(ownerCtx, order.id);

        const error = await errorOf(
          withTenantTx(db, warehouseCtx, (tx) =>
            releaseReservationsOf(tx, warehouseCtx, SALE_ORDER_REFERENCE, order.id, deps),
          ),
        );

        expect(error.code).toBe("FORBIDDEN_INSUFFICIENT_PERMISSION");
        expect((await reservationRows(order.id))[0]!.released_at).toBeNull();
      });

      it("RN-RES-04 · una liberada no se reactiva ni se libera dos veces: soltar de nuevo no toca nada", async () => {
        const { variantId } = await seedVariant(TENANT, { stock: 1 });
        const order = await draft(ownerCtx, CHANNEL, [{ variantId, qty: "1" }]);
        await toAwaiting(ownerCtx, order.id);
        await cancel(ownerCtx, order.id);
        const before = await reservationRows(order.id);

        const released = await withTenantTx(db, ownerCtx, (tx) =>
          releaseReservationsOf(tx, ownerCtx, SALE_ORDER_REFERENCE, order.id, {
            clock: { now: () => new Date(NOW.getTime() + HOUR_MS) },
          }),
        );

        expect(released).toBe(0);
        expect(await reservationRows(order.id)).toEqual(before);
      });
    });

    // -------------------------------------------------------------------
    describe("RN-RES-06, RN-VTA-04 · un reloj serializado reserva su unidad", () => {
      async function watchWith(units: number) {
        const { variantId } = await seedVariant(TENANT, {
          kind: "watch",
          serialized: true,
          stock: units,
        });
        const unitIds: string[] = [];
        for (let i = 0; i < units; i++) unitIds.push(await seedUnit(TENANT, variantId));
        return { variantId, unitIds };
      }

      it("reserva exactamente esa unidad, de a una, y la variante pierde una del disponible", async () => {
        const { variantId, unitIds } = await watchWith(2);
        const order = await draft(ownerCtx, CHANNEL, [
          { variantId, qty: "1", serialUnitId: unitIds[0]! },
        ]);

        const awaiting = await toAwaiting(ownerCtx, order.id);

        expect(awaiting.reservations).toEqual([
          expect.objectContaining({ variantId, serialUnitId: unitIds[0], qty: "1" }),
        ]);
        expect((await stockOf(variantId)).available).toBe(1);
      });

      it("dos borradores pueden elegir el mismo reloj, pero solo el primero lo reserva: el segundo recibe 409 y sigue en borrador", async () => {
        const { variantId, unitIds } = await watchWith(2);
        const first = await draft(ownerCtx, CHANNEL, [
          { variantId, qty: "1", serialUnitId: unitIds[0]! },
        ]);
        const second = await draft(sellerCtx, CHANNEL, [
          { variantId, qty: "1", serialUnitId: unitIds[0]! },
        ]);
        await toAwaiting(ownerCtx, first.id);

        const error = await errorOf(toAwaiting(sellerCtx, second.id));

        expect(error.code).toBe("CONFLICT_SERIAL_UNIT_RESERVED");
        expect(error.details).toEqual({ serialUnitId: unitIds[0] });
        expect((await sales.getOrder(db, ownerCtx, second.id)).status).toBe("draft");
        expect(await reservationRows(second.id)).toEqual([]);
      });

      it("cancelar el primero libera la unidad: el segundo la reserva", async () => {
        const { variantId, unitIds } = await watchWith(1);
        const first = await draft(ownerCtx, CHANNEL, [
          { variantId, qty: "1", serialUnitId: unitIds[0]! },
        ]);
        const second = await draft(ownerCtx, CHANNEL, [
          { variantId, qty: "1", serialUnitId: unitIds[0]! },
        ]);
        await toAwaiting(ownerCtx, first.id);
        await cancel(ownerCtx, first.id);

        const awaiting = await toAwaiting(ownerCtx, second.id);

        expect(awaiting.reservations[0]).toMatchObject({
          serialUnitId: unitIds[0],
          releasedAt: null,
        });
      });

      it("una unidad que se vendió después de armar el borrador se rechaza con su estado", async () => {
        const { variantId, unitIds } = await watchWith(1);
        const order = await draft(ownerCtx, CHANNEL, [
          { variantId, qty: "1", serialUnitId: unitIds[0]! },
        ]);
        await q("UPDATE app.serialized_units SET status = 'sold' WHERE id = $1", [unitIds[0]]);

        const error = await errorOf(toAwaiting(ownerCtx, order.id));

        expect(error.code).toBe("CONFLICT_SERIAL_UNIT_UNAVAILABLE");
        expect(error.details).toEqual({ serialUnitId: unitIds[0], status: "sold" });
      });

      it("la reserva vencida de la unidad, que el job todavía no liberó, no la bloquea: el pedido siguiente la libera y reserva", async () => {
        const { variantId, unitIds } = await watchWith(1);
        const first = await draft(ownerCtx, CHANNEL, [
          { variantId, qty: "1", serialUnitId: unitIds[0]! },
        ]);
        const second = await draft(ownerCtx, CHANNEL, [
          { variantId, qty: "1", serialUnitId: unitIds[0]! },
        ]);
        await toAwaiting(ownerCtx, first.id);
        await q(
          "UPDATE app.stock_reservations SET expires_at = $2::timestamptz - interval '1 minute' WHERE reference_id = $1",
          [first.id, NOW.toISOString()],
        );

        const awaiting = await toAwaiting(ownerCtx, second.id);

        expect(awaiting.reservations).toHaveLength(1);
        expect((await reservationRows(first.id))[0]!.released_at).toEqual(NOW);
      });
    });

    // -------------------------------------------------------------------
    describe("RN-RES-04 · el job libera las vencidas bajo RLS, tenant por tenant", () => {
      const AT = (hours: number) => ({ now: () => new Date(NOW.getTime() + hours * HOUR_MS) });

      async function reserveFor(
        ctx: sales.SalesContext,
        channel: string,
        tenantId: string,
      ): Promise<string> {
        const { variantId } = await seedVariant(tenantId, { stock: 5 });
        const order = await draft(ctx, channel, [{ variantId, qty: "1" }]);
        await toAwaiting(ctx, order.id);
        return order.id;
      }

      async function resetReservations() {
        await q("UPDATE app.stock_reservations SET released_at = now() WHERE released_at IS NULL");
      }

      it("libera las vencidas del tenant que corresponde con el instante del reloj y NO toca las de otro tenant que siguen vivas", async () => {
        await resetReservations();
        const mine = await reserveFor(ownerCtx, CHANNEL, TENANT);
        await q("UPDATE app.tenants SET reservation_ttl_hours = 72 WHERE id = $1", [OTHER_TENANT]);
        const theirs = await reserveFor(otherCtx, OTHER_CHANNEL, OTHER_TENANT);
        await q("UPDATE app.tenants SET reservation_ttl_hours = 24 WHERE id = $1", [OTHER_TENANT]);

        const result = await releaseExpiredReservations({ db, clock: AT(30) });

        expect(result).toEqual({ tenants: 1, released: 1, failedTenantIds: [] });
        expect((await reservationRows(mine))[0]!.released_at).toEqual(AT(30).now());
        expect((await reservationRows(theirs))[0]!.released_at).toBeNull();
      });

      it("una corrida sin nada vencido no abre ninguna transacción de tenant: la función no devuelve ningún id", async () => {
        await resetReservations();
        await reserveFor(ownerCtx, CHANNEL, TENANT);

        const result = await releaseExpiredReservations({ db, clock: AT(1) });

        expect(result).toEqual({ tenants: 0, released: 0, failedTenantIds: [] });
      });

      it("deja constancia: una fila de auditoría del sistema por tenant, sin actor", async () => {
        await resetReservations();
        const orderId = await reserveFor(ownerCtx, CHANNEL, TENANT);

        await releaseExpiredReservations({ db, clock: AT(25) });

        const audit = await q<{
          audience: string;
          actor_id: string | null;
          after: { released: number; asOf: string; reservationIds: string[] };
        }>(
          "SELECT audience::text, actor_id, after FROM app.audit_log WHERE action = 'sales.reservation.release_expired' AND tenant_id = $1 ORDER BY id DESC LIMIT 1",
          [TENANT],
        );
        expect(audit.rows[0]).toMatchObject({ audience: "system", actor_id: null });
        expect(audit.rows[0]!.after).toMatchObject({
          released: 1,
          asOf: AT(25).now().toISOString(),
        });
        expect(audit.rows[0]!.after.reservationIds).toEqual([
          (
            await q<{ id: string }>(
              "SELECT id FROM app.stock_reservations WHERE reference_id = $1",
              [orderId],
            )
          ).rows[0]!.id,
        ]);
      });

      it("una reserva ya liberada no se vuelve a liberar ni cuenta para elegir tenants", async () => {
        await resetReservations();
        const orderId = await reserveFor(ownerCtx, CHANNEL, TENANT);
        await releaseExpiredReservations({ db, clock: AT(25) });
        const releasedAt = (await reservationRows(orderId))[0]!.released_at;

        const again = await releaseExpiredReservations({ db, clock: AT(50) });

        expect(again).toEqual({ tenants: 0, released: 0, failedTenantIds: [] });
        expect((await reservationRows(orderId))[0]!.released_at).toEqual(releasedAt);
      });

      it("el job libera la unidad serializada: otro pedido la reserva sin esperar a nadie", async () => {
        await resetReservations();
        const { variantId } = await seedVariant(TENANT, {
          kind: "watch",
          serialized: true,
          stock: 1,
        });
        const unitId = await seedUnit(TENANT, variantId);
        const first = await draft(ownerCtx, CHANNEL, [
          { variantId, qty: "1", serialUnitId: unitId },
        ]);
        await toAwaiting(ownerCtx, first.id);
        await releaseExpiredReservations({ db, clock: AT(25) });
        const second = await draft(ownerCtx, CHANNEL, [
          { variantId, qty: "1", serialUnitId: unitId },
        ]);

        const awaiting = await toAwaiting(ownerCtx, second.id);

        expect(awaiting.reservations[0]).toMatchObject({ serialUnitId: unitId, releasedAt: null });
      });

      it("un tenant cuya liberación falla no frena a los demás: se anota y la corrida siguiente lo recoge", async () => {
        await resetReservations();
        const mine = await reserveFor(ownerCtx, CHANNEL, TENANT);
        await q("UPDATE app.tenants SET reservation_ttl_hours = 24 WHERE id = $1", [OTHER_TENANT]);
        const theirs = await reserveFor(otherCtx, OTHER_CHANNEL, OTHER_TENANT);
        await q(`CREATE FUNCTION app.c18b_fail() RETURNS trigger LANGUAGE plpgsql AS $$
                 BEGIN RAISE EXCEPTION 'falla simulada'; END $$`);
        await q(
          `CREATE TRIGGER c18b_fail BEFORE UPDATE ON app.stock_reservations
             FOR EACH ROW WHEN (OLD.tenant_id = '${TENANT}') EXECUTE FUNCTION app.c18b_fail()`,
        );
        const logged: Record<string, unknown>[] = [];
        try {
          const result = await releaseExpiredReservations({
            db,
            clock: AT(25),
            logger: { error: (details) => logged.push(details) },
          });

          expect(result).toEqual({ tenants: 2, released: 1, failedTenantIds: [TENANT] });
          expect(logged).toHaveLength(1);
          expect(logged[0]).toMatchObject({ tenantId: TENANT });
          expect((await reservationRows(theirs))[0]!.released_at).not.toBeNull();
          expect((await reservationRows(mine))[0]!.released_at).toBeNull();
        } finally {
          await q("DROP TRIGGER c18b_fail ON app.stock_reservations");
          await q("DROP FUNCTION app.c18b_fail()");
        }

        const retry = await releaseExpiredReservations({ db, clock: AT(26) });
        expect(retry).toEqual({ tenants: 1, released: 1, failedTenantIds: [] });
      });

      it("no espera a una reserva que otra transacción tiene tomada (SKIP LOCKED): libera el resto y la deja para la corrida siguiente", async () => {
        await resetReservations();
        const lockedOrder = await reserveFor(ownerCtx, CHANNEL, TENANT);
        const freeOrder = await reserveFor(ownerCtx, CHANNEL, TENANT);
        await q("BEGIN");
        try {
          await q("SELECT id FROM app.stock_reservations WHERE reference_id = $1 FOR UPDATE", [
            lockedOrder,
          ]);

          const result = await releaseExpiredReservations({ db, clock: AT(25) });

          expect(result).toEqual({ tenants: 1, released: 1, failedTenantIds: [] });
          expect((await reservationRows(freeOrder))[0]!.released_at).not.toBeNull();
        } finally {
          await q("COMMIT");
        }
        expect((await reservationRows(lockedOrder))[0]!.released_at).toBeNull();

        const next = await releaseExpiredReservations({ db, clock: AT(26) });
        expect(next).toEqual({ tenants: 1, released: 1, failedTenantIds: [] });
      });
    });

    // -------------------------------------------------------------------
    describe("RN-FRA-02, RN-RES-07 · planificar dos decants a la vez sobre el mismo granel", () => {
      async function decantScenario(bulkMl: number) {
        const product = await q<{ id: string }>(
          "INSERT INTO app.products (tenant_id, kind, slug, name) VALUES ($1, 'perfume', $2, 'Layton') RETURNING id",
          [TENANT, `c18b-decant-${next()}`],
        );
        const productId = product.rows[0]!.id;
        await q(
          "INSERT INTO app.perfume_details (product_id, tenant_id, concentration, nominal_volume_ml, olfactory_family, waste_factor) VALUES ($1, $2, 'edp', 100, 'amaderado', 0.02)",
          [productId, TENANT],
        );
        const variant = async (
          type: string,
          uom: string,
          sizeMl: number | null,
          source?: string,
        ) => {
          const row = await q<{ id: string }>(
            `INSERT INTO app.product_variants
               (tenant_id, product_id, sku, variant_type, uom, size_ml, price_pyg, production_mode, source_variant_id)
             VALUES ($1, $2, $3, $4::app.variant_type, $5::app.uom, $6, 0, $7::app.production_mode, $8) RETURNING id`,
            [
              TENANT,
              productId,
              `C18B-D${next()}`,
              type,
              uom,
              sizeMl,
              source ? "made_to_order" : "stocked",
              source ?? null,
            ],
          );
          return row.rows[0]!.id;
        };
        const bulk = await variant("bulk", "ml", null);
        const target = await variant("decant", "ml", 10, bulk);
        const vial = await variant("supply", "unit", null);
        await q(
          "INSERT INTO app.bom_components (tenant_id, parent_variant_id, component_variant_id, qty_per_unit, uom) VALUES ($1, $2, $3, 1, 'unit')",
          [TENANT, target, vial],
        );
        const bulkLot = await seedLot(TENANT, bulk, "ml", bulkMl);
        await q(
          "UPDATE app.inventory_lots SET status = 'open_for_decant', opened_at = now() WHERE id = $1",
          [bulkLot],
        );
        await seedLot(TENANT, vial, "unit", 50);
        return { bulk, target, vial, bulkLot };
      }

      it("con granel para un solo plan, dos planes simultáneos: uno reserva y el otro se rechaza (sin el bloqueo de la variante pasaban los dos)", async () => {
        const scenario = await decantScenario(15);
        const first = await draft(ownerCtx, CHANNEL, [{ variantId: scenario.vial, qty: "1" }]);
        const second = await draft(ownerCtx, CHANNEL, [{ variantId: scenario.vial, qty: "1" }]);
        const plan = (saleOrderId: string) =>
          decant.planWorkOrder(db, { clock }, requestContext(ownerCtx), {
            saleOrderId,
            targetVariantId: scenario.target,
            qtyUnits: 1,
          });

        const outcomes = await Promise.allSettled([plan(first.id), plan(second.id)]);

        expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
        const reserved = await q<{ ml: string }>(
          "SELECT COALESCE(sum(qty), 0)::text AS ml FROM app.stock_reservations WHERE lot_id = $1 AND released_at IS NULL",
          [scenario.bulkLot],
        );
        expect(Number(reserved.rows[0]!.ml)).toBe(10.2);
      });
    });

    // -------------------------------------------------------------------
    describe("RN-LOT-02, RN-RES-03, RN-RES-06 · la apertura de frasco respeta las reservas", () => {
      const inventoryDeps = { clock, idGenerator: uuidGenerator };

      async function sealedPerfume(lots: number[]) {
        const bulk = await seedVariant(TENANT, { kind: "perfume", type: "bulk", uom: "ml" });
        const sealed = await seedVariant(TENANT, {
          kind: "perfume",
          type: "sealed",
          sizeMl: 100,
        });
        // El granel y el sellado son del mismo producto (la apertura busca el granel del producto).
        await q(
          "UPDATE app.product_variants SET product_id = (SELECT product_id FROM app.product_variants WHERE id = $2) WHERE id = $1",
          [bulk.variantId, sealed.variantId],
        );
        const lotIds: string[] = [];
        for (const qty of lots) lotIds.push(await seedLot(TENANT, sealed.variantId, "unit", qty));
        return { sealedVariantId: sealed.variantId, bulkVariantId: bulk.variantId, lotIds };
      }

      const openLot = (lotId: string) =>
        inventory.openLot(db, inventoryDeps, requestContext(ownerCtx), { lotId });

      it("el último frasco, reservado por un pedido, no se abre: 409 CONFLICT_INSUFFICIENT_STOCK; al cancelar el pedido, sí", async () => {
        const { sealedVariantId, lotIds } = await sealedPerfume([1]);
        const order = await draft(ownerCtx, CHANNEL, [{ variantId: sealedVariantId, qty: "1" }]);
        await toAwaiting(ownerCtx, order.id);

        const error = await errorOf(openLot(lotIds[0]!));
        expect(error.code).toBe("CONFLICT_INSUFFICIENT_STOCK");

        await cancel(ownerCtx, order.id);
        const opened = await openLot(lotIds[0]!);
        expect(opened.bulkLot.qtyInitial).toBe(100);
      });

      it("un lote con una reserva viva propia (atada a su lot_id) no se abre, aunque la variante tenga otros frascos libres", async () => {
        const { sealedVariantId, lotIds } = await sealedPerfume([1, 1]);
        const reservation = await q<{ id: string }>(
          "INSERT INTO app.stock_reservations (tenant_id, variant_id, lot_id, qty, reason, expires_at) VALUES ($1, $2, $3, 1, 'checkout', now() + interval '1 hour') RETURNING id",
          [TENANT, sealedVariantId, lotIds[0]],
        );

        const error = await errorOf(openLot(lotIds[0]!));
        expect(error.code).toBe("CONFLICT_LOT_RESERVED");

        // El otro lote de la variante sí se abre: el disponible de la variante alcanza.
        const other = await openLot(lotIds[1]!);
        expect(other.bulkLot.qtyInitial).toBe(100);

        // Liberada la reserva, el primero también.
        await q("UPDATE app.stock_reservations SET released_at = now() WHERE id = $1", [
          reservation.rows[0]!.id,
        ]);
        await q("UPDATE app.inventory_lots SET status = 'available' WHERE id = $1", [lotIds[0]]);
        const opened = await openLot(lotIds[0]!);
        expect(opened.openedSealedLot.status).toBe("open_for_decant");
      });

      it("una reserva atada al lote que ya venció no cuenta: el lote se abre", async () => {
        const { sealedVariantId, lotIds } = await sealedPerfume([1]);
        await q(
          "INSERT INTO app.stock_reservations (tenant_id, variant_id, lot_id, qty, reason, expires_at) VALUES ($1, $2, $3, 1, 'checkout', now() - interval '1 minute')",
          [TENANT, sealedVariantId, lotIds[0]],
        );

        const opened = await openLot(lotIds[0]!);

        expect(opened.openedSealedLot.status).toBe("open_for_decant");
      });

      it("RN-RES-07 · dos aperturas de lotes distintos de la misma variante con el último frasco reservado: pasa una sola", async () => {
        const { sealedVariantId, lotIds } = await sealedPerfume([1, 1]);
        const order = await draft(ownerCtx, CHANNEL, [{ variantId: sealedVariantId, qty: "1" }]);
        await toAwaiting(ownerCtx, order.id);
        // 2 frascos, 1 reservado: queda 1 disponible, y los dos lotes lo ven si no se bloquea la variante.

        const outcomes = await Promise.allSettled([openLot(lotIds[0]!), openLot(lotIds[1]!)]);

        expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
        const opened = await q<{ n: number }>(
          "SELECT count(*)::int AS n FROM app.inventory_lots WHERE variant_id = $1 AND status = 'open_for_decant'",
          [sealedVariantId],
        );
        expect(opened.rows[0]!.n).toBe(1);
      });
    });
  },
);
