import { PrismaClient } from "@joda/db";
import { Client } from "pg";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidGenerator } from "../adapters/uuidGenerator.js";
import * as inventory from "../modules/inventory/service.js";
import * as sales from "../modules/sales/service.js";
import type { RequestContext } from "../trpc/context.js";
import {
  lockLotWithItsVariant,
  lockVariantsThenLots,
  shareLockVariantsAscending,
} from "./stockLocks.js";
import { jodaApiConnectionUrl, startTestDb, type TestDb } from "./testDb.js";
import { withTenantTx, type TenantTx } from "./withTenantTx.js";

// RN-RES-07 · el orden de bloqueo único, con Postgres real y concurrencia de
// verdad. Los identificadores se eligen a propósito: el orden en que el código
// los recibe (y el orden físico de las filas) es el CONTRARIO al de `id`, así que
// solo un `ORDER BY id` en una sola sentencia da el orden ascendente. Cuando una
// prueba tiene que forzar que el plan recorra el heap, lo hace como C13: con el
// rol `joda_api` sin índices (`withHeapPlansForApiRole`).
const TENANT = "5c1b0000-0000-4000-a000-000000000001";
const OWNER = "5c1b0000-0000-4000-a000-0000000000a1";
const SELLER = "5c1b0000-0000-4000-a000-0000000000a2";
const OWNER_SESSION = "5c1b0000-0000-4000-a000-0000000000b1";
const SELLER_SESSION = "5c1b0000-0000-4000-a000-0000000000b2";
const CHANNEL = "5c1b0000-0000-4000-a000-0000000000c1";

// Variantes de la venta: la de id ALTO se inserta primero (en el heap sale primero).
const W_HIGH = "ffffffff-0000-4000-8000-000000000011";
const W_LOW = "00000000-0000-4000-8000-000000000012";
// El sellado tiene el id ALTO y su granel el BAJO: abrir un frasco los toma en ese orden.
const SEALED = "ffffffff-0000-4000-8000-000000000021";
const BULK = "00000000-0000-4000-8000-000000000022";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const clock = { now: () => NOW };
const auditMeta = { ip: "127.0.0.1", userAgent: "stock-locks-test", requestId: "req-locks" };
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

describe(
  "RN-RES-07 · orden de bloqueo único: la variante primero, los lotes después",
  { timeout: 60_000 },
  () => {
    let testDb: TestDb;
    let db: PrismaClient;
    // Una segunda conexión de superusuario, solo para MIRAR qué filas están tomadas: la principal
    // (`q`) retiene los bloqueos de la compuerta, y un ROLLBACK de la sonda no puede soltarlos.
    let probe: Client;
    const deps = { clock };

    const q = <Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ) => testDb.superuserClient.query<Row>(text, values);

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    function requestContext(who: sales.SalesContext): RequestContext {
      return {
        requestId: "req-locks",
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

    let productCounter = 0;

    async function seedProduct(kind: "accessory" | "perfume"): Promise<string> {
      const product = await q<{ id: string }>(
        "INSERT INTO app.products (tenant_id, kind, slug, name) VALUES ($1, $2::app.product_kind, $3, $4) RETURNING id",
        [TENANT, kind, `locks-${kind}-${++productCounter}`, `Producto ${kind} ${productCounter}`],
      );
      if (kind === "perfume") {
        await q(
          "INSERT INTO app.perfume_details (product_id, tenant_id, concentration, nominal_volume_ml, olfactory_family) VALUES ($1, $2, 'edp', 100, 'amaderado')",
          [product.rows[0]!.id, TENANT],
        );
      }
      return product.rows[0]!.id;
    }

    async function seedVariant(
      id: string,
      productId: string,
      sku: string,
      type: "unit" | "sealed" | "bulk",
    ) {
      await q(
        `INSERT INTO app.product_variants (id, tenant_id, product_id, sku, variant_type, uom, size_ml, price_pyg)
       VALUES ($1, $2, $3, $4, $5::app.variant_type, $6::app.uom, $7, 100000)`,
        [
          id,
          TENANT,
          productId,
          sku,
          type,
          type === "bulk" ? "ml" : "unit",
          type === "sealed" ? 100 : null,
        ],
      );
    }

    async function seedLot(
      variantId: string,
      uom: "unit" | "ml",
      qty: number,
      id?: string,
    ): Promise<string> {
      const lot = await q<{ id: string }>(
        `INSERT INTO app.inventory_lots (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency, fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5::app.uom, 0, 'PYG', 1, 0, 0) RETURNING id`,
        [id ?? null, TENANT, variantId, qty, uom],
      );
      await q(
        "INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type, total_cost_pyg) VALUES ($1, $2, $3, $4, $5::app.uom, 'purchase_receipt', 0)",
        [TENANT, lot.rows[0]!.id, variantId, qty, uom],
      );
      return lot.rows[0]!.id;
    }

    async function newOrder(lines: { variantId: string; qty: string }[]): Promise<string> {
      const order = await sales.createOrder(db, ownerCtx, { channelId: CHANNEL, lines }, deps);
      return order.id;
    }

    /** Intenta tomar la fila con `mode ... NOWAIT` desde la sonda: `true` si la consiguió (nadie choca con ese modo). */
    async function canLock(
      mode: "FOR UPDATE" | "FOR NO KEY UPDATE" | "FOR KEY SHARE",
      table: "product_variants" | "inventory_lots",
      id: string,
    ): Promise<boolean> {
      await probe.query("BEGIN");
      try {
        await probe.query(`SELECT id FROM app.${table} WHERE id = $1 ${mode} NOWAIT`, [id]);
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === "55P03") return false;
        throw error;
      } finally {
        await probe.query("ROLLBACK");
      }
    }

    /** `FOR UPDATE NOWAIT` desde la sonda: dice si ALGUIEN tiene la fila tomada. */
    async function isHeld(
      table: "product_variants" | "inventory_lots",
      id: string,
    ): Promise<boolean> {
      return !(await canLock("FOR UPDATE", table, id));
    }

    async function waitForBlockedBackends(count: number): Promise<void> {
      for (let attempt = 0; attempt < 150; attempt++) {
        await q("SELECT pg_stat_clear_snapshot()");
        const blocked = await q<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'joda_api' AND wait_event_type = 'Lock'",
        );
        if (blocked.rows[0]!.n >= count) return;
        await sleep(40);
      }
      throw new Error(`nunca hubo ${count} conexión(es) esperando un bloqueo`);
    }

    async function withHeapPlansForApiRole(body: () => Promise<void>): Promise<void> {
      const settings = ["enable_indexscan", "enable_bitmapscan", "enable_indexonlyscan"];
      try {
        for (const setting of settings) await q(`ALTER ROLE joda_api SET ${setting} = off`);
        await db.$disconnect();
        await body();
      } finally {
        for (const setting of settings) await q(`ALTER ROLE joda_api RESET ${setting}`);
        await db.$disconnect();
      }
    }

    /**
     * Una transacción de `joda_api` que toma los bloqueos y se queda ahí hasta que la prueba
     * la suelta. Devuelve cuándo ya los tiene, los ids que quedaron bloqueados y cómo soltarla.
     */
    function holdLocks(take: (tx: TenantTx) => Promise<unknown>) {
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let acquired: () => void = () => undefined;
      let failed: (error: unknown) => void = () => undefined;
      const taken = new Promise<void>((resolve, reject) => {
        acquired = resolve;
        failed = reject;
      });
      const finished = withTenantTx(db, ownerCtx, async (tx) => {
        try {
          await take(tx);
        } catch (error) {
          failed(error);
          throw error;
        }
        acquired();
        await released;
      });
      finished.catch(() => undefined);
      return { taken, finished, release };
    }

    /**
     * Retiene `gateVariantId` con el superusuario, arranca `first` y `second` en ese orden de
     * llegada (esperando a que cada uno quede bloqueado), y suelta la compuerta. Los dos tienen que
     * terminar: un interbloqueo (40P01) hace fallar a uno, y esta prueba falla con él.
     */
    async function runBothWaiting(
      gateVariantId: string,
      first: () => Promise<unknown>,
      second: () => Promise<unknown>,
    ): Promise<PromiseSettledResult<unknown>[]> {
      await q("BEGIN");
      let gateOpen = true;
      try {
        await q("SELECT id FROM app.product_variants WHERE id = $1 FOR UPDATE", [gateVariantId]);
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

    beforeAll(async () => {
      testDb = await startTestDb();
      await q(
        "INSERT INTO app.tenants (id, slug, legal_name, trade_name) VALUES ($1, 'locks', 'JODA', 'JODA')",
        [TENANT],
      );
      await q("SELECT app.seed_roles($1)", [TENANT]);
      await q(
        "INSERT INTO app.staff_users (id, tenant_id, auth_subject, email, full_name) VALUES ($1, $3, 'locks-owner', 'locks-owner@test.local', 'Owner'), ($2, $3, 'locks-seller', 'locks-seller@test.local', 'Vendedor')",
        [OWNER, SELLER, TENANT],
      );
      await q(
        "INSERT INTO app.staff_user_roles (tenant_id, staff_user_id, role_id) SELECT $1, $2, id FROM app.roles WHERE tenant_id = $1 AND code = 'owner'",
        [TENANT, OWNER],
      );
      await q(
        "INSERT INTO app.staff_user_roles (tenant_id, staff_user_id, role_id) SELECT $1, $2, id FROM app.roles WHERE tenant_id = $1 AND code = 'vendedor'",
        [TENANT, SELLER],
      );
      await q(
        "INSERT INTO app.staff_sessions (id, tenant_id, staff_user_id, expires_at) VALUES ($1, $3, $4, now() + interval '1 day'), ($2, $3, $5, now() + interval '1 day')",
        [OWNER_SESSION, SELLER_SESSION, TENANT, OWNER, SELLER],
      );
      await q(
        "INSERT INTO app.sales_channels (id, tenant_id, code, name) VALUES ($1, $2, 'presencial', 'Mostrador')",
        [CHANNEL, TENANT],
      );

      // El de id alto primero: es el orden físico del heap.
      const accessory = await seedProduct("accessory");
      await seedVariant(W_HIGH, accessory, "LOCKS-HIGH", "unit");
      await seedVariant(W_LOW, accessory, "LOCKS-LOW", "unit");
      const perfume = await seedProduct("perfume");
      await seedVariant(SEALED, perfume, "LOCKS-SEALED", "sealed");
      await seedVariant(BULK, perfume, "LOCKS-BULK", "bulk");

      // Varias conexiones: estas pruebas ponen DOS transacciones de joda_api a esperarse entre sí,
      // y con la sola conexión que usan las demás la segunda ni siquiera llegaría a empezar.
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
    describe("lockVariantsThenLots", () => {
      it("toma la variante y el lote, devuelve lo bloqueado, y los suelta al terminar la transacción", async () => {
        const lotId = await seedLot(W_LOW, "unit", 5);
        const held = holdLocks((tx) =>
          lockVariantsThenLots(tx, TENANT, { variantIds: [W_LOW], lotIds: [lotId] }),
        );
        await held.taken;

        expect(await isHeld("product_variants", W_LOW)).toBe(true);
        expect(await isHeld("inventory_lots", lotId)).toBe(true);
        held.release();
        await held.finished;
        expect(await isHeld("product_variants", W_LOW)).toBe(false);
        expect(await isHeld("inventory_lots", lotId)).toBe(false);

        const locks = await withTenantTx(db, ownerCtx, (tx) =>
          lockVariantsThenLots(tx, TENANT, { variantIds: [W_LOW, W_LOW], lotIds: [lotId] }),
        );
        expect(locks).toEqual({ variantIds: [W_LOW], lotIds: [lotId] });
      });

      it("la variante va ANTES que el lote: mientras espera el lote, ya tiene la variante", async () => {
        const lotId = await seedLot(W_LOW, "unit", 5);
        await q("BEGIN");
        let released = false;
        try {
          await q("SELECT id FROM app.inventory_lots WHERE id = $1 FOR UPDATE", [lotId]);
          const pending = withTenantTx(db, ownerCtx, (tx) =>
            lockVariantsThenLots(tx, TENANT, { variantIds: [W_LOW], lotIds: [lotId] }),
          );
          await waitForBlockedBackends(1);

          // Esperando el lote, ya tiene la variante: quien viniera por el lote primero se cruzaría.
          expect(await isHeld("product_variants", W_LOW)).toBe(true);

          await q("COMMIT");
          released = true;
          await pending;
        } finally {
          if (!released) await q("ROLLBACK");
        }
      });

      it("las variantes se toman por id ascendente aunque lleguen al revés y estén guardadas al revés: esperando la de id bajo, no tiene la de id alto", async () => {
        await withHeapPlansForApiRole(async () => {
          await q("BEGIN");
          let released = false;
          try {
            await q("SELECT id FROM app.product_variants WHERE id = $1 FOR UPDATE", [W_LOW]);
            const pending = withTenantTx(db, ownerCtx, (tx) =>
              lockVariantsThenLots(tx, TENANT, { variantIds: [W_HIGH, W_LOW] }),
            );
            await waitForBlockedBackends(1);

            // Sin el `ORDER BY`, el heap la entrega primero y la tendría tomada.
            expect(await isHeld("product_variants", W_HIGH)).toBe(false);

            await q("COMMIT");
            released = true;
            await pending;
          } finally {
            if (!released) await q("ROLLBACK");
          }
        });
      });

      it("los lotes se toman por id ascendente aunque estén guardados al revés", async () => {
        const lotHigh = await seedLot(W_HIGH, "unit", 3, "ffffffff-0000-4000-8000-0000000000f1");
        const lotLow = await seedLot(W_LOW, "unit", 3, "00000000-0000-4000-8000-0000000000f2");
        await withHeapPlansForApiRole(async () => {
          await q("BEGIN");
          let released = false;
          try {
            await q("SELECT id FROM app.inventory_lots WHERE id = $1 FOR UPDATE", [lotLow]);
            const pending = withTenantTx(db, ownerCtx, (tx) =>
              lockVariantsThenLots(tx, TENANT, { variantIds: [], lotIds: [lotHigh, lotLow] }),
            );
            await waitForBlockedBackends(1);

            expect(await isHeld("inventory_lots", lotHigh)).toBe(false);

            await q("COMMIT");
            released = true;
            await pending;
          } finally {
            if (!released) await q("ROLLBACK");
          }
        });
      });

      it("allLotsOfVariants toma TODOS los lotes de las variantes, también los que no se nombran", async () => {
        const first = await seedLot(W_LOW, "unit", 1);
        const second = await seedLot(W_LOW, "unit", 1);
        const held = holdLocks((tx) =>
          lockVariantsThenLots(tx, TENANT, { variantIds: [W_LOW], allLotsOfVariants: true }),
        );
        await held.taken;

        expect(await isHeld("inventory_lots", first)).toBe(true);
        expect(await isHeld("inventory_lots", second)).toBe(true);
        held.release();
        await held.finished;
      });

      it("sin variantes ni lotes no toma nada", async () => {
        const locks = await withTenantTx(db, ownerCtx, (tx) =>
          lockVariantsThenLots(tx, TENANT, { variantIds: [] }),
        );

        expect(locks).toEqual({ variantIds: [], lotIds: [] });
      });

      it("el vendedor, que no lee lotes (inventory.stock:read), bloquea la variante y ningún lote, sin error", async () => {
        const lotId = await seedLot(W_LOW, "unit", 1);

        const locks = await withTenantTx(db, sellerCtx, (tx) =>
          lockVariantsThenLots(tx, TENANT, { variantIds: [W_LOW], lotIds: [lotId] }),
        );

        expect(locks).toEqual({ variantIds: [W_LOW], lotIds: [] });
      });
    });

    // -------------------------------------------------------------------
    describe("lockLotWithItsVariant · quien solo conoce el lote", () => {
      it("lee la variante sin bloquear, bloquea variante y lote, y la devuelve", async () => {
        const lotId = await seedLot(W_LOW, "unit", 2);
        let result: { variantId: string } | null = null;
        const held = holdLocks(async (tx) => {
          result = await lockLotWithItsVariant(tx, TENANT, lotId);
        });
        await held.taken;

        expect(result).toEqual({ variantId: W_LOW });
        expect(await isHeld("product_variants", W_LOW)).toBe(true);
        expect(await isHeld("inventory_lots", lotId)).toBe(true);
        held.release();
        await held.finished;
      });

      it("un lote que no existe es null y no bloquea nada", async () => {
        const result = await withTenantTx(db, ownerCtx, (tx) =>
          lockLotWithItsVariant(tx, TENANT, "00000000-0000-4000-8000-00000000dead"),
        );

        expect(result).toBeNull();
      });

      it("un lote que RLS le oculta a quien llama (el vendedor no lee lotes) es null: la cara de un permiso insuficiente", async () => {
        const lotId = await seedLot(W_LOW, "unit", 2);

        const result = await withTenantTx(db, sellerCtx, (tx) =>
          lockLotWithItsVariant(tx, TENANT, lotId),
        );

        expect(result).toBeNull();
      });
    });

    // -------------------------------------------------------------------
    describe("shareLockVariantsAscending · la FK de varias líneas no se cruza con un FOR UPDATE ascendente", () => {
      it("espera a quien tiene la variante con FOR UPDATE, pero no choca con otro KEY SHARE", async () => {
        const held = holdLocks(async (tx) => {
          await shareLockVariantsAscending(tx, TENANT, [W_HIGH, W_LOW]);
        });
        await held.taken;

        // Otro KEY SHARE (cualquier FK) y un FOR NO KEY UPDATE pasan; un FOR UPDATE espera.
        expect(await canLock("FOR KEY SHARE", "product_variants", W_LOW)).toBe(true);
        expect(await canLock("FOR NO KEY UPDATE", "product_variants", W_LOW)).toBe(true);
        expect(await isHeld("product_variants", W_LOW)).toBe(true);
        held.release();
        await held.finished;
      });

      it("sin variantes no hace nada", async () => {
        await expect(
          withTenantTx(db, ownerCtx, (tx) => shareLockVariantsAscending(tx, TENANT, [])),
        ).resolves.toBeUndefined();
      });

      it("crear un pedido con líneas [alta, baja] contra quien tiene la baja y pide la alta: sin interbloqueo", async () => {
        // Sin tomarlas antes, la FK del INSERT toma KEY SHARE sobre W_HIGH (la primera línea) y
        // después espera a W_LOW: el que retiene W_LOW pide W_HIGH con FOR UPDATE y se cruzan.
        await q("BEGIN");
        let released = false;
        try {
          await q("SET LOCAL lock_timeout = '4s'");
          await q("SELECT id FROM app.product_variants WHERE id = $1 FOR UPDATE", [W_LOW]);
          const creating = sales.createOrder(
            db,
            ownerCtx,
            {
              channelId: CHANNEL,
              lines: [
                { variantId: W_HIGH, qty: "1" },
                { variantId: W_LOW, qty: "1" },
              ],
            },
            deps,
          );
          await waitForBlockedBackends(1);

          await q("SELECT id FROM app.product_variants WHERE id = $1 FOR UPDATE", [W_HIGH]);
          await q("COMMIT");
          released = true;

          const order = await creating;
          expect(order.lines).toHaveLength(2);
        } finally {
          if (!released) await q("ROLLBACK");
        }
      });
    });

    // -------------------------------------------------------------------
    describe("sin interbloqueo, en los dos órdenes de llegada", () => {
      async function stockUp() {
        await seedLot(W_HIGH, "unit", 50);
        await seedLot(W_LOW, "unit", 50);
      }

      it("dos pedidos multilínea que piden las mismas variantes en orden contrario reservan los dos", async () => {
        await stockUp();
        const asc = await newOrder([
          { variantId: W_LOW, qty: "1" },
          { variantId: W_HIGH, qty: "1" },
        ]);
        const desc = await newOrder([
          { variantId: W_HIGH, qty: "1" },
          { variantId: W_LOW, qty: "1" },
        ]);
        const move = (id: string) =>
          sales.transitionOrder(db, ownerCtx, { id, toStatus: "awaiting_payment" }, deps);

        const ascFirst = await runBothWaiting(
          W_LOW,
          () => move(asc),
          () => move(desc),
        );
        expect(ascFirst.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);

        const asc2 = await newOrder([
          { variantId: W_LOW, qty: "1" },
          { variantId: W_HIGH, qty: "1" },
        ]);
        const desc2 = await newOrder([
          { variantId: W_HIGH, qty: "1" },
          { variantId: W_LOW, qty: "1" },
        ]);
        const descFirst = await runBothWaiting(
          W_LOW,
          () => move(desc2),
          () => move(asc2),
        );
        expect(descFirst.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
      });

      it("abrir un frasco (sellado + granel) y reservar un pedido con las mismas dos variantes: los dos pasan", async () => {
        await stockUp();
        const lotA = await seedLot(SEALED, "unit", 1);
        const lotB = await seedLot(SEALED, "unit", 1);
        await seedLot(SEALED, "unit", 4);
        await seedLot(BULK, "ml", 500);
        const open = (lotId: string) =>
          inventory.openLot(db, { clock, idGenerator: uuidGenerator }, requestContext(ownerCtx), {
            lotId,
          });
        const reserving = () =>
          newOrder([
            { variantId: SEALED, qty: "1" },
            { variantId: BULK, qty: "1" },
          ]);
        const move = (id: string) =>
          sales.transitionOrder(db, ownerCtx, { id, toStatus: "awaiting_payment" }, deps);
        const orderOne = await reserving();
        const orderTwo = await reserving();

        const openFirst = await runBothWaiting(
          BULK,
          () => open(lotA),
          () => move(orderOne),
        );
        expect(openFirst.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);

        const reserveFirst = await runBothWaiting(
          BULK,
          () => move(orderTwo),
          () => open(lotB),
        );
        expect(reserveFirst.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
      });

      it("un ajuste y la apertura del MISMO lote: los dos pasan (el ajuste ya no toma el lote antes que la variante)", async () => {
        // Con el orden viejo, el ajuste tomaba el lote y después esperaba a la variante (la FK de su
        // movimiento) mientras la apertura, con la variante, esperaba al lote: se cruzaban.
        const lotOne = await seedLot(SEALED, "unit", 3);
        const lotTwo = await seedLot(SEALED, "unit", 3);
        await seedLot(BULK, "ml", 500);
        const adjust = (lotId: string) =>
          inventory.createAdjustment(db, requestContext(ownerCtx), {
            lotId,
            qty: -1,
            reason: "rotura",
          });
        const open = (lotId: string) =>
          inventory.openLot(db, { clock, idGenerator: uuidGenerator }, requestContext(ownerCtx), {
            lotId,
          });

        const adjustFirst = await runBothWaiting(
          SEALED,
          () => adjust(lotOne),
          () => open(lotOne),
        );
        expect(adjustFirst.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);

        const openFirst = await runBothWaiting(
          SEALED,
          () => open(lotTwo),
          () => adjust(lotTwo),
        );
        expect(openFirst.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
      });
    });
  },
);
