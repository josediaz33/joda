import { PrismaClient } from "@joda/db";
import { fastifyTRPCPlugin, type CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import Fastify from "fastify";
import { Client } from "pg";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidGenerator } from "../../adapters/uuidGenerator.js";
import type { IdempotencyRequest } from "../../db/withIdempotentTx.js";
import { withTenantTx } from "../../db/withTenantTx.js";
import { jodaApiConnectionUrl, startTestDb, type TestDb } from "../../db/testDb.js";
import { API_IDEMPOTENCY_SCOPE, hashIdempotencyRequestBody } from "../../middleware/idempotency.js";
import { router } from "../../trpc/trpc.js";
import type { RequestContext } from "../../trpc/context.js";
import * as decant from "../decant/service.js";
import * as inventory from "../inventory/service.js";
import { createSalesRouter } from "./router.js";
import * as sales from "./service.js";

// RF-VTA-05 y RF-VTA-06 (WP-C19): confirmar el pago consume el inventario, calcula
// el COGS por capas y lo persiste, todo en una transacción, sin que el vendedor lea
// un costo. Postgres real, el rol `joda_api` y el vendedor sembrado de verdad:
// quien confirma es el que NO tiene `inventory.stock:read`, así que cada prueba
// que pasa con él prueba también `app.list_sale_allocation_lots` (0042) y la
// escritura sin `RETURNING` (0037, 0039).
//
// El reloj va en 2099: las reservas vencen según el `now()` de la base (el real),
// y un reloj anterior las dejaría vencidas al nacer.
const TENANT = "c1900000-0000-4000-a000-000000000001";
const OTHER_TENANT = "c1900000-0000-4000-a000-000000000002";
const OWNER = "c1900000-0000-4000-a000-0000000000a1";
const SELLER = "c1900000-0000-4000-a000-0000000000a2";
const READER = "c1900000-0000-4000-a000-0000000000a3";
const OTHER_OWNER = "c1900000-0000-4000-a000-0000000000a4";
const OWNER_SESSION = "c1900000-0000-4000-a000-0000000000b1";
const SELLER_SESSION = "c1900000-0000-4000-a000-0000000000b2";
const READER_SESSION = "c1900000-0000-4000-a000-0000000000b3";
const OTHER_SESSION = "c1900000-0000-4000-a000-0000000000b4";
const CHANNEL = "c1900000-0000-4000-a000-0000000000c1";
const OTHER_CHANNEL = "c1900000-0000-4000-a000-0000000000c2";

// Para el orden de bloqueo: G < L < H. El de id bajo es el que retiene la compuerta.
const triplet = (tag: string) => ({
  gate: `00000000-0000-4000-8000-000000${tag}01`,
  low: `70000000-0000-4000-8000-000000${tag}02`,
  high: `ffffffff-0000-4000-8000-000000${tag}03`,
});

const NOW = new Date("2099-06-15T12:00:00.000Z");
const clock = { now: () => NOW };
const deps: sales.SalesServiceDeps = { clock };
const auditMeta = { ip: "127.0.0.1", userAgent: "confirm-test", requestId: "req-confirm" };
const ctxOf = (userId: string, sessionId: string, tenantId = TENANT): sales.SalesContext => ({
  tenantId,
  userId,
  audience: "staff",
  sessionId,
  auditMeta,
});
const ownerCtx = ctxOf(OWNER, OWNER_SESSION);
const sellerCtx = ctxOf(SELLER, SELLER_SESSION);
const otherCtx = ctxOf(OTHER_OWNER, OTHER_SESSION, OTHER_TENANT);

interface Rejection {
  readonly code: string;
  readonly httpStatus: number;
  readonly text: string;
}

describe(
  "RF-VTA-05 / RF-VTA-06 · confirmar el pago consume el inventario con COGS por capas (WP-C19)",
  { timeout: 120_000 },
  () => {
    let testDb: TestDb;
    let db: PrismaClient;
    let probe: Client;
    let counter = 0;

    const q = <Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ) => testDb.superuserClient.query<Row>(text, values);

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // -------------------------------------------------------------------
    // Siembra
    // -------------------------------------------------------------------
    interface VariantOptions {
      id?: string;
      type?: "unit" | "sealed" | "bulk" | "decant" | "supply";
      kind?: "accessory" | "perfume" | "watch";
      uom?: "unit" | "ml";
      serialized?: boolean;
      policy?: "fifo" | "fefo" | "serial" | "manual";
      price?: number;
      sizeMl?: number;
      madeToOrder?: boolean;
      sourceVariantId?: string;
      productId?: string;
    }

    async function seedProduct(kind: "accessory" | "perfume" | "watch"): Promise<string> {
      const n = ++counter;
      const product = await q<{ id: string }>(
        "INSERT INTO app.products (tenant_id, kind, slug, name) VALUES ($1, $2::app.product_kind, $3, $4) RETURNING id",
        [TENANT, kind, `c19-${n}`, `Producto ${n}`],
      );
      const id = product.rows[0]!.id;
      if (kind === "perfume") {
        await q(
          "INSERT INTO app.perfume_details (product_id, tenant_id, concentration, nominal_volume_ml, olfactory_family, waste_factor) VALUES ($1, $2, 'edp', 100, 'amaderado', 0.02)",
          [id, TENANT],
        );
      }
      if (kind === "watch") {
        await q(
          "INSERT INTO app.watch_details (product_id, tenant_id, movement, case_material, requires_serial) VALUES ($1, $2, 'quartz', 'acero', true)",
          [id, TENANT],
        );
      }
      return id;
    }

    async function seedVariant(options: VariantOptions = {}): Promise<string> {
      const n = ++counter;
      const productId = options.productId ?? (await seedProduct(options.kind ?? "accessory"));
      const variant = await q<{ id: string }>(
        `INSERT INTO app.product_variants
           (id, tenant_id, product_id, sku, variant_type, uom, size_ml, price_pyg, is_serialized,
            allocation_policy, production_mode, source_variant_id)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5::app.variant_type, $6::app.uom, $7, $8, $9,
                 $10::app.allocation_policy, $11::app.production_mode, $12)
         RETURNING id`,
        [
          options.id ?? null,
          TENANT,
          productId,
          `C19-${n}`,
          options.type ?? "unit",
          options.uom ?? "unit",
          options.sizeMl ?? null,
          options.price ?? 100_000,
          options.serialized ?? false,
          options.policy ?? "fifo",
          options.madeToOrder ? "made_to_order" : "stocked",
          options.sourceVariantId ?? null,
        ],
      );
      return variant.rows[0]!.id;
    }

    interface LotOptions {
      receivedAt?: string;
      expiryAt?: string;
      status?: "available" | "open_for_decant" | "quarantine";
      uom?: "unit" | "ml";
      openedAt?: string;
      /** Para controlar el orden de `id`: las capas de una línea salen por id de lote ascendente (RN-LOT-05). */
      id?: string;
    }

    /** Un lote con su recepción: el saldo lo proyecta el trigger a partir del movimiento. */
    async function seedLot(
      variantId: string,
      qty: number,
      unitCostPyg: number,
      options: LotOptions = {},
    ): Promise<string> {
      const uom = options.uom ?? "unit";
      const lot = await q<{ id: string }>(
        `INSERT INTO app.inventory_lots
           (id, tenant_id, variant_id, status, qty_initial, uom, unit_cost_minor, currency, fx_rate_to_pyg,
            landed_cost_pyg, unit_landed_cost_pyg, received_at, expiry_at, opened_at)
         VALUES (COALESCE($11::uuid, gen_random_uuid()), $1, $2, $3::app.lot_status, $4, $5::app.uom, $6, 'PYG', 1, $7, $12,
                 COALESCE($8::timestamptz, now()), $9::date, $10::timestamptz)
         RETURNING id`,
        [
          TENANT,
          variantId,
          options.status ?? "available",
          qty,
          uom,
          unitCostPyg,
          Math.round(qty * unitCostPyg),
          options.receivedAt ?? null,
          options.expiryAt ?? null,
          options.openedAt ?? null,
          options.id ?? null,
          unitCostPyg,
        ],
      );
      const lotId = lot.rows[0]!.id;
      await q(
        "INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type, total_cost_pyg) VALUES ($1, $2, $3, $4, $5::app.uom, 'purchase_receipt', $6)",
        [TENANT, lotId, variantId, qty, uom, Math.round(qty * unitCostPyg)],
      );
      return lotId;
    }

    async function seedUnit(
      variantId: string,
      lotId: string | null,
      serial: string,
      status = "available",
    ): Promise<string> {
      const unit = await q<{ id: string }>(
        "INSERT INTO app.serialized_units (tenant_id, variant_id, lot_id, serial_number, status) VALUES ($1, $2, $3, $4, $5::app.serial_status) RETURNING id",
        [TENANT, variantId, lotId, serial, status],
      );
      return unit.rows[0]!.id;
    }

    /** Un pedido en `awaiting_payment` con sus reservas (lo deja listo para confirmar). */
    async function awaiting(
      lines: { variantId: string; qty: string; serialUnitId?: string }[],
      discountPyg?: string,
    ): Promise<{ id: string }> {
      const order = await sales.createOrder(
        db,
        ownerCtx,
        { channelId: CHANNEL, lines, ...(discountPyg && { discountPyg }) },
        deps,
      );
      await sales.transitionOrder(
        db,
        ownerCtx,
        { id: order.id, toStatus: "awaiting_payment" },
        deps,
      );
      return { id: order.id };
    }

    const confirm = (id: string, who: sales.SalesContext = sellerCtx) =>
      sales.confirmOrder(db, who, { id }, deps, null);

    async function rejection(promise: Promise<unknown>): Promise<Rejection> {
      try {
        await promise;
      } catch (error) {
        const cause = (error as { cause?: { code?: string; httpStatus?: number } }).cause;
        return {
          code: cause?.code ?? "SIN_CODIGO",
          httpStatus: cause?.httpStatus ?? 0,
          text: JSON.stringify({ message: (error as Error).message, cause }),
        };
      }
      throw new Error("se esperaba un rechazo y la operación terminó");
    }

    // -------------------------------------------------------------------
    // Lecturas del ledger (superusuario: lo que el vendedor NO puede leer)
    // -------------------------------------------------------------------
    async function orderRow(id: string) {
      const row = await q<{ status: string; cogs_pyg: string; confirmed_at: Date | null }>(
        "SELECT status::text AS status, cogs_pyg::text AS cogs_pyg, confirmed_at FROM app.sale_orders WHERE id = $1",
        [id],
      );
      return row.rows[0]!;
    }

    async function lineCogs(orderId: string): Promise<string[]> {
      const rows = await q<{ cogs_pyg: string }>(
        "SELECT cogs_pyg::text AS cogs_pyg FROM app.sale_order_lines WHERE sale_order_id = $1 ORDER BY position",
        [orderId],
      );
      return rows.rows.map((row) => row.cogs_pyg);
    }

    async function movementsOf(orderId: string) {
      const rows = await q<{
        id: string;
        lot_id: string;
        variant_id: string;
        serial_unit_id: string | null;
        qty: string;
        total_cost_pyg: string;
        movement_type: string;
        occurred_at: Date;
        created_by: string;
        note: string;
      }>(
        `SELECT id::text, lot_id, variant_id, serial_unit_id, qty::text, total_cost_pyg::text,
                movement_type::text, occurred_at, created_by, note
           FROM app.inventory_movements WHERE reference_id = $1 ORDER BY id`,
        [orderId],
      );
      return rows.rows;
    }

    async function layersOf(orderId: string) {
      const rows = await q<{
        movement_id: string;
        lot_id: string;
        qty: string;
        unit_cost_pyg: string;
        total_cost_pyg: string;
      }>(
        `SELECT a.movement_id::text, a.lot_id, a.qty::text, a.unit_cost_pyg::text, a.total_cost_pyg::text
           FROM app.movement_cost_allocations a
           JOIN app.inventory_movements m ON m.id = a.movement_id
          WHERE m.reference_id = $1 ORDER BY a.id`,
        [orderId],
      );
      return rows.rows;
    }

    async function onHand(lotId: string): Promise<string> {
      return (
        await q<{ on_hand: string }>(
          "SELECT on_hand::text AS on_hand FROM app.inventory_balances WHERE lot_id = $1",
          [lotId],
        )
      ).rows[0]!.on_hand;
    }

    async function driftRows(): Promise<number> {
      return (
        await q<{ n: number }>(
          "SELECT count(*)::int AS n FROM app.v_balance_drift WHERE tenant_id = $1",
          [TENANT],
        )
      ).rows[0]!.n;
    }

    async function openReservations(orderId: string): Promise<number> {
      return (
        await q<{ n: number }>(
          "SELECT count(*)::int AS n FROM app.stock_reservations WHERE reference_id = $1 AND released_at IS NULL",
          [orderId],
        )
      ).rows[0]!.n;
    }

    async function totalMovements(): Promise<number> {
      return (await q<{ n: number }>("SELECT count(*)::int AS n FROM app.inventory_movements"))
        .rows[0]!.n;
    }

    /** Lo que el COGS tiene que ser: la suma de las capas del pedido. */
    async function layersTotal(orderId: string): Promise<string> {
      return (
        await q<{ total: string }>(
          `SELECT COALESCE(sum(a.total_cost_pyg), 0)::text AS total
             FROM app.movement_cost_allocations a
             JOIN app.inventory_movements m ON m.id = a.movement_id
            WHERE m.reference_id = $1`,
          [orderId],
        )
      ).rows[0]!.total;
    }

    /** Cuentas que tienen que cerrar tras confirmar: sin deriva y COGS = capas = líneas. */
    async function expectBooksBalance(orderId: string): Promise<void> {
      const order = await orderRow(orderId);
      const lines = await lineCogs(orderId);
      const sumOfLines = lines.reduce((sum, value) => sum + BigInt(value), 0n).toString();
      expect(await driftRows()).toBe(0);
      expect(order.cogs_pyg).toBe(await layersTotal(orderId));
      expect(order.cogs_pyg).toBe(sumOfLines);
    }

    // -------------------------------------------------------------------
    // Compuertas deterministas (patrón de stockLocks.integration.test.ts)
    // -------------------------------------------------------------------
    async function canLock(
      table: "product_variants" | "inventory_lots" | "sale_orders",
      id: string,
    ): Promise<boolean> {
      await probe.query("BEGIN");
      try {
        await probe.query(`SELECT id FROM app.${table} WHERE id = $1 FOR UPDATE NOWAIT`, [id]);
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === "55P03") return false;
        throw error;
      } finally {
        await probe.query("ROLLBACK");
      }
    }
    const isHeld = async (table: "product_variants" | "inventory_lots", id: string) =>
      !(await canLock(table, id));

    async function waitForBlockedBackends(count: number): Promise<void> {
      for (let attempt = 0; attempt < 200; attempt++) {
        await q("SELECT pg_stat_clear_snapshot()");
        const blocked = await q<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'joda_api' AND wait_event_type = 'Lock'",
        );
        if (blocked.rows[0]!.n >= count) return;
        await sleep(40);
      }
      throw new Error(`nunca hubo ${count} conexión(es) esperando un bloqueo`);
    }

    /**
     * Retiene `gateSql` con el superusuario, arranca `first` y `second` en ese orden de
     * llegada (esperando a que cada uno quede bloqueado), suelta la compuerta y devuelve
     * cómo terminó cada uno. Un interbloqueo (40P01) hace fallar a uno.
     */
    async function runBothWaiting(
      gateSql: string,
      gateValues: unknown[],
      first: () => Promise<unknown>,
      second: () => Promise<unknown>,
    ): Promise<PromiseSettledResult<unknown>[]> {
      await q("BEGIN");
      let gateOpen = true;
      try {
        await q(gateSql, gateValues);
        const one = first();
        await waitForBlockedBackends(1);
        const two = second();
        await waitForBlockedBackends(2);
        await q("COMMIT");
        gateOpen = false;
        return await Promise.allSettled([one, two]);
      } finally {
        if (gateOpen) await q("ROLLBACK");
      }
    }
    const gateVariant = (id: string): [string, unknown[]] => [
      "SELECT id FROM app.product_variants WHERE id = $1 FOR UPDATE",
      [id],
    ];

    /** Retiene la variante, arranca `path`, y cuando ya espera corre `whileWaiting` y suelta. */
    async function pathWaitingOnVariant(
      variantId: string,
      path: () => Promise<unknown>,
      whileWaiting: () => Promise<void>,
    ): Promise<PromiseSettledResult<unknown>> {
      await q("BEGIN");
      let gateOpen = true;
      try {
        await q("SELECT id FROM app.product_variants WHERE id = $1 FOR UPDATE", [variantId]);
        const running = Promise.allSettled([path()]);
        await waitForBlockedBackends(1);
        await whileWaiting();
        await q("COMMIT");
        gateOpen = false;
        return (await running)[0]!;
      } finally {
        if (gateOpen) await q("ROLLBACK");
      }
    }

    function requestContext(who: sales.SalesContext): RequestContext {
      return {
        requestId: "req-confirm",
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

    function appFor(who: { userId: string; sessionId: string; granted: string[] }) {
      const app = Fastify();
      app.register(fastifyTRPCPlugin, {
        prefix: "/trpc",
        trpcOptions: {
          router: router({ sales: createSalesRouter(db, deps) }),
          createContext: ({ req, res }: CreateFastifyContextOptions) => ({
            requestId: req.id,
            userId: who.userId,
            tenantId: TENANT,
            audience: "staff" as const,
            sessionId: who.sessionId,
            mfaStatus: "satisfied" as const,
            grantedPermissions: new Set(who.granted),
            req,
            res,
          }),
        },
      });
      return app;
    }

    beforeAll(async () => {
      testDb = await startTestDb();
      for (const [tenant, slug] of [
        [TENANT, "c19"],
        [OTHER_TENANT, "c19-otro"],
      ] as const) {
        await q(
          "INSERT INTO app.tenants (id, slug, legal_name, trade_name) VALUES ($1, $2, 'JODA', 'JODA')",
          [tenant, slug],
        );
        await q("SELECT app.seed_roles($1)", [tenant]);
      }
      const staff = [
        [OWNER, TENANT, "owner", OWNER_SESSION],
        [SELLER, TENANT, "vendedor", SELLER_SESSION],
        [OTHER_OWNER, OTHER_TENANT, "owner", OTHER_SESSION],
      ] as const;
      for (const [id, tenant, role, session] of staff) {
        await q(
          "INSERT INTO app.staff_users (id, tenant_id, auth_subject, email, full_name) VALUES ($1, $2, $3, $4, $5)",
          [id, tenant, `c19-${id}`, `c19-${id}@test.local`, `Personal ${role}`],
        );
        await q(
          "INSERT INTO app.staff_user_roles (tenant_id, staff_user_id, role_id) SELECT $1, $2, id FROM app.roles WHERE tenant_id = $1 AND code = $3",
          [tenant, id, role],
        );
        await q(
          "INSERT INTO app.staff_sessions (id, tenant_id, staff_user_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')",
          [session, tenant, id],
        );
      }
      // Un rol que solo lee pedidos: no confirma.
      const reader = await q<{ id: string }>(
        "INSERT INTO app.roles (tenant_id, code, name) VALUES ($1, 'c19_reader', 'Solo lectura') RETURNING id",
        [TENANT],
      );
      await q(
        "INSERT INTO app.role_permissions (tenant_id, role_id, permission_code) VALUES ($1, $2, 'sales.order:read')",
        [TENANT, reader.rows[0]!.id],
      );
      await q(
        "INSERT INTO app.staff_users (id, tenant_id, auth_subject, email, full_name) VALUES ($1, $2, 'c19-reader', 'c19-reader@test.local', 'Lector')",
        [READER, TENANT],
      );
      await q(
        "INSERT INTO app.staff_user_roles (tenant_id, staff_user_id, role_id) VALUES ($1, $2, $3)",
        [TENANT, READER, reader.rows[0]!.id],
      );
      await q(
        "INSERT INTO app.staff_sessions (id, tenant_id, staff_user_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')",
        [READER_SESSION, TENANT, READER],
      );
      await q(
        "INSERT INTO app.sales_channels (id, tenant_id, code, name) VALUES ($1, $2, 'presencial', 'Mostrador'), ($3, $4, 'presencial', 'Mostrador')",
        [CHANNEL, TENANT, OTHER_CHANNEL, OTHER_TENANT],
      );

      db = new PrismaClient({
        datasourceUrl: jodaApiConnectionUrl(testDb.container, { connection_limit: "8" }),
      });
      probe = new Client({ connectionString: testDb.connectionUri });
      await probe.connect();
    }, 120_000);

    afterAll(async () => {
      await probe?.end();
      await db?.$disconnect();
      await testDb?.stop();
    });

    // -------------------------------------------------------------------
    describe("RN-VTA-02 · RN-COS-04 · el pago consume por capas y el COGS cierra con ellas", () => {
      it("el vendedor, sin inventory.stock:read, confirma 3 unidades de dos lotes (RN-COS-04): dos salidas, dos capas, COGS 4.350.000 en la línea y el pedido, sin deriva", async () => {
        const variant = await seedVariant();
        // El lote más antiguo tiene el id MÁS ALTO: FIFO lo gasta primero, pero las capas
        // (y los bloqueos) salen por id de lote ascendente (RN-LOT-05).
        const older = await seedLot(variant, 2, 1_400_000, {
          receivedAt: "2099-01-01T00:00:00Z",
          id: "ffffffff-0000-4000-8000-00000000c1a1",
        });
        const newer = await seedLot(variant, 5, 1_550_000, {
          receivedAt: "2099-02-01T00:00:00Z",
          id: "00000000-0000-4000-8000-00000000c1a2",
        });
        const order = await awaiting([{ variantId: variant, qty: "3" }]);
        expect(await openReservations(order.id)).toBe(1);

        const confirmed = await confirm(order.id);

        expect(confirmed).toMatchObject({ id: order.id, status: "paid" });
        expect(confirmed.confirmedAt).toBe(NOW.toISOString());
        expect(confirmed.transitions.map((t) => [t.fromStatus, t.toStatus])).toEqual([
          ["draft", "awaiting_payment"],
          ["awaiting_payment", "paid"],
        ]);
        const movements = await movementsOf(order.id);
        // Una salida y una capa por lote tocado, por id de lote ascendente: el más nuevo primero.
        expect(
          movements.map((m) => [m.movement_type, m.lot_id, m.qty, m.total_cost_pyg, m.created_by]),
        ).toEqual([
          ["sale", newer, "-1.000", "1550000", SELLER],
          ["sale", older, "-2.000", "2800000", SELLER],
        ]);
        expect(movements.every((m) => m.occurred_at.getTime() === NOW.getTime())).toBe(true);
        expect(
          (await layersOf(order.id)).map((l) => [
            l.lot_id,
            l.qty,
            l.unit_cost_pyg,
            l.total_cost_pyg,
          ]),
        ).toEqual([
          [newer, "1.000", "1550000", "1550000"],
          [older, "2.000", "1400000", "2800000"],
        ]);
        expect(await onHand(older)).toBe("0.000");
        expect(await onHand(newer)).toBe("4.000");
        expect((await orderRow(order.id)).cogs_pyg).toBe("4350000");
        expect(await lineCogs(order.id)).toEqual(["4350000"]);
        await expectBooksBalance(order.id);
        expect(await openReservations(order.id)).toBe(0);
      });

      it("varias líneas del pedido, de la misma variante y de otras: cada línea ve el saldo que dejó la anterior y el COGS del pedido es la suma de sus capas", async () => {
        const shared = await seedVariant();
        const other = await seedVariant();
        const first = await seedLot(shared, 3, 100, {
          receivedAt: "2099-01-01T00:00:00Z",
          id: "ffffffff-0000-4000-8000-00000000c1b1",
        });
        const second = await seedLot(shared, 3, 250, {
          receivedAt: "2099-02-01T00:00:00Z",
          id: "00000000-0000-4000-8000-00000000c1b2",
        });
        const otherLot = await seedLot(other, 10, 7_000);
        const order = await awaiting([
          { variantId: shared, qty: "2" },
          { variantId: other, qty: "4" },
          { variantId: shared, qty: "2" },
        ]);

        await confirm(order.id);

        // Línea 1: 2 del primero (200). Línea 3: 1 del primero (100) y 1 del segundo (250), con
        // la capa del segundo (id más bajo) primero.
        expect(await lineCogs(order.id)).toEqual(["200", "28000", "350"]);
        expect((await orderRow(order.id)).cogs_pyg).toBe("28550");
        expect(await onHand(first)).toBe("0.000");
        expect(await onHand(second)).toBe("2.000");
        expect(await onHand(otherLot)).toBe("6.000");
        expect((await layersOf(order.id)).map((l) => l.total_cost_pyg)).toEqual([
          "200",
          "28000",
          "250",
          "100",
        ]);
        await expectBooksBalance(order.id);
      });

      it("la política fefo gasta primero el lote que vence antes aunque haya llegado después", async () => {
        const variant = await seedVariant({ policy: "fefo" });
        const lateExpiry = await seedLot(variant, 5, 100, {
          receivedAt: "2099-01-01T00:00:00Z",
          expiryAt: "2101-01-01",
        });
        const earlyExpiry = await seedLot(variant, 5, 300, {
          receivedAt: "2099-03-01T00:00:00Z",
          expiryAt: "2100-01-01",
        });
        const order = await awaiting([{ variantId: variant, qty: "2" }]);

        await confirm(order.id);

        expect(await onHand(earlyExpiry)).toBe("3.000");
        expect(await onHand(lateExpiry)).toBe("5.000");
        expect((await orderRow(order.id)).cogs_pyg).toBe("600");
      });

      it("el descuento del pedido no toca el costo: el COGS es lo que costó la mercadería, no lo que se cobró", async () => {
        const variant = await seedVariant({ price: 200_000 });
        await seedLot(variant, 2, 90_000);
        const order = await awaiting([{ variantId: variant, qty: "2" }], "100000");

        const confirmed = await confirm(order.id);

        expect(confirmed.totalPyg).toBe("300000");
        expect((await orderRow(order.id)).cogs_pyg).toBe("180000");
      });

      it("el vendedor sigue sin leer costos después de confirmar: ni el ledger, ni las capas, ni los lotes; el dueño sí los lee", async () => {
        const variant = await seedVariant();
        await seedLot(variant, 5, 12_345);
        const order = await awaiting([{ variantId: variant, qty: "1" }]);
        await confirm(order.id);

        const seen = await withTenantTx(db, sellerCtx, async (tx) => ({
          movements: await tx.inventory_movements.count({ where: { reference_id: order.id } }),
          layers: await tx.movement_cost_allocations.count(),
          lots: await tx.inventory_lots.count({ where: { variant_id: variant } }),
        }));
        const asOwner = await withTenantTx(db, ownerCtx, async (tx) => ({
          movements: await tx.inventory_movements.count({ where: { reference_id: order.id } }),
          lots: await tx.inventory_lots.count({ where: { variant_id: variant } }),
        }));

        expect(seen).toEqual({ movements: 0, layers: 0, lots: 0 });
        expect(asOwner).toEqual({ movements: 1, lots: 1 });
        expect((await movementsOf(order.id)).length).toBe(1);
      });

      it("el dueño (que sí lee lotes) confirma por el mismo camino y obtiene las mismas cuentas", async () => {
        const variant = await seedVariant();
        const lot = await seedLot(variant, 4, 5_000);
        const order = await awaiting([{ variantId: variant, qty: "3" }]);

        await confirm(order.id, ownerCtx);

        expect(await onHand(lot)).toBe("1.000");
        expect((await orderRow(order.id)).cogs_pyg).toBe("15000");
        await expectBooksBalance(order.id);
      });

      it("la respuesta, la auditoría y la clave de idempotencia no llevan costos", async () => {
        const variant = await seedVariant();
        await seedLot(variant, 5, 777_123);
        const order = await awaiting([{ variantId: variant, qty: "2" }]);
        const input = { id: order.id };
        const idempotency: IdempotencyRequest = {
          scope: API_IDEMPOTENCY_SCOPE,
          key: "sin-costos",
          requestHash: hashIdempotencyRequestBody(input),
        };

        const confirmed = await sales.confirmOrder(db, sellerCtx, input, deps, idempotency);

        expect(JSON.stringify(confirmed)).not.toMatch(/777123|1554246|cogs|cost/i);
        const stored = await q<{ response: unknown }>(
          "SELECT response FROM app.idempotency_keys WHERE key = 'sin-costos'",
        );
        expect(JSON.stringify(stored.rows[0]!.response)).not.toMatch(/777123|1554246|cogs|cost/i);
        const audit = await q<{ after: unknown }>(
          "SELECT after FROM app.audit_log WHERE entity_id = $1 AND action = 'sales.order.confirm'",
          [order.id],
        );
        expect(audit.rows).toHaveLength(1);
        expect(audit.rows[0]!.after).toEqual({
          status: "paid",
          movements: 1,
          costLayers: 1,
          serialUnitsSold: 0,
          reservationsReleased: 1,
          decantOrdersCreated: 0,
        });
      });
    });

    // -------------------------------------------------------------------
    describe("RN-VTA-04 · RN-SER · una variante serializada se vende eligiendo la unidad", () => {
      async function watch(policy: "serial" | "fifo" = "serial") {
        const variant = await seedVariant({
          kind: "watch",
          serialized: true,
          policy,
          price: 1_500_000,
        });
        const cheap = await seedLot(variant, 3, 800_000, { receivedAt: "2099-01-01T00:00:00Z" });
        const dear = await seedLot(variant, 3, 950_000, { receivedAt: "2099-06-01T00:00:00Z" });
        return { variant, cheap, dear };
      }

      it("la línea mueve exactamente la unidad elegida, del lote de ESA unidad (no el más antiguo), la pasa a sold ligada a la línea y su costo es el de ese lote", async () => {
        const { variant, cheap, dear } = await watch();
        const unit = await seedUnit(variant, dear, "RLX-C19-1");
        const order = await awaiting([{ variantId: variant, qty: "1", serialUnitId: unit }]);

        const confirmed = await confirm(order.id);

        const line = confirmed.lines[0]!;
        const movements = await movementsOf(order.id);
        expect(movements.map((m) => [m.lot_id, m.serial_unit_id, m.qty, m.total_cost_pyg])).toEqual(
          [[dear, unit, "-1.000", "950000"]],
        );
        expect(await onHand(dear)).toBe("2.000");
        expect(await onHand(cheap)).toBe("3.000");
        const sold = await q<{ status: string; sold_order_line_id: string }>(
          "SELECT status::text, sold_order_line_id FROM app.serialized_units WHERE id = $1",
          [unit],
        );
        expect(sold.rows[0]).toEqual({ status: "sold", sold_order_line_id: line.id });
        expect(await lineCogs(order.id)).toEqual(["950000"]);
        await expectBooksBalance(order.id);
      });

      // Con política `serial` el dominio también la rechazaría; con una política anterior a E05d
      // (`fifo`) solo la guarda de la unidad impide vender un reloj sin mover ninguna unidad.
      it.each(["serial", "fifo"] as const)(
        "una línea de variante serializada (política %s) sin unidad elegida se rechaza (400) y no mueve nada: el pedido sigue esperando el pago",
        async (policy) => {
          const { variant, cheap } = await watch(policy);
          const unit = await seedUnit(variant, cheap, `RLX-C19-2-${policy}`);
          const order = await awaiting([{ variantId: variant, qty: "1", serialUnitId: unit }]);
          // La API no crea una línea así; la base la admite (`serial_line_is_single` es solo qty = 1).
          await q(
            "UPDATE app.sale_order_lines SET serial_unit_id = NULL WHERE sale_order_id = $1",
            [order.id],
          );
          const before = await totalMovements();

          const rejected = await rejection(confirm(order.id));

          expect(rejected).toMatchObject({
            code: "VALIDATION_SERIAL_UNIT_REQUIRED",
            httpStatus: 400,
          });
          expect(await totalMovements()).toBe(before);
          expect((await orderRow(order.id)).status).toBe("awaiting_payment");
          const stillAvailable = await q<{ status: string }>(
            "SELECT status::text FROM app.serialized_units WHERE id = $1",
            [unit],
          );
          expect(stillAvailable.rows[0]!.status).toBe("available");
        },
      );

      it("la unidad se vendió en otro lado mientras tanto: 409, sin movimientos y el pedido no cambia", async () => {
        const { variant, cheap } = await watch();
        const unit = await seedUnit(variant, cheap, "RLX-C19-3");
        const order = await awaiting([{ variantId: variant, qty: "1", serialUnitId: unit }]);
        await q("UPDATE app.serialized_units SET status = 'sold' WHERE id = $1", [unit]);
        const before = await totalMovements();

        const rejected = await rejection(confirm(order.id));

        expect(rejected).toMatchObject({
          code: "CONFLICT_SERIAL_UNIT_UNAVAILABLE",
          httpStatus: 409,
        });
        expect(await totalMovements()).toBe(before);
        expect((await orderRow(order.id)).status).toBe("awaiting_payment");
        expect(await openReservations(order.id)).toBe(1);
      });

      it("la unidad la reservó otro pedido después de que venció la de este: 409 CONFLICT_SERIAL_UNIT_RESERVED y no se la lleva", async () => {
        const { variant, cheap } = await watch();
        const unit = await seedUnit(variant, cheap, "RLX-C19-4");
        const first = await awaiting([{ variantId: variant, qty: "1", serialUnitId: unit }]);
        await q("UPDATE app.stock_reservations SET released_at = now() WHERE reference_id = $1", [
          first.id,
        ]);
        await awaiting([{ variantId: variant, qty: "1", serialUnitId: unit }]);
        const before = await totalMovements();

        const rejected = await rejection(confirm(first.id));

        expect(rejected).toMatchObject({ code: "CONFLICT_SERIAL_UNIT_RESERVED", httpStatus: 409 });
        expect(await totalMovements()).toBe(before);
      });

      it("una unidad sin lote no se puede vender: no hay de dónde sacarla ni a qué costo (409)", async () => {
        const { variant } = await watch();
        const unit = await seedUnit(variant, null, "RLX-C19-5");
        const order = await awaiting([{ variantId: variant, qty: "1", serialUnitId: unit }]);

        const rejected = await rejection(confirm(order.id));

        expect(rejected).toMatchObject({
          code: "CONFLICT_SERIAL_UNIT_UNAVAILABLE",
          httpStatus: 409,
        });
        expect((await orderRow(order.id)).status).toBe("awaiting_payment");
      });

      it("el movimiento no puede llevar la unidad de otra variante (FK compuesta de 0042), ni como superusuario", async () => {
        const { variant, cheap } = await watch();
        const unit = await seedUnit(variant, cheap, "RLX-C19-6");
        const other = await seedVariant();
        const otherLot = await seedLot(other, 3, 100);

        await expect(
          q(
            "INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, serial_unit_id, qty, uom, movement_type, total_cost_pyg) VALUES ($1, $2, $3, $4, -1, 'unit', 'sale', 100)",
            [TENANT, otherLot, other, unit],
          ),
        ).rejects.toThrow("inventory_movements_serial_unit_id_fkey");
      });
    });

    // -------------------------------------------------------------------
    describe("RN-RES-03 · RN-RES-04 · el pedido consume lo que reservó y nada que otro haya reservado", () => {
      it("al confirmar se sueltan las reservas del pedido (released_at) y las de otro pedido no se tocan", async () => {
        const variant = await seedVariant();
        await seedLot(variant, 10, 100);
        const mine = await awaiting([{ variantId: variant, qty: "2" }]);
        const theirs = await awaiting([{ variantId: variant, qty: "3" }]);

        await confirm(mine.id);

        expect(await openReservations(mine.id)).toBe(0);
        expect(await openReservations(theirs.id)).toBe(1);
        const view = await q<{ on_hand: string; reserved: string; available: string }>(
          "SELECT on_hand::text, reserved::text, available::text FROM app.v_stock_available WHERE variant_id = $1",
          [variant],
        );
        expect(view.rows[0]).toEqual({ on_hand: "8.000", reserved: "3.000", available: "5.000" });
      });

      it("una reserva ajena no se consume: si venció la de este pedido y otro reservó el saldo, confirmar da 409 y no mueve nada", async () => {
        const variant = await seedVariant();
        const lot = await seedLot(variant, 3, 100);
        const mine = await awaiting([{ variantId: variant, qty: "2" }]);
        await q("UPDATE app.stock_reservations SET released_at = now() WHERE reference_id = $1", [
          mine.id,
        ]);
        await awaiting([{ variantId: variant, qty: "2" }]);
        const before = await totalMovements();

        const rejected = await rejection(confirm(mine.id));

        expect(rejected).toMatchObject({ code: "CONFLICT_INSUFFICIENT_STOCK", httpStatus: 409 });
        expect(await totalMovements()).toBe(before);
        expect(await onHand(lot)).toBe("3.000");
        expect((await orderRow(mine.id)).status).toBe("awaiting_payment");
      });

      it("el rechazo por falta de stock dice qué variante falta y cuánto, y no trae ningún costo", async () => {
        const variant = await seedVariant();
        await seedLot(variant, 3, 987_654);
        const mine = await awaiting([{ variantId: variant, qty: "2" }]);
        await q("UPDATE app.stock_reservations SET released_at = now() WHERE reference_id = $1", [
          mine.id,
        ]);
        await awaiting([{ variantId: variant, qty: "2" }]);

        const rejected = await rejection(confirm(mine.id));

        expect(rejected.text).toContain("shortages");
        expect(rejected.text).not.toMatch(/987654|cost|cogs|landed/i);
      });

      it("el saldo está en un lote en cuarentena: aunque el disponible de la variante lo cuente, el lote no es saldo vendible (409)", async () => {
        const variant = await seedVariant();
        const quarantined = await seedLot(variant, 5, 100, { status: "quarantine" });
        const order = await awaiting([{ variantId: variant, qty: "1" }]);

        const rejected = await rejection(confirm(order.id));

        expect(rejected).toMatchObject({ code: "CONFLICT_INSUFFICIENT_STOCK", httpStatus: 409 });
        expect(await onHand(quarantined)).toBe("5.000");
      });

      it("un pedido con una política de lote manual no se confirma solo: 409, sin consumir nada", async () => {
        const variant = await seedVariant({ policy: "manual" });
        await seedLot(variant, 5, 100);
        const order = await awaiting([{ variantId: variant, qty: "1" }]);

        const rejected = await rejection(confirm(order.id));

        expect(rejected).toMatchObject({
          code: "CONFLICT_ALLOCATION_NEEDS_LOT_CHOICE",
          httpStatus: 409,
        });
        expect((await orderRow(order.id)).status).toBe("awaiting_payment");
      });

      it("todo o nada: si una línea no alcanza, la otra tampoco se consume ni cambia el estado", async () => {
        const fine = await seedVariant();
        const short = await seedVariant();
        const fineLot = await seedLot(fine, 5, 100);
        await seedLot(short, 1, 100);
        const order = await awaiting([
          { variantId: fine, qty: "2" },
          { variantId: short, qty: "1" },
        ]);
        await q(
          "INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type, total_cost_pyg) SELECT $1, id, variant_id, -1, 'unit', 'adjustment', 100 FROM app.inventory_lots WHERE variant_id = $2",
          [TENANT, short],
        );
        const before = await totalMovements();

        const rejected = await rejection(confirm(order.id));

        expect(rejected.httpStatus).toBe(409);
        expect(await totalMovements()).toBe(before);
        expect(await onHand(fineLot)).toBe("5.000");
        expect((await orderRow(order.id)).status).toBe("awaiting_payment");
        expect(await openReservations(order.id)).toBe(2);
      });
    });

    // -------------------------------------------------------------------
    describe("RN-FRA-01 · RN-FRA-03 · una línea de decant bajo pedido crea su orden y no asienta el costo", () => {
      async function decantScenario(bulkMl: number) {
        const productId = await seedProduct("perfume");
        const bulk = await seedVariant({ productId, type: "bulk", uom: "ml" });
        const target = await seedVariant({
          productId,
          type: "decant",
          uom: "ml",
          sizeMl: 10,
          price: 245_000,
          madeToOrder: true,
          sourceVariantId: bulk,
        });
        const vial = await seedVariant({ type: "supply" });
        await q(
          "INSERT INTO app.bom_components (tenant_id, parent_variant_id, component_variant_id, qty_per_unit, uom) VALUES ($1, $2, $3, 1, 'unit')",
          [TENANT, target, vial],
        );
        const bulkLot = await seedLot(bulk, bulkMl, 11_972, {
          uom: "ml",
          status: "open_for_decant",
          openedAt: "2099-01-01T00:00:00Z",
        });
        const vialLot = await seedLot(vial, 20, 4_500);
        return { bulk, target, vial, bulkLot, vialLot };
      }

      it("el vendedor confirma un pedido mixto (sellado + decant): consume el sellado, planifica el decant en la misma transacción y la línea del decant queda con costo pendiente", async () => {
        const scenario = await decantScenario(100);
        const sealed = await seedVariant();
        const sealedLot = await seedLot(sealed, 5, 2_000);
        const order = await awaiting([
          { variantId: sealed, qty: "1" },
          { variantId: scenario.target, qty: "2" },
        ]);

        const confirmed = await confirm(order.id);

        expect(confirmed.status).toBe("paid");
        expect(await onHand(sealedLot)).toBe("4.000");
        // Lo del decant no se asienta: ninguna salida de la línea del decant, costo en cero.
        expect(await lineCogs(order.id)).toEqual(["2000", "0"]);
        expect((await orderRow(order.id)).cogs_pyg).toBe("2000");
        expect((await movementsOf(order.id)).map((m) => m.variant_id)).toEqual([sealed]);
        const decantLine = confirmed.lines[1]!;
        const orders = await q<{
          status: string;
          sale_order_id: string;
          sale_order_line_id: string;
          source_lot_id: string;
          qty_units: number;
        }>(
          "SELECT status::text, sale_order_id, sale_order_line_id, source_lot_id, qty_units FROM app.decant_work_orders WHERE sale_order_id = $1",
          [order.id],
        );
        expect(orders.rows).toEqual([
          {
            status: "pending",
            sale_order_id: order.id,
            sale_order_line_id: decantLine.id,
            source_lot_id: scenario.bulkLot,
            qty_units: 2,
          },
        ]);
        // Ni se consumió el granel ni el vial: se reservaron (20,4 ml con la merma, 2 viales).
        expect(await onHand(scenario.bulkLot)).toBe("100.000");
        expect(await onHand(scenario.vialLot)).toBe("20.000");
        const held = await q<{ variant_id: string; qty: string }>(
          "SELECT variant_id, qty::text FROM app.stock_reservations WHERE reason = 'decant_hold' AND released_at IS NULL AND variant_id = ANY($1::uuid[]) ORDER BY qty DESC",
          [[scenario.bulk, scenario.vial]],
        );
        expect(held.rows).toEqual([
          { variant_id: scenario.bulk, qty: "20.400" },
          { variant_id: scenario.vial, qty: "2.000" },
        ]);
        await expectBooksBalance(order.id);
      });

      it("si el granel no alcanza para el decant, falla todo el pedido: el sellado no se consume y el estado no cambia", async () => {
        const scenario = await decantScenario(5);
        const sealed = await seedVariant();
        const sealedLot = await seedLot(sealed, 5, 2_000);
        const order = await awaiting([
          { variantId: sealed, qty: "1" },
          { variantId: scenario.target, qty: "1" },
        ]);
        const before = await totalMovements();

        const rejected = await rejection(confirm(order.id));

        expect(rejected).toMatchObject({ code: "CONFLICT_NO_BULK_AVAILABLE", httpStatus: 409 });
        expect(await totalMovements()).toBe(before);
        expect(await onHand(sealedLot)).toBe("5.000");
        expect((await orderRow(order.id)).status).toBe("awaiting_payment");
        expect(await openReservations(order.id)).toBe(1);
        const orders = await q<{ n: number }>(
          "SELECT count(*)::int AS n FROM app.decant_work_orders WHERE sale_order_id = $1",
          [order.id],
        );
        expect(orders.rows[0]!.n).toBe(0);
      });

      it("una línea que ya tiene su orden (la planificó `plan` antes) no se duplica al confirmar", async () => {
        const scenario = await decantScenario(100);
        const order = await awaiting([{ variantId: scenario.target, qty: "1" }]);
        const line = (await sales.getOrder(db, ownerCtx, order.id)).lines[0]!;
        await decant.planWorkOrder(db, { clock }, requestContext(sellerCtx), {
          saleOrderLineId: line.id,
          targetVariantId: scenario.target,
          qtyUnits: 1,
        });

        const confirmed = await confirm(order.id);

        expect(confirmed.status).toBe("paid");
        const orders = await q<{ n: number }>(
          "SELECT count(*)::int AS n FROM app.decant_work_orders WHERE sale_order_line_id = $1",
          [line.id],
        );
        expect(orders.rows[0]!.n).toBe(1);
        const held = await q<{ n: number }>(
          "SELECT count(*)::int AS n FROM app.stock_reservations WHERE reason = 'decant_hold' AND released_at IS NULL AND variant_id = $1",
          [scenario.bulk],
        );
        expect(held.rows[0]!.n).toBe(1);
      });
    });

    // -------------------------------------------------------------------
    describe("docs/api-conventions.md §5 · reintentar la confirmación no consume dos veces", () => {
      it("la misma Idempotency-Key devuelve la respuesta guardada: un solo juego de movimientos, capas y COGS", async () => {
        const variant = await seedVariant();
        const lot = await seedLot(variant, 5, 1_000);
        const order = await awaiting([{ variantId: variant, qty: "2" }]);
        const input = { id: order.id };
        const idempotency: IdempotencyRequest = {
          scope: API_IDEMPOTENCY_SCOPE,
          key: "confirmar-1",
          requestHash: hashIdempotencyRequestBody(input),
        };

        const first = await sales.confirmOrder(db, sellerCtx, input, deps, idempotency);
        const second = await sales.confirmOrder(db, sellerCtx, input, deps, idempotency);

        expect(second).toEqual(first);
        expect((await movementsOf(order.id)).length).toBe(1);
        expect((await layersOf(order.id)).length).toBe(1);
        expect(await onHand(lot)).toBe("3.000");
        expect((await orderRow(order.id)).cogs_pyg).toBe("2000");
      });

      it("la misma clave con otro contenido responde 409 y no confirma", async () => {
        const variant = await seedVariant();
        await seedLot(variant, 5, 1_000);
        const order = await awaiting([{ variantId: variant, qty: "1" }]);
        const other = await awaiting([{ variantId: variant, qty: "1" }]);
        const withKey = (id: string): IdempotencyRequest => ({
          scope: API_IDEMPOTENCY_SCOPE,
          key: "confirmar-reuso",
          requestHash: hashIdempotencyRequestBody({ id }),
        });
        await sales.confirmOrder(db, sellerCtx, { id: order.id }, deps, withKey(order.id));

        const rejected = await rejection(
          sales.confirmOrder(db, sellerCtx, { id: other.id }, deps, withKey(other.id)),
        );

        expect(rejected).toMatchObject({ code: "CONFLICT_IDEMPOTENCY_KEY_REUSE", httpStatus: 409 });
        expect((await orderRow(other.id)).status).toBe("awaiting_payment");
      });

      it("sin clave, confirmar un pedido ya cobrado es un 409 del catálogo y no consume otra vez", async () => {
        const variant = await seedVariant();
        const lot = await seedLot(variant, 5, 1_000);
        const order = await awaiting([{ variantId: variant, qty: "2" }]);
        await confirm(order.id);

        const rejected = await rejection(confirm(order.id));

        expect(rejected).toMatchObject({ code: "CONFLICT_INVALID_TRANSITION", httpStatus: 409 });
        expect((await movementsOf(order.id)).length).toBe(1);
        expect(await onHand(lot)).toBe("3.000");
        await expectBooksBalance(order.id);
      });

      it("un pedido en borrador, uno cancelado y uno que no existe no se confirman: 409, 409 y 404", async () => {
        const variant = await seedVariant();
        await seedLot(variant, 5, 1_000);
        const draft = await sales.createOrder(
          db,
          ownerCtx,
          { channelId: CHANNEL, lines: [{ variantId: variant, qty: "1" }] },
          deps,
        );
        const cancelled = await awaiting([{ variantId: variant, qty: "1" }]);
        await sales.transitionOrder(
          db,
          ownerCtx,
          { id: cancelled.id, toStatus: "cancelled" },
          deps,
        );
        const before = await totalMovements();

        expect((await rejection(confirm(draft.id))).code).toBe("CONFLICT_INVALID_TRANSITION");
        expect((await rejection(confirm(cancelled.id))).code).toBe("CONFLICT_INVALID_TRANSITION");
        expect(await rejection(confirm("c1900000-0000-4000-a000-00000000dead"))).toMatchObject({
          code: "NOT_FOUND",
          httpStatus: 404,
        });
        expect(await totalMovements()).toBe(before);
      });

      it("el pedido de otro tenant no se confirma: 404, como si no existiera", async () => {
        const variant = await seedVariant();
        await seedLot(variant, 5, 1_000);
        const order = await awaiting([{ variantId: variant, qty: "1" }]);

        const rejected = await rejection(confirm(order.id, otherCtx));

        expect(rejected).toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
        expect((await orderRow(order.id)).status).toBe("awaiting_payment");
      });
    });

    // -------------------------------------------------------------------
    describe("docs/api-conventions.md §4.3 · §5 · §9 · el procedimiento sales.order.confirm", () => {
      it("sin sales.order:write responde 404 (ruta administrativa) o 403 (con sales.order:read, del mismo módulo), y no confirma", async () => {
        const variant = await seedVariant();
        await seedLot(variant, 5, 1_000);
        const order = await awaiting([{ variantId: variant, qty: "1" }]);
        const nobody = appFor({ userId: READER, sessionId: READER_SESSION, granted: [] });
        const reader = appFor({
          userId: READER,
          sessionId: READER_SESSION,
          granted: ["sales.order:read"],
        });
        try {
          const hidden = await nobody.inject({
            method: "POST",
            url: "/trpc/sales.order.confirm",
            payload: { id: order.id },
          });
          const forbidden = await reader.inject({
            method: "POST",
            url: "/trpc/sales.order.confirm",
            payload: { id: order.id },
          });

          expect(hidden.statusCode).toBe(404);
          expect(forbidden.statusCode).toBe(403);
          expect((await orderRow(order.id)).status).toBe("awaiting_payment");
        } finally {
          await nobody.close();
          await reader.close();
        }
      });

      it("por HTTP, el vendedor confirma con Idempotency-Key y el segundo envío devuelve lo mismo sin reprocesar; la respuesta es estricta y sin costos", async () => {
        const variant = await seedVariant();
        const lot = await seedLot(variant, 5, 31_415);
        const order = await awaiting([{ variantId: variant, qty: "2" }]);
        const app = appFor({
          userId: SELLER,
          sessionId: SELLER_SESSION,
          granted: ["sales.order:read", "sales.order:write"],
        });
        try {
          const send = () =>
            app.inject({
              method: "POST",
              url: "/trpc/sales.order.confirm",
              headers: { "idempotency-key": "http-1" },
              payload: { id: order.id },
            });
          const first = await send();
          const second = await send();

          expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
          expect(second.json().result.data).toEqual(first.json().result.data);
          expect(first.json().result.data.status).toBe("paid");
          expect(first.body).not.toMatch(/31415|62830|cogs/i);
          expect(await onHand(lot)).toBe("3.000");
          const strict = await app.inject({
            method: "POST",
            url: "/trpc/sales.order.confirm",
            payload: { id: order.id, cogsPyg: "1" },
          });
          expect(strict.statusCode).toBe(400);
        } finally {
          await app.close();
        }
      });
    });

    // -------------------------------------------------------------------
    describe("RN-RES-07 · ADR-019 · la confirmación bloquea la variante antes que los lotes, sin interbloqueo", () => {
      it("toma la VARIANTE antes que cualquier lote: mientras espera la variante, ni un lote ni una salida (sin el bloqueo ordenado, el lote ya estaría tomado)", async () => {
        const variant = await seedVariant({ id: triplet("c100").gate });
        const lot = await seedLot(variant, 5, 100);
        const order = await awaiting([{ variantId: variant, qty: "1" }]);
        const before = await totalMovements();

        const outcome = await pathWaitingOnVariant(
          variant,
          () => confirm(order.id, ownerCtx),
          async () => {
            expect(await isHeld("inventory_lots", lot)).toBe(false);
            expect(await totalMovements()).toBe(before);
          },
        );

        expect(outcome.status).toBe("fulfilled");
        expect(await onHand(lot)).toBe("4.000");
      });

      it("dos pedidos que comparten tres variantes con las líneas en orden contrario no se interbloquean, en los dos órdenes de llegada (la compuerta retiene la de id más bajo)", async () => {
        const ids = triplet("c110");
        const gate = await seedVariant({ id: ids.gate });
        const low = await seedVariant({ id: ids.low });
        const high = await seedVariant({ id: ids.high });
        for (const variant of [gate, low, high]) await seedLot(variant, 20, 100);
        const lines = (variants: string[]) =>
          variants.map((variantId) => ({ variantId, qty: "1" }));
        // A pide [alta, compuerta, baja]; B pide [baja, compuerta, alta]. Bloqueando en el orden de las
        // líneas, A toma la alta y espera la compuerta, B toma la baja y espera la compuerta, y al abrirla
        // A pide la baja (de B) y B la alta (de A).
        const a1 = await awaiting(lines([high, gate, low]));
        const b1 = await awaiting(lines([low, gate, high]));
        const a2 = await awaiting(lines([high, gate, low]));
        const b2 = await awaiting(lines([low, gate, high]));

        const aFirst = await runBothWaiting(
          ...gateVariant(gate),
          () => confirm(a1.id, ownerCtx),
          () => confirm(b1.id, ownerCtx),
        );
        const bFirst = await runBothWaiting(
          ...gateVariant(gate),
          () => confirm(b2.id, ownerCtx),
          () => confirm(a2.id, ownerCtx),
        );

        expect(aFirst.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
        expect(bFirst.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
        for (const id of [a1.id, b1.id, a2.id, b2.id])
          expect((await orderRow(id)).status).toBe("paid");
        expect(await driftRows()).toBe(0);
      });

      it("lo mismo con el vendedor, que no lee lotes: la función de los lotes los toma ascendentes y no hay interbloqueo", async () => {
        const ids = triplet("c120");
        const gate = await seedVariant({ id: ids.gate });
        const low = await seedVariant({ id: ids.low });
        const high = await seedVariant({ id: ids.high });
        for (const variant of [gate, low, high]) await seedLot(variant, 20, 100);
        const lines = (variants: string[]) =>
          variants.map((variantId) => ({ variantId, qty: "1" }));
        const a = await awaiting(lines([high, gate, low]));
        const b = await awaiting(lines([low, gate, high]));

        const outcomes = await runBothWaiting(
          ...gateVariant(gate),
          () => confirm(a.id),
          () => confirm(b.id),
        );

        expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
        await expectBooksBalance(a.id);
        await expectBooksBalance(b.id);
      });

      it("la función de los lotes de una venta los deja bloqueados aunque quien la llama (el vendedor) no los lea: mientras su transacción sigue abierta, el lote está tomado", async () => {
        const variant = await seedVariant();
        const lot = await seedLot(variant, 5, 100);
        const order = await awaiting([{ variantId: variant, qty: "1" }]);
        let release: () => void = () => undefined;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let taken: () => void = () => undefined;
        const holding = new Promise<void>((resolve) => {
          taken = resolve;
        });
        // La misma transacción que `confirm`, pero retenida: se llama al servicio a través de
        // un envoltorio que no suelta hasta que la prueba mire.
        const confirming = withTenantTx(db, sellerCtx, async (tx) => {
          await tx.$queryRaw`SELECT f.lot_id FROM app.list_sale_allocation_lots(ARRAY[${variant}]::uuid[]) f`;
          taken();
          await released;
        });
        confirming.catch(() => undefined);
        await holding;

        expect(await isHeld("inventory_lots", lot)).toBe(true);
        release();
        await confirming;
        expect(await isHeld("inventory_lots", lot)).toBe(false);
        expect((await orderRow(order.id)).status).toBe("awaiting_payment");
      });

      it("dos confirmaciones simultáneas del MISMO pedido: una consume y la otra recibe 409; el ledger tiene un solo juego de movimientos", async () => {
        const variant = await seedVariant();
        const lot = await seedLot(variant, 5, 1_000);
        const order = await awaiting([{ variantId: variant, qty: "2" }]);

        const outcomes = await runBothWaiting(
          "SELECT id FROM app.sale_orders WHERE id = $1 FOR UPDATE",
          [order.id],
          () => confirm(order.id),
          () => confirm(order.id, ownerCtx),
        );

        expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
        expect((await movementsOf(order.id)).length).toBe(1);
        expect(await onHand(lot)).toBe("3.000");
        await expectBooksBalance(order.id);
      });

      it("confirmar contra abrir un frasco de la misma variante: las dos terminan, sin interbloqueo ni deriva", async () => {
        const productId = await seedProduct("perfume");
        const sealed = await seedVariant({
          productId,
          type: "sealed",
          sizeMl: 100,
          price: 2_000_000,
        });
        const bulk = await seedVariant({ productId, type: "bulk", uom: "ml" });
        const sold = await seedLot(sealed, 2, 1_400_000);
        const toOpen = await seedLot(sealed, 1, 1_450_000);
        const order = await awaiting([{ variantId: sealed, qty: "1" }]);

        const outcomes = await runBothWaiting(
          ...gateVariant(sealed),
          () => confirm(order.id),
          () =>
            inventory.openLot(db, { clock, idGenerator: uuidGenerator }, requestContext(ownerCtx), {
              lotId: toOpen,
            }),
        );

        expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
        expect(await onHand(sold)).toBe("1.000");
        const opened = await q<{ status: string }>(
          "SELECT status::text FROM app.inventory_lots WHERE id = $1",
          [toOpen],
        );
        expect(opened.rows[0]!.status).toBe("open_for_decant");
        expect(await driftRows()).toBe(0);
        const bulkLots = await q<{ n: number }>(
          "SELECT count(*)::int AS n FROM app.inventory_lots WHERE variant_id = $1",
          [bulk],
        );
        expect(bulkLots.rows[0]!.n).toBe(1);
      });

      it("confirmar contra reservar otro pedido de la misma variante: las dos terminan y el saldo cuadra en cualquier orden de llegada", async () => {
        const variant = await seedVariant();
        const lot = await seedLot(variant, 2, 100);
        const mine = await awaiting([{ variantId: variant, qty: "1" }]);
        const draft = await sales.createOrder(
          db,
          ownerCtx,
          { channelId: CHANNEL, lines: [{ variantId: variant, qty: "1" }] },
          deps,
        );

        const outcomes = await runBothWaiting(
          ...gateVariant(variant),
          () => confirm(mine.id),
          () =>
            sales.transitionOrder(
              db,
              ownerCtx,
              { id: draft.id, toStatus: "awaiting_payment" },
              deps,
            ),
        );

        expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
        expect(await onHand(lot)).toBe("1.000");
        expect(await openReservations(draft.id)).toBe(1);
        expect(await openReservations(mine.id)).toBe(0);
        const view = await q<{ available: string }>(
          "SELECT available::text FROM app.v_stock_available WHERE variant_id = $1",
          [variant],
        );
        expect(view.rows[0]!.available).toBe("0.000");
        await expectBooksBalance(mine.id);
      });

      it("el último saldo, prometido al segundo pedido cuando venció la reserva del primero, no se vende dos veces: el primero recibe 409 y el segundo consume", async () => {
        const variant = await seedVariant();
        const lot = await seedLot(variant, 1, 100);
        const first = await awaiting([{ variantId: variant, qty: "1" }]);
        await q("UPDATE app.stock_reservations SET released_at = now() WHERE reference_id = $1", [
          first.id,
        ]);
        const second = await awaiting([{ variantId: variant, qty: "1" }]);

        const outcomes = await runBothWaiting(
          ...gateVariant(variant),
          () => confirm(first.id),
          () => confirm(second.id),
        );

        // Llegue en el orden que llegue, el saldo es del segundo: nunca los dos.
        expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "fulfilled"]);
        expect(await onHand(lot)).toBe("0.000");
        expect(await driftRows()).toBe(0);
      });
    });
  },
);
