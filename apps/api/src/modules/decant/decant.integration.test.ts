import { PrismaClient } from "@joda/db";
import type { AdminDecantWorkOrder, ExecuteDecantOutput, PlanDecantOutput } from "@joda/contracts";
import type { Clock } from "@joda/domain";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeStaffAuthProvider } from "../../adapters/staffAuth/fakeStaffAuthProvider.js";
import { jodaApiConnectionUrl, startTestDb, type TestDb } from "../../db/testDb.js";
import { buildServer } from "../../index.js";
import type { AuthServiceDeps } from "../auth/service.js";

// Integración real contra Postgres (.claude/rules/testing.md: "nunca
// simulacros de Prisma"), mismo arnés que inventory.integration.test.ts
// (WP-C10…C12). Cubre RF-FRA-01…06 (WP-C13): planificar, iniciar, ejecutar y
// listar órdenes de fraccionamiento, de punta a punta sobre el router real.
// Las validaciones de forma de los inputs (merma real obligatoria, qtyUnits
// entero, strict) ya están en packages/contracts/src/decant.test.ts.
const TENANT_ID = "77777777-7777-4777-a777-777777777713";
const OTHER_TENANT_ID = "88888888-8888-4888-a888-888888888813";
const STAFF_OWNER_ID = "99999999-9999-4999-a999-999999999913";
const STAFF_OWNER_EMAIL = "owner@jodaparfums-c13.com";
// Usuarios para probar quién NO puede (docs/api-conventions.md §4.3, §8.4): un
// vendedor del seed (sin `inventory.decant:execute` ni `inventory.stock:read`),
// un rol personalizado con SOLO `inventory.decant:execute`, y el dueño de otro tenant.
const STAFF_VENDEDOR_ID = "99999999-9999-4999-a999-999999999914";
const STAFF_VENDEDOR_EMAIL = "vendedor@jodaparfums-c13.com";
const STAFF_SOLO_DECANT_ID = "99999999-9999-4999-a999-999999999915";
const STAFF_SOLO_DECANT_EMAIL = "solo-decant@jodaparfums-c13.com";
const STAFF_OTHER_OWNER_ID = "99999999-9999-4999-a999-999999999916";
const STAFF_OTHER_OWNER_EMAIL = "owner@otro-c13.com";
const STAFF_PASSWORD = "correcta";
const MFA_ENCRYPTION_KEY = Buffer.from("3".repeat(64), "hex");
const PLACEHOLDER_MFA_SECRET = "placeholder-nunca-se-descifra-en-este-test";
const EXECUTED_AT = "2099-01-01T12:00:00.000Z";

function createManualClock(initial: Date): Clock {
  return { now: () => initial };
}

function toRequestCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("se esperaba un header Set-Cookie en la respuesta");
  const separator = raw.indexOf(";");
  return separator === -1 ? raw : raw.slice(0, separator);
}

interface Scenario {
  productId: string;
  bulkVariantId: string;
  decantVariantId: string;
  vialVariantId: string;
  atomizerVariantId: string;
  labelVariantId: string;
  labelSku: string;
  saleOrderId: string;
}

interface LotSeed {
  /** Para controlar el orden de `id` (la prueba del orden de bloqueo); si no, lo genera la base. */
  id?: string;
  qty: number;
  unitCostPyg: number;
  receivedAt?: string;
  openedAt?: string;
  status?: "available" | "open_for_decant";
}

describe(
  "fraccionamiento · WP-C13 (RF-FRA-01…06, RN-FRA-01…07, RN-EST-03)",
  { timeout: 30_000 },
  () => {
    let testDb: TestDb;
    let redisContainer: StartedRedisContainer;
    let db: PrismaClient;
    let redis: Redis;
    let app: FastifyInstance;
    let cookie: string;
    let channelId: string;
    let scenarioCounter = 0;

    async function call<T>(procedure: string, input: unknown): Promise<T> {
      const response = await app.inject({
        method: "GET",
        url: `/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`,
        headers: { cookie },
      });
      if (response.statusCode >= 400) {
        throw new Error(`${procedure} query → ${response.statusCode}: ${response.body}`);
      }
      return response.json().result.data as T;
    }

    async function mutate(
      procedure: string,
      payload: Record<string, unknown>,
      extraHeaders: Record<string, string> = {},
    ) {
      return app.inject({
        method: "POST",
        url: `/trpc/${procedure}`,
        headers: { cookie, ...extraHeaders },
        payload,
      });
    }

    /** Una petición como otro usuario (otra cookie): para probar quién NO puede. */
    function mutateAs(sessionCookie: string, procedure: string, payload: Record<string, unknown>) {
      return app.inject({
        method: "POST",
        url: `/trpc/${procedure}`,
        headers: { cookie: sessionCookie },
        payload,
      });
    }

    function callAs(sessionCookie: string, procedure: string, input: unknown) {
      return app.inject({
        method: "GET",
        url: `/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`,
        headers: { cookie: sessionCookie },
      });
    }

    async function mutateOk<T>(procedure: string, payload: Record<string, unknown>): Promise<T> {
      const response = await mutate(procedure, payload);
      if (response.statusCode >= 400) {
        throw new Error(`${procedure} mutation → ${response.statusCode}: ${response.body}`);
      }
      return response.json().result.data as T;
    }

    beforeAll(async () => {
      testDb = await startTestDb();

      await testDb.superuserClient.query(
        `INSERT INTO app.tenants (id, slug, legal_name, trade_name)
       VALUES ($1, 'joda-c13', 'JODA Parfums SRL', 'JODA Parfums'),
              ($2, 'otro-c13', 'Otro SA', 'Otro')`,
        [TENANT_ID, OTHER_TENANT_ID],
      );
      await testDb.superuserClient.query(`SELECT app.seed_roles($1)`, [TENANT_ID]);
      await testDb.superuserClient.query(
        `INSERT INTO app.staff_users
         (id, tenant_id, auth_subject, email, full_name, is_active, mfa_enrolled, mfa_secret_encrypted)
       VALUES ($1, $2, 'auth|owner-c13', $3, 'Test Owner', true, true, $4)`,
        [STAFF_OWNER_ID, TENANT_ID, STAFF_OWNER_EMAIL, PLACEHOLDER_MFA_SECRET],
      );
      const ownerRole = await testDb.superuserClient.query(
        `SELECT id FROM app.roles WHERE tenant_id = $1 AND code = 'owner'`,
        [TENANT_ID],
      );
      await testDb.superuserClient.query(
        `INSERT INTO app.staff_user_roles (tenant_id, staff_user_id, role_id) VALUES ($1, $2, $3)`,
        [TENANT_ID, STAFF_OWNER_ID, ownerRole.rows[0].id],
      );
      async function seedStaffUser(id: string, tenantId: string, email: string, roleId: string) {
        await testDb.superuserClient.query(
          `INSERT INTO app.staff_users
           (id, tenant_id, auth_subject, email, full_name, is_active, mfa_enrolled, mfa_secret_encrypted)
         VALUES ($1, $2, $3, $4, $5, true, true, $6)`,
          // $4 y $5 llevan el mismo texto pero NO pueden ser el mismo parámetro:
          // `email` es citext y `full_name` es text, y `pg` no unifica el tipo de
          // un `$n` reusado en columnas distintas ("inconsistent types deduced").
          [id, tenantId, `auth|${id}`, email, `Test ${email}`, PLACEHOLDER_MFA_SECRET],
        );
        await testDb.superuserClient.query(
          `INSERT INTO app.staff_user_roles (tenant_id, staff_user_id, role_id) VALUES ($1, $2, $3)`,
          [tenantId, id, roleId],
        );
      }
      const vendedorRole = await testDb.superuserClient.query(
        `SELECT id FROM app.roles WHERE tenant_id = $1 AND code = 'vendedor'`,
        [TENANT_ID],
      );
      await seedStaffUser(
        STAFF_VENDEDOR_ID,
        TENANT_ID,
        STAFF_VENDEDOR_EMAIL,
        vendedorRole.rows[0].id,
      );
      const soloDecantRole = await testDb.superuserClient.query(
        `INSERT INTO app.roles (tenant_id, code, name) VALUES ($1, 'solo_decant', 'Solo fraccionamiento')
       RETURNING id`,
        [TENANT_ID],
      );
      await testDb.superuserClient.query(
        `INSERT INTO app.role_permissions (tenant_id, role_id, permission_code)
       VALUES ($1, $2, 'inventory.decant:execute')`,
        [TENANT_ID, soloDecantRole.rows[0].id],
      );
      await seedStaffUser(
        STAFF_SOLO_DECANT_ID,
        TENANT_ID,
        STAFF_SOLO_DECANT_EMAIL,
        soloDecantRole.rows[0].id,
      );
      await testDb.superuserClient.query(`SELECT app.seed_roles($1)`, [OTHER_TENANT_ID]);
      const otherOwnerRole = await testDb.superuserClient.query(
        `SELECT id FROM app.roles WHERE tenant_id = $1 AND code = 'owner'`,
        [OTHER_TENANT_ID],
      );
      await seedStaffUser(
        STAFF_OTHER_OWNER_ID,
        OTHER_TENANT_ID,
        STAFF_OTHER_OWNER_EMAIL,
        otherOwnerRole.rows[0].id,
      );

      // La API de ventas (WP-C19) todavía no existe: el canal y los pedidos se
      // siembran por SQL, como los lotes (la venta es lo que dispara la orden).
      const channel = await testDb.superuserClient.query(
        `INSERT INTO app.sales_channels (tenant_id, code, name)
       VALUES ($1, 'presencial', 'Presencial') RETURNING id`,
        [TENANT_ID],
      );
      channelId = channel.rows[0].id;

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
            [STAFF_OWNER_EMAIL, { password: STAFF_PASSWORD, authSubject: "auth|owner-c13" }],
            [
              STAFF_VENDEDOR_EMAIL,
              { password: STAFF_PASSWORD, authSubject: `auth|${STAFF_VENDEDOR_ID}` },
            ],
            [
              STAFF_SOLO_DECANT_EMAIL,
              { password: STAFF_PASSWORD, authSubject: `auth|${STAFF_SOLO_DECANT_ID}` },
            ],
            [
              STAFF_OTHER_OWNER_EMAIL,
              { password: STAFF_PASSWORD, authSubject: `auth|${STAFF_OTHER_OWNER_ID}` },
            ],
          ]),
        ),
        // Fijo y FUTURO a propósito (WP-B13): la sesión nace con `expires_at` =
        // este reloj + 8 h y `app.has_permission()` la compara contra el `now()`
        // real de Postgres. También es el `executed_at` que estas pruebas esperan.
        clock: createManualClock(new Date(EXECUTED_AT)),
        mfaEncryptionKey: MFA_ENCRYPTION_KEY,
      };
      app = buildServer(authDeps, "0".repeat(32));

      cookie = await loginAs(STAFF_OWNER_EMAIL);
      await redis.flushall();
    });

    /** Inicia sesión como ese usuario (con el segundo factor ya verificado) y devuelve su cookie. */
    async function loginAs(email: string): Promise<string> {
      const loginResponse = await app.inject({
        method: "POST",
        url: "/trpc/auth.session.login",
        payload: { email, password: STAFF_PASSWORD },
      });
      const sessionCookie = toRequestCookie(loginResponse.headers["set-cookie"]);
      await testDb.superuserClient.query(
        `UPDATE app.staff_sessions SET mfa_verified_at = now()
       WHERE id = (
         SELECT s.id FROM app.staff_sessions s
         JOIN app.staff_users u ON u.id = s.staff_user_id
         WHERE u.email = $1 AND s.revoked_at IS NULL
         ORDER BY s.created_at DESC LIMIT 1
       )`,
        [email],
      );
      // La sesión ya quedó cacheada en Redis sin el segundo factor: sin vaciarlo,
      // la compuerta de MFA sigue viendo la versión anterior.
      await redis.flushall();
      return sessionCookie;
    }

    afterEach(async () => {
      await app.close();
      await redis.flushall();
      redis.disconnect();
    });

    // -------------------------------------------------------------------
    // Siembra. El producto y las variantes salen de la API real de catálogo
    // (WP-C08); lotes y ventas, por SQL (goods_receipt y las ventas son de
    // WP-C15 y WP-C19). Cada prueba arma su propio escenario con SKUs únicos.
    // -------------------------------------------------------------------
    async function createVariant(
      productId: string,
      sku: string,
      extra: Record<string, unknown>,
    ): Promise<string> {
      const variant = await mutateOk<{ id: string }>("catalog.variant.create", {
        productId,
        sku,
        pricePyg: "0",
        ...extra,
      });
      return variant.id;
    }

    /**
     * Un perfume con su granel, un decant de 10 ml bajo pedido y tres insumos en
     * el BOM: vial, atomizador (obligatorios) y etiqueta (opcional si se pide).
     */
    async function createScenario({ labelOptional = false } = {}): Promise<Scenario> {
      const suffix = String(++scenarioCounter);
      const category = await mutateOk<{ id: string }>("catalog.category.create", {
        slug: `fraccionamiento-${suffix}`,
        name: "Fraccionamiento",
      });
      const product = await mutateOk<{ id: string }>("catalog.product.create", {
        kind: "perfume",
        slug: `layton-fraccionamiento-${suffix}`,
        name: "Layton",
        categoryIds: [category.id],
        primaryCategoryId: category.id,
        perfumeDetails: {
          concentration: "edp",
          nominalVolumeMl: 100,
          olfactoryFamily: "amaderado",
          notesTop: [],
          notesHeart: [],
          notesBase: [],
          isDecantable: true,
          wasteFactor: 0.02,
          unusableResidueMl: 2,
          evaporationMlYear: 0.5,
        },
      });
      const bulkVariantId = await createVariant(product.id, `GRANEL-${suffix}`, {
        variantType: "bulk",
        uom: "ml",
        sizeMl: null,
      });
      const decantVariantId = await createVariant(product.id, `DECANT-10-${suffix}`, {
        variantType: "decant",
        uom: "ml",
        sizeMl: 10,
        productionMode: "made_to_order",
        sourceVariantId: bulkVariantId,
      });
      const vialVariantId = await createVariant(product.id, `VIAL-${suffix}`, {
        variantType: "supply",
        uom: "unit",
        sizeMl: null,
      });
      const atomizerVariantId = await createVariant(product.id, `ATOMIZADOR-${suffix}`, {
        variantType: "supply",
        uom: "unit",
        sizeMl: null,
      });
      const labelVariantId = await createVariant(product.id, `ETIQUETA-${suffix}`, {
        variantType: "supply",
        uom: "unit",
        sizeMl: null,
      });
      await mutateOk("catalog.bom.create", {
        parentVariantId: decantVariantId,
        componentVariantId: vialVariantId,
        qtyPerUnit: 1,
        uom: "unit",
      });
      await mutateOk("catalog.bom.create", {
        parentVariantId: decantVariantId,
        componentVariantId: atomizerVariantId,
        qtyPerUnit: 1,
        uom: "unit",
      });
      await mutateOk("catalog.bom.create", {
        parentVariantId: decantVariantId,
        componentVariantId: labelVariantId,
        qtyPerUnit: 1,
        uom: "unit",
        isOptional: labelOptional,
      });

      return {
        productId: product.id,
        bulkVariantId,
        decantVariantId,
        vialVariantId,
        atomizerVariantId,
        labelVariantId,
        labelSku: `ETIQUETA-${suffix}`,
        saleOrderId: await seedSaleOrder(TENANT_ID, channelId),
      };
    }

    async function seedSaleOrder(tenantId: string, saleChannelId: string): Promise<string> {
      const sale = await testDb.superuserClient.query(
        `INSERT INTO app.sale_orders (tenant_id, channel_id, code)
       VALUES ($1, $2, $3) RETURNING id`,
        [tenantId, saleChannelId, `VTA-C13-${++scenarioCounter}`],
      );
      return sale.rows[0].id;
    }

    /** Un lote con su recepción inicial; el saldo lo proyecta el trigger a partir del movimiento. */
    async function seedLot(
      variantId: string,
      uom: "unit" | "ml",
      { id, qty, unitCostPyg, receivedAt, openedAt, status = "available" }: LotSeed,
    ): Promise<string> {
      const lot = await testDb.superuserClient.query(
        `INSERT INTO app.inventory_lots
         (id, tenant_id, variant_id, status, qty_initial, uom,
          unit_cost_minor, currency, fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg,
          received_at, opened_at)
       VALUES (COALESCE($11::uuid, gen_random_uuid()), $1, $2, $3, $4, $5, $6, 'PYG', 1, $7, $8,
               COALESCE($9::timestamptz, now()), $10::timestamptz)
       RETURNING id`,
        [
          TENANT_ID,
          variantId,
          status,
          qty,
          uom,
          unitCostPyg,
          Math.round(qty * unitCostPyg),
          unitCostPyg,
          receivedAt ?? null,
          openedAt ?? null,
          id ?? null,
        ],
      );
      const lotId = lot.rows[0].id;
      await testDb.superuserClient.query(
        `INSERT INTO app.inventory_movements
         (tenant_id, lot_id, variant_id, qty, uom, movement_type, total_cost_pyg, created_by)
       VALUES ($1, $2, $3, $4, $5, 'purchase_receipt', $6, $7)`,
        [TENANT_ID, lotId, variantId, qty, uom, Math.round(qty * unitCostPyg), STAFF_OWNER_ID],
      );
      return lotId;
    }

    function seedBulkLot(variantId: string, seed: LotSeed): Promise<string> {
      return seedLot(variantId, "ml", {
        openedAt: "2026-03-01T10:00:00Z",
        status: "open_for_decant",
        ...seed,
      });
    }

    function seedSupplyLot(variantId: string, seed: LotSeed): Promise<string> {
      return seedLot(variantId, "unit", seed);
    }

    /** Los tres insumos del escenario con saldo y costo (vial 4.500, atomizador 2.500, etiqueta 300 Gs.). */
    async function seedSupplies(scenario: Scenario, qty = 100): Promise<void> {
      await seedSupplyLot(scenario.vialVariantId, { qty, unitCostPyg: 4_500 });
      await seedSupplyLot(scenario.atomizerVariantId, { qty, unitCostPyg: 2_500 });
      await seedSupplyLot(scenario.labelVariantId, { qty, unitCostPyg: 300 });
    }

    /** Vacía los lotes de una variante con una baja de ajuste, como lo haría un faltante real entre planificar y ejecutar. */
    async function drainSupply(variantId: string): Promise<void> {
      await testDb.superuserClient.query(
        `INSERT INTO app.inventory_movements
         (tenant_id, lot_id, variant_id, qty, uom, movement_type, created_by)
       SELECT b.tenant_id, b.lot_id, b.variant_id, -b.on_hand, 'unit', 'adjustment', $2
         FROM app.inventory_balances b
        WHERE b.variant_id = $1 AND b.on_hand > 0`,
        [variantId, STAFF_OWNER_ID],
      );
    }

    async function onHand(lotId: string): Promise<string> {
      const result = await testDb.superuserClient.query(
        `SELECT on_hand::text AS on_hand FROM app.inventory_balances WHERE lot_id = $1`,
        [lotId],
      );
      return result.rows[0].on_hand;
    }

    async function onHandOfVariant(variantId: string): Promise<string> {
      const result = await testDb.superuserClient.query(
        `SELECT COALESCE(sum(on_hand), 0)::text AS on_hand FROM app.inventory_balances WHERE variant_id = $1`,
        [variantId],
      );
      return result.rows[0].on_hand;
    }

    async function movementsOfOrder(orderId: string) {
      const result = await testDb.superuserClient.query(
        `SELECT movement_type, qty::text AS qty, total_cost_pyg::text AS total_cost_pyg,
              variant_id, reference_type, note
         FROM app.inventory_movements
        WHERE reference_id = $1
        ORDER BY id`,
        [orderId],
      );
      return result.rows;
    }

    async function countWorkOrders(): Promise<number> {
      const result = await testDb.superuserClient.query(
        `SELECT count(*)::int AS n FROM app.decant_work_orders WHERE tenant_id = $1`,
        [TENANT_ID],
      );
      return result.rows[0].n;
    }

    async function driftRows(): Promise<number> {
      const result = await testDb.superuserClient.query(
        `SELECT count(*)::int AS n FROM app.v_balance_drift WHERE tenant_id = $1`,
        [TENANT_ID],
      );
      return result.rows[0].n;
    }

    function plan(scenario: Scenario, extra: Record<string, unknown> = {}) {
      return mutate("inventory.decant.plan", {
        saleOrderId: scenario.saleOrderId,
        targetVariantId: scenario.decantVariantId,
        qtyUnits: 1,
        ...extra,
      });
    }

    async function planOk(
      scenario: Scenario,
      extra: Record<string, unknown> = {},
    ): Promise<PlanDecantOutput> {
      const response = await plan(scenario, extra);
      if (response.statusCode >= 400) {
        throw new Error(`plan → ${response.statusCode}: ${response.body}`);
      }
      return response.json().result.data;
    }

    function start(workOrderId: string) {
      return mutate("inventory.decant.start", { workOrderId });
    }

    async function startOk(workOrderId: string): Promise<AdminDecantWorkOrder> {
      return mutateOk("inventory.decant.start", { workOrderId });
    }

    function execute(workOrderId: string, wasteActual: number) {
      return mutate("inventory.decant.execute", { workOrderId, wasteActual });
    }

    /** Planifica un decant de 1 unidad con el granel dado y lo deja `in_progress`, listo para ejecutar. */
    async function plannedAndStarted(scenario: Scenario): Promise<string> {
      const planned = await planOk(scenario);
      await startOk(planned.order.id);
      return planned.order.id;
    }

    /**
     * Retiene el bloqueo del lote desde otra conexión, dispara la petición y
     * comprueba que NO termina mientras dure; al soltarlo, termina. Devuelve el
     * status con el que terminó. Es `NO KEY UPDATE` y no `UPDATE` a propósito:
     * el `INSERT` de un movimiento toma `FOR KEY SHARE` sobre el lote por la
     * FK, y `FOR UPDATE` lo haría esperar ahí aunque la petición no hubiera
     * tomado su propio bloqueo. Con `NO KEY UPDATE` la FK no espera, así que solo
     * una petición que bloquea el lote antes de leer queda detenida. Dos
     * peticiones simultáneas no alcanzan como prueba: se ordenan solas (y el
     * `CHECK` de saldo no negativo las haría fallar igual).
     */
    async function requestWaitsForLotLock(
      lotId: string,
      request: () => Promise<{ statusCode: number }>,
    ): Promise<number> {
      await testDb.superuserClient.query("BEGIN");
      let released = false;
      try {
        await testDb.superuserClient.query(
          "SELECT id FROM app.inventory_lots WHERE id = $1 FOR NO KEY UPDATE",
          [lotId],
        );
        let settled = false;
        const pending = request().then((response) => {
          settled = true;
          return response;
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(settled).toBe(false);
        await testDb.superuserClient.query("COMMIT");
        released = true;
        return (await pending).statusCode;
      } finally {
        if (!released) await testDb.superuserClient.query("ROLLBACK");
      }
    }

    /** Espera a que una petición quede detenida en un bloqueo de fila: sin esto, sondear "antes de que llegue" daría un falso verde. */
    async function waitUntilABackendIsBlockedOnALock(): Promise<void> {
      for (let attempt = 0; attempt < 100; attempt++) {
        // Dentro de una transacción, pg_stat_activity devuelve la foto del primer
        // acceso (stats_fetch_consistency = cache): sin descartarla nunca se ve el cambio.
        await testDb.superuserClient.query("SELECT pg_stat_clear_snapshot()");
        const blocked = await testDb.superuserClient.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
        );
        if (blocked.rows[0].n > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("la petición nunca quedó esperando un bloqueo");
    }

    /**
     * Fuerza para `joda_api` el recorrido del heap (sin índice) y lo devuelve a su
     * estado. Bajo RLS el plan normal recorre `inventory_lots_id_tenant_key` y ya
     * entrega las filas ordenadas por `id`, así que sin esto un `ORDER BY` de
     * menos no se nota. `ALTER ROLE ... SET` solo vale para conexiones nuevas: hay
     * que reconectar el pool, al entrar y al salir.
     */
    async function withHeapPlansForApiRole(body: () => Promise<void>): Promise<void> {
      const settings = ["enable_indexscan", "enable_bitmapscan", "enable_indexonlyscan"];
      try {
        for (const setting of settings) {
          await testDb.superuserClient.query(`ALTER ROLE joda_api SET ${setting} = off`);
        }
        await db.$disconnect();
        await body();
      } finally {
        for (const setting of settings) {
          await testDb.superuserClient.query(`ALTER ROLE joda_api RESET ${setting}`);
        }
        await db.$disconnect();
      }
    }

    function errorCode(response: { json(): { error: { data: { appCode: string } } } }): string {
      return response.json().error.data.appCode;
    }

    // -------------------------------------------------------------------
    describe("RN-FRA-01 / RN-FRA-02 · planificar es el compromiso: crea la orden y no consume (RF-FRA-01)", () => {
      it("crea una orden pendiente con los ml y la merma esperada, ligada a la venta y al granel", async () => {
        const scenario = await createScenario();
        const bulkLotId = await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
        });
        await seedSupplies(scenario);

        const planned = await planOk(scenario);

        expect(planned.order).toMatchObject({
          saleOrderId: scenario.saleOrderId,
          sourceLotId: bulkLotId,
          targetVariantId: scenario.decantVariantId,
          qtyUnits: 1,
          mlPerUnit: 10,
          mlExpected: 10,
          wasteExpected: 0.2,
          wasteActual: null,
          status: "pending",
          executedBy: null,
          executedAt: null,
          createdBy: STAFF_OWNER_ID,
        });
        expect(planned.mlToReserve).toBe(10.2);
        expect(planned.bom).toHaveLength(3);
      });

      it("escala con la cantidad: 3 decants de 10 ml comprometen 30 ml más 0,6 ml de merma", async () => {
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, { qty: 114.65, unitCostPyg: 11_972 });
        await seedSupplies(scenario);

        const planned = await planOk(scenario, { qtyUnits: 3 });

        expect(planned.order).toMatchObject({ qtyUnits: 3, mlExpected: 30, wasteExpected: 0.6 });
        expect(planned.mlToReserve).toBe(30.6);
      });

      it("no consume inventario: ni un movimiento nuevo, ni el saldo del granel ni el de los insumos cambian", async () => {
        const scenario = await createScenario();
        const bulkLotId = await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
        });
        await seedSupplies(scenario);

        const planned = await planOk(scenario);

        expect(await onHand(bulkLotId)).toBe("114.650");
        expect(await onHandOfVariant(scenario.vialVariantId)).toBe("100.000");
        expect(await movementsOfOrder(planned.order.id)).toEqual([]);
      });

      it("una venta que no existe en el tenant se rechaza con 404 y no crea ninguna orden (§8.4)", async () => {
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, { qty: 114.65, unitCostPyg: 11_972 });
        await seedSupplies(scenario);
        await testDb.superuserClient.query(
          `INSERT INTO app.sales_channels (id, tenant_id, code, name)
         VALUES ('88888888-8888-4888-a888-8888888888c1', $1, 'presencial', 'Presencial')`,
          [OTHER_TENANT_ID],
        );
        const foreignSale = await seedSaleOrder(
          OTHER_TENANT_ID,
          "88888888-8888-4888-a888-8888888888c1",
        );
        const before = await countWorkOrders();

        const response = await plan({ ...scenario, saleOrderId: foreignSale });

        expect(response.statusCode).toBe(404);
        expect(await countWorkOrders()).toBe(before);
      });

      it("una variante que no es un decant se rechaza", async () => {
        const scenario = await createScenario();

        const response = await plan(scenario, { targetVariantId: scenario.bulkVariantId });

        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe("CONFLICT_VARIANT_NOT_DECANT");
      });

      it("un decant que se produce para stock se rechaza: producir por anticipado es otro flujo (RF-FRA-10)", async () => {
        const scenario = await createScenario();
        const stockedDecant = await createVariant(
          scenario.productId,
          `DECANT-STOCK-${scenarioCounter}`,
          {
            variantType: "decant",
            uom: "ml",
            sizeMl: 5,
          },
        );

        const response = await plan(scenario, { targetVariantId: stockedDecant });

        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe("CONFLICT_VARIANT_NOT_MADE_TO_ORDER");
      });

      it("un insumo obligatorio sin stock rechaza la planificación entera, antes de crear nada", async () => {
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, { qty: 114.65, unitCostPyg: 11_972 });
        await seedSupplyLot(scenario.vialVariantId, { qty: 100, unitCostPyg: 4_500 });
        await seedSupplyLot(scenario.labelVariantId, { qty: 100, unitCostPyg: 300 });
        const before = await countWorkOrders();

        const response = await plan(scenario);

        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe("CONFLICT_INSUFFICIENT_BOM_COMPONENT");
        expect(response.json().error.data.details.componentVariantId).toBe(
          scenario.atomizerVariantId,
        );
        expect(await countWorkOrders()).toBe(before);
      });

      it("repetir la misma Idempotency-Key devuelve la misma orden y no crea otra", async () => {
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, { qty: 114.65, unitCostPyg: 11_972 });
        await seedSupplies(scenario);
        const payload = {
          saleOrderId: scenario.saleOrderId,
          targetVariantId: scenario.decantVariantId,
          qtyUnits: 1,
        };
        const before = await countWorkOrders();

        const first = await mutate("inventory.decant.plan", payload, {
          "idempotency-key": "plan-1",
        });
        const second = await mutate("inventory.decant.plan", payload, {
          "idempotency-key": "plan-1",
        });

        expect(second.json().result.data.order.id).toBe(first.json().result.data.order.id);
        expect(await countWorkOrders()).toBe(before + 1);
      });
    });

    // -------------------------------------------------------------------
    describe("RN-FRA-07 · el granel de origen lo elige el servidor: el abierto más antiguo que alcance", () => {
      it("elige el frasco de apertura más antigua (opened_at), no el recibido primero (received_at)", async () => {
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
          receivedAt: "2026-01-01T10:00:00Z",
          openedAt: "2026-03-01T10:00:00Z",
        });
        const openedFirst = await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
          receivedAt: "2026-02-01T10:00:00Z",
          openedAt: "2026-02-15T10:00:00Z",
        });
        await seedSupplies(scenario);

        const planned = await planOk(scenario);

        expect(planned.order.sourceLotId).toBe(openedFirst);
      });

      it("salta el frasco más antiguo si no alcanza para la orden completa y toma el siguiente que sí", async () => {
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, {
          qty: 5,
          unitCostPyg: 11_972,
          openedAt: "2026-02-15T10:00:00Z",
        });
        const enough = await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
          openedAt: "2026-03-01T10:00:00Z",
        });
        await seedSupplies(scenario);

        const planned = await planOk(scenario);

        expect(planned.order.sourceLotId).toBe(enough);
      });

      it("si ningún frasco abierto alcanza solo se rechaza y dice que hay que abrir uno: no abre ninguno (irreversible)", async () => {
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, { qty: 6, unitCostPyg: 11_972 });
        await seedBulkLot(scenario.bulkVariantId, { qty: 6, unitCostPyg: 11_972 });
        await seedSupplies(scenario);
        const lotsBefore = await testDb.superuserClient.query(
          `SELECT count(*)::int AS n FROM app.inventory_lots WHERE tenant_id = $1`,
          [TENANT_ID],
        );
        const ordersBefore = await countWorkOrders();

        const response = await plan(scenario);

        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe("CONFLICT_NO_BULK_AVAILABLE");
        expect(response.json().error.message).toContain("Abrí un frasco");
        expect(response.json().error.data.details).toEqual({
          requiredMl: 10.2,
          largestAvailableMl: 6,
        });
        const lotsAfter = await testDb.superuserClient.query(
          `SELECT count(*)::int AS n FROM app.inventory_lots WHERE tenant_id = $1`,
          [TENANT_ID],
        );
        expect(lotsAfter.rows[0].n).toBe(lotsBefore.rows[0].n);
        expect(await countWorkOrders()).toBe(ordersBefore);
      });

      it("sin ningún granel abierto también se rechaza con el mismo mensaje", async () => {
        const scenario = await createScenario();
        await seedSupplies(scenario);

        const response = await plan(scenario);

        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe("CONFLICT_NO_BULK_AVAILABLE");
      });

      it("un lote de granel que todavía no se abrió (available) no es granel decantable", async () => {
        const scenario = await createScenario();
        const closed = await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
          status: "available",
        });
        await seedSupplies(scenario);

        const response = await plan(scenario, { sourceLotId: closed });

        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe("CONFLICT_SOURCE_LOT_NOT_DECANTABLE");
      });

      it("con sourceLotId se usa ese frasco aunque haya otro de apertura más antigua", async () => {
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
          openedAt: "2026-02-15T10:00:00Z",
        });
        const chosen = await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
          openedAt: "2026-03-01T10:00:00Z",
        });
        await seedSupplies(scenario);

        const planned = await planOk(scenario, { sourceLotId: chosen });

        expect(planned.order.sourceLotId).toBe(chosen);
      });

      it("con sourceLotId que no alcanza se rechaza por granel insuficiente, sin saltar a otro frasco", async () => {
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, { qty: 114.65, unitCostPyg: 11_972 });
        const short = await seedBulkLot(scenario.bulkVariantId, { qty: 6, unitCostPyg: 11_972 });
        await seedSupplies(scenario);

        const response = await plan(scenario, { sourceLotId: short });

        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe("CONFLICT_INSUFFICIENT_BULK");
      });

      it("con sourceLotId de otro granel (otra variante) se rechaza", async () => {
        const scenario = await createScenario();
        const otherScenario = await createScenario();
        const foreignBulk = await seedBulkLot(otherScenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
        });
        await seedSupplies(scenario);

        const response = await plan(scenario, { sourceLotId: foreignBulk });

        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe("CONFLICT_SOURCE_LOT_VARIANT_MISMATCH");
      });

      it("un sellado abierto no es granel: aunque comparta el estado open_for_decant, se rechaza (RN-FRA-07)", async () => {
        const scenario = await createScenario();
        // Un decant mal configurado cuyo origen es una variante SELLADA: el único
        // camino por el que un lote sellado llega a ser candidato. Lo lleva a ese
        // estado un UPDATE directo (el ETL, una carga a mano): desde WP-C08m el catálogo
        // ya no deja fijar un origen que no sea el granel (RN-CAT-06). Lo que frena la
        // planificación es el tipo de variante del lote, no su estado.
        const sealedVariant = await createVariant(
          scenario.productId,
          `SELLADO-${scenarioCounter}`,
          {
            variantType: "sealed",
            uom: "unit",
            sizeMl: 100,
          },
        );
        const misconfiguredDecant = await createVariant(
          scenario.productId,
          `DECANT-SELLADO-${scenarioCounter}`,
          {
            variantType: "decant",
            uom: "ml",
            sizeMl: 5,
            productionMode: "made_to_order",
            sourceVariantId: scenario.bulkVariantId,
          },
        );
        await testDb.superuserClient.query(
          `UPDATE app.product_variants SET source_variant_id = $1 WHERE id = $2`,
          [sealedVariant, misconfiguredDecant],
        );
        // Un sellado abierto no admite movimientos (RN-LOT-03): se recibe y
        // recién después pasa a open_for_decant.
        const openedSealedLot = await seedLot(sealedVariant, "unit", {
          qty: 1,
          unitCostPyg: 1_496_500,
        });
        await testDb.superuserClient.query(
          `UPDATE app.inventory_lots SET status = 'open_for_decant', opened_at = '2026-03-01T10:00:00Z'
          WHERE id = $1`,
          [openedSealedLot],
        );

        const response = await plan(scenario, {
          targetVariantId: misconfiguredDecant,
          sourceLotId: openedSealedLot,
        });

        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe("CONFLICT_SOURCE_LOT_NOT_DECANTABLE");
      });

      it("con un sourceLotId que no existe se responde 404", async () => {
        const scenario = await createScenario();

        const response = await plan(scenario, {
          sourceLotId: "00000000-0000-4000-a000-000000000000",
        });

        expect(response.statusCode).toBe(404);
      });
    });

    // -------------------------------------------------------------------
    describe("RN-EST-03 · iniciar la orden: pending → in_progress", () => {
      it("pasa la orden a en curso sin tocar el inventario", async () => {
        const scenario = await createScenario();
        const bulkLotId = await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
        });
        await seedSupplies(scenario);
        const planned = await planOk(scenario);

        const started = await startOk(planned.order.id);

        expect(started).toMatchObject({ id: planned.order.id, status: "in_progress" });
        expect(await onHand(bulkLotId)).toBe("114.650");
      });

      it("iniciar una orden que ya está en curso se rechaza con un mensaje claro", async () => {
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, { qty: 114.65, unitCostPyg: 11_972 });
        await seedSupplies(scenario);
        const orderId = await plannedAndStarted(scenario);

        const response = await start(orderId);

        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe("CONFLICT_INVALID_TRANSITION");
        expect(response.json().error.message).toBe(
          "La orden está en curso y no admite esta acción.",
        );
      });

      it("una orden inexistente responde 404", async () => {
        const response = await start("00000000-0000-4000-a000-000000000000");

        expect(response.statusCode).toBe(404);
      });

      it("si otra transacción ya la está tomando, la segunda espera, relee y se rechaza: no la pisa", async () => {
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, { qty: 114.65, unitCostPyg: 11_972 });
        await seedSupplies(scenario);
        const planned = await planOk(scenario);

        // Dos peticiones simultáneas no prueban el bloqueo (se ordenan solas, y
        // sin él pasan igual). Esto sí: otra transacción deja la orden en curso
        // SIN confirmar mientras la petición arranca. Con el bloqueo espera,
        // relee y responde 409; sin él lee `pending`, espera en el UPDATE y la
        // pisa con un 200.
        await testDb.superuserClient.query("BEGIN");
        let released = false;
        try {
          await testDb.superuserClient.query(
            `UPDATE app.decant_work_orders SET status = 'in_progress' WHERE id = $1`,
            [planned.order.id],
          );
          let settled = false;
          const pending = start(planned.order.id).then((response) => {
            settled = true;
            return response;
          });
          await new Promise((resolve) => setTimeout(resolve, 500));
          expect(settled).toBe(false);
          await testDb.superuserClient.query("COMMIT");
          released = true;

          const response = await pending;

          expect(response.statusCode).toBe(409);
          expect(errorCode(response)).toBe("CONFLICT_INVALID_TRANSITION");
        } finally {
          if (!released) await testDb.superuserClient.query("ROLLBACK");
        }
      });
    });

    // -------------------------------------------------------------------
    describe("RN-FRA-03 / RN-FRA-04 · ejecutar consume todo en una transacción, con la merma real", () => {
      it("el ejemplo verificado de Layton: COGS 131.210 = líquido 119.720 + merma 4.190 + insumos 7.300 (RF-FRA-04)", async () => {
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, { qty: 114.65, unitCostPyg: 11_972 });
        await seedSupplies(scenario);
        const orderId = await plannedAndStarted(scenario);

        const executed = await mutateOk<ExecuteDecantOutput>("inventory.decant.execute", {
          workOrderId: orderId,
          wasteActual: 0.35,
        });

        expect(executed.cogs).toBe("131210");
        expect(executed.costBreakdown).toEqual({
          liquid: "119720",
          waste: "4190",
          supplies: "7300",
        });
        expect(executed.skippedOptionalComponentIds).toEqual([]);
      });

      it("descuenta del granel el líquido y la merma real, y un insumo de cada uno, en el ledger (RF-FRA-03)", async () => {
        const scenario = await createScenario();
        const bulkLotId = await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
        });
        await seedSupplies(scenario);
        const orderId = await plannedAndStarted(scenario);

        await mutateOk<ExecuteDecantOutput>("inventory.decant.execute", {
          workOrderId: orderId,
          wasteActual: 0.35,
        });

        const movements = await movementsOfOrder(orderId);
        expect(movements).toHaveLength(5);
        expect(movements).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              movement_type: "decant_consumption",
              qty: "-10.000",
              total_cost_pyg: "119720",
              variant_id: scenario.bulkVariantId,
              reference_type: "decant_work_order",
            }),
            expect.objectContaining({
              movement_type: "waste",
              qty: "-0.350",
              total_cost_pyg: "4190",
              variant_id: scenario.bulkVariantId,
            }),
            expect.objectContaining({
              movement_type: "bom_consumption",
              qty: "-1.000",
              total_cost_pyg: "4500",
              variant_id: scenario.vialVariantId,
            }),
            expect.objectContaining({
              movement_type: "bom_consumption",
              qty: "-1.000",
              total_cost_pyg: "2500",
              variant_id: scenario.atomizerVariantId,
            }),
            expect.objectContaining({
              movement_type: "bom_consumption",
              qty: "-1.000",
              total_cost_pyg: "300",
              variant_id: scenario.labelVariantId,
            }),
          ]),
        );
        expect(await onHand(bulkLotId)).toBe("104.300");
        expect(await onHandOfVariant(scenario.vialVariantId)).toBe("99.000");
      });

      it("cada salida registra su capa de costo, y la suma de las capas es el COGS", async () => {
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, { qty: 114.65, unitCostPyg: 11_972 });
        await seedSupplies(scenario);
        const orderId = await plannedAndStarted(scenario);

        await mutateOk<ExecuteDecantOutput>("inventory.decant.execute", {
          workOrderId: orderId,
          wasteActual: 0.35,
        });

        const allocations = await testDb.superuserClient.query(
          `SELECT count(*)::int AS capas, sum(a.total_cost_pyg)::text AS total
           FROM app.movement_cost_allocations a
           JOIN app.inventory_movements m ON m.id = a.movement_id
          WHERE m.reference_id = $1`,
          [orderId],
        );
        expect(allocations.rows[0]).toEqual({ capas: 5, total: "131210" });
      });

      it("deja la orden ejecutada con la merma real, el ejecutor de la sesión y el momento del reloj (RF-FRA-02)", async () => {
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, { qty: 114.65, unitCostPyg: 11_972 });
        await seedSupplies(scenario);
        const orderId = await plannedAndStarted(scenario);

        const executed = await mutateOk<ExecuteDecantOutput>("inventory.decant.execute", {
          workOrderId: orderId,
          wasteActual: 0.35,
        });

        expect(executed.order).toMatchObject({
          id: orderId,
          status: "done",
          wasteExpected: 0.2,
          wasteActual: 0.35,
          executedBy: STAFF_OWNER_ID,
          executedAt: EXECUTED_AT,
        });
        expect(executed.movements).toHaveLength(5);
      });

      it("la proyección de saldos no deriva del ledger tras ejecutar (v_balance_drift vacía)", async () => {
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, { qty: 114.65, unitCostPyg: 11_972 });
        await seedSupplies(scenario);
        const orderId = await plannedAndStarted(scenario);

        await mutateOk<ExecuteDecantOutput>("inventory.decant.execute", {
          workOrderId: orderId,
          wasteActual: 0.35,
        });

        expect(await driftRows()).toBe(0);
      });

      it("deja el rastro en audit_log con el ejecutor y el COGS", async () => {
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, { qty: 114.65, unitCostPyg: 11_972 });
        await seedSupplies(scenario);
        const orderId = await plannedAndStarted(scenario);

        await mutateOk<ExecuteDecantOutput>("inventory.decant.execute", {
          workOrderId: orderId,
          wasteActual: 0.35,
        });

        const audit = await testDb.superuserClient.query(
          `SELECT actor_id, after->>'cogsPyg' AS cogs, after->>'wasteActual' AS waste
           FROM app.audit_log
          WHERE action = 'inventory.decant.execute' AND entity_id = $1`,
          [orderId],
        );
        expect(audit.rows).toEqual([{ actor_id: STAFF_OWNER_ID, cogs: "131210", waste: "0.35" }]);
      });

      it("ejecutar sin merma real se rechaza y no consume nada (RF-FRA-05)", async () => {
        const scenario = await createScenario();
        const bulkLotId = await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
        });
        await seedSupplies(scenario);
        const orderId = await plannedAndStarted(scenario);

        const response = await mutate("inventory.decant.execute", { workOrderId: orderId });

        expect(response.statusCode).toBe(400);
        expect(await onHand(bulkLotId)).toBe("114.650");
        expect(await movementsOfOrder(orderId)).toEqual([]);
      });

      it("una orden que todavía no se inició no se puede ejecutar: primero se toma", async () => {
        const scenario = await createScenario();
        const bulkLotId = await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
        });
        await seedSupplies(scenario);
        const planned = await planOk(scenario);

        const response = await execute(planned.order.id, 0.35);

        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe("CONFLICT_ORDER_NOT_STARTED");
        expect(await onHand(bulkLotId)).toBe("114.650");
      });

      it("una orden ya ejecutada no se ejecuta dos veces: el saldo se descuenta una sola vez", async () => {
        const scenario = await createScenario();
        const bulkLotId = await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
        });
        await seedSupplies(scenario);
        const orderId = await plannedAndStarted(scenario);
        await mutateOk<ExecuteDecantOutput>("inventory.decant.execute", {
          workOrderId: orderId,
          wasteActual: 0.35,
        });

        const response = await execute(orderId, 0.35);

        expect(response.statusCode).toBe(409);
        expect(response.json().error.message).toBe(
          "La orden está ejecutada y no admite esta acción.",
        );
        expect(await onHand(bulkLotId)).toBe("104.300");
      });

      it("una merma real de 0 es una declaración válida: se ejecuta sin movimiento de merma", async () => {
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, { qty: 114.65, unitCostPyg: 11_972 });
        await seedSupplies(scenario);
        const orderId = await plannedAndStarted(scenario);

        const executed = await mutateOk<ExecuteDecantOutput>("inventory.decant.execute", {
          workOrderId: orderId,
          wasteActual: 0,
        });

        expect(executed.order.wasteActual).toBe(0);
        expect(executed.costBreakdown.waste).toBe("0");
        expect(executed.movements).toHaveLength(4);
      });

      it("cada insumo sale de su lote más antiguo (FIFO), no del último cargado", async () => {
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, { qty: 114.65, unitCostPyg: 11_972 });
        const newer = await seedSupplyLot(scenario.vialVariantId, {
          qty: 50,
          unitCostPyg: 5_000,
          receivedAt: "2026-02-01T10:00:00Z",
        });
        const older = await seedSupplyLot(scenario.vialVariantId, {
          qty: 50,
          unitCostPyg: 4_500,
          receivedAt: "2026-01-01T10:00:00Z",
        });
        await seedSupplyLot(scenario.atomizerVariantId, { qty: 100, unitCostPyg: 2_500 });
        await seedSupplyLot(scenario.labelVariantId, { qty: 100, unitCostPyg: 300 });
        const orderId = await plannedAndStarted(scenario);

        const executed = await mutateOk<ExecuteDecantOutput>("inventory.decant.execute", {
          workOrderId: orderId,
          wasteActual: 0.35,
        });

        expect(await onHand(older)).toBe("49.000");
        expect(await onHand(newer)).toBe("50.000");
        expect(executed.costBreakdown.supplies).toBe("7300");
      });
    });

    // -------------------------------------------------------------------
    describe("Casos borde 2, 3 y 4 de docs/domain-rules.md · lo que falla en la ejecución", () => {
      it("caso 2 · una merma real mayor a la reservada se permite y se consume lo real", async () => {
        const scenario = await createScenario();
        const bulkLotId = await seedBulkLot(scenario.bulkVariantId, {
          qty: 20,
          unitCostPyg: 11_972,
        });
        await seedSupplies(scenario);
        const orderId = await plannedAndStarted(scenario);

        const executed = await mutateOk<ExecuteDecantOutput>("inventory.decant.execute", {
          workOrderId: orderId,
          wasteActual: 0.5,
        });

        expect(executed.order).toMatchObject({ wasteExpected: 0.2, wasteActual: 0.5 });
        expect(executed.costBreakdown.waste).toBe("5986");
        expect(await onHand(bulkLotId)).toBe("9.500");
      });

      it("caso 2 · si la merma real no cabe en el granel, no se ejecuta nada y la orden queda en curso", async () => {
        const scenario = await createScenario();
        const bulkLotId = await seedBulkLot(scenario.bulkVariantId, {
          qty: 10.2,
          unitCostPyg: 11_972,
        });
        await seedSupplies(scenario);
        const orderId = await plannedAndStarted(scenario);

        const response = await execute(orderId, 0.5);

        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe("CONFLICT_INSUFFICIENT_BULK_FOR_ACTUAL");
        expect(response.json().error.data.details).toEqual({ required: 10.5, available: 10.2 });
        expect(await onHand(bulkLotId)).toBe("10.200");
        expect(await onHandOfVariant(scenario.vialVariantId)).toBe("100.000");
        expect(await movementsOfOrder(orderId)).toEqual([]);
        const order = await testDb.superuserClient.query(
          `SELECT status::text AS status FROM app.decant_work_orders WHERE id = $1`,
          [orderId],
        );
        expect(order.rows[0].status).toBe("in_progress");
      });

      it("caso 3 · si falta un insumo obligatorio se rechaza todo: no se consume ni el granel ni los otros insumos", async () => {
        const scenario = await createScenario();
        const bulkLotId = await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
        });
        await seedSupplies(scenario);
        const orderId = await plannedAndStarted(scenario);
        await drainSupply(scenario.atomizerVariantId);

        const response = await execute(orderId, 0.35);

        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe("CONFLICT_MISSING_BOM_COMPONENT");
        expect(response.json().error.data.details.componentVariantId).toBe(
          scenario.atomizerVariantId,
        );
        expect(await onHand(bulkLotId)).toBe("114.650");
        expect(await onHandOfVariant(scenario.vialVariantId)).toBe("100.000");
        expect(await movementsOfOrder(orderId)).toEqual([]);
        const order = await testDb.superuserClient.query(
          `SELECT status::text AS status FROM app.decant_work_orders WHERE id = $1`,
          [orderId],
        );
        expect(order.rows[0].status).toBe("in_progress");
      });

      it("caso 4 · si falta un insumo opcional se ejecuta sin él y queda dicho en el movimiento del líquido", async () => {
        const scenario = await createScenario({ labelOptional: true });
        await seedBulkLot(scenario.bulkVariantId, { qty: 114.65, unitCostPyg: 11_972 });
        await seedSupplies(scenario);
        const orderId = await plannedAndStarted(scenario);
        await drainSupply(scenario.labelVariantId);

        const executed = await mutateOk<ExecuteDecantOutput>("inventory.decant.execute", {
          workOrderId: orderId,
          wasteActual: 0.35,
        });

        expect(executed.skippedOptionalComponentIds).toEqual([scenario.labelVariantId]);
        expect(executed.costBreakdown.supplies).toBe("7000");
        expect(executed.cogs).toBe("130910");
        const movements = await movementsOfOrder(orderId);
        expect(movements).toHaveLength(4);
        expect(movements).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              movement_type: "decant_consumption",
              note: `Ejecutada sin el insumo opcional faltante: ${scenario.labelSku}.`,
            }),
          ]),
        );
      });

      it("un insumo repartido entre lotes que ninguno cubre solo se rechaza con un mensaje que lo dice, y no se consume nada (WP-C13f lo resuelve)", async () => {
        const scenario = await createScenario();
        const bulkLotId = await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
        });
        await seedSupplyLot(scenario.vialVariantId, { qty: 2, unitCostPyg: 4_500 });
        await seedSupplyLot(scenario.vialVariantId, { qty: 2, unitCostPyg: 4_500 });
        await seedSupplyLot(scenario.atomizerVariantId, { qty: 100, unitCostPyg: 2_500 });
        await seedSupplyLot(scenario.labelVariantId, { qty: 100, unitCostPyg: 300 });
        const planned = await planOk(scenario, { qtyUnits: 3 });
        await startOk(planned.order.id);

        const response = await execute(planned.order.id, 0.35);

        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe("CONFLICT_BOM_COMPONENT_SPLIT_ACROSS_LOTS");
        expect(response.json().error.message).toContain("repartido entre 2 lotes");
        expect(response.json().error.data.details).toEqual({
          componentVariantId: scenario.vialVariantId,
          required: 3,
          available: 4,
          lots: 2,
        });
        expect(await onHand(bulkLotId)).toBe("114.650");
        expect(await onHandOfVariant(scenario.vialVariantId)).toBe("4.000");
        expect(await movementsOfOrder(planned.order.id)).toEqual([]);
      });

      it("un insumo OPCIONAL repartido entre lotes tampoco se omite en silencio: hay stock y el COGS no puede quedar sin su costo", async () => {
        const scenario = await createScenario({ labelOptional: true });
        const bulkLotId = await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
        });
        await seedSupplyLot(scenario.vialVariantId, { qty: 100, unitCostPyg: 4_500 });
        await seedSupplyLot(scenario.atomizerVariantId, { qty: 100, unitCostPyg: 2_500 });
        await seedSupplyLot(scenario.labelVariantId, { qty: 2, unitCostPyg: 300 });
        await seedSupplyLot(scenario.labelVariantId, { qty: 2, unitCostPyg: 300 });
        const planned = await planOk(scenario, { qtyUnits: 3 });
        await startOk(planned.order.id);

        const response = await execute(planned.order.id, 0.35);

        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe("CONFLICT_BOM_COMPONENT_SPLIT_ACROSS_LOTS");
        expect(await onHand(bulkLotId)).toBe("114.650");
        expect(await onHandOfVariant(scenario.labelVariantId)).toBe("4.000");
        expect(await movementsOfOrder(planned.order.id)).toEqual([]);
      });

      // Revisión cruzada de WP-C13: 10 + 0.274 da 10.274000000000001 en punto
      // flotante y la comparación exacta rechazaba el último líquido de un frasco
      // (la orden quedaba en curso sin salida hasta WP-C13c). Se arregló en
      // `Quantity` (packages/domain).
      it("RN-FRA-03 · el granel que alcanza justo (10,274 ml para 10 ml y 0,274 ml de merma real) se ejecuta y queda en cero", async () => {
        const scenario = await createScenario();
        const bulkLotId = await seedBulkLot(scenario.bulkVariantId, {
          qty: 10.274,
          unitCostPyg: 11_972,
        });
        await seedSupplies(scenario);
        const orderId = await plannedAndStarted(scenario);

        const executed = await mutateOk<ExecuteDecantOutput>("inventory.decant.execute", {
          workOrderId: orderId,
          wasteActual: 0.274,
        });

        expect(executed.order.status).toBe("done");
        expect(await onHand(bulkLotId)).toBe("0.000");
        expect(await driftRows()).toBe(0);
      });

      it("ejecutar con la misma Idempotency-Key devuelve la misma respuesta y consume una sola vez", async () => {
        const scenario = await createScenario();
        const bulkLotId = await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
        });
        await seedSupplies(scenario);
        const orderId = await plannedAndStarted(scenario);
        const payload = { workOrderId: orderId, wasteActual: 0.35 };

        const first = await mutate("inventory.decant.execute", payload, {
          "idempotency-key": "ejecutar-1",
        });
        const second = await mutate("inventory.decant.execute", payload, {
          "idempotency-key": "ejecutar-1",
        });

        expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
        expect(second.json().result.data.cogs).toBe(first.json().result.data.cogs);
        expect(await movementsOfOrder(orderId)).toHaveLength(5);
        expect(await onHand(bulkLotId)).toBe("104.300");
      });

      it("un granel que deja de ser decantable entre planificar y ejecutar se rechaza y no consume nada", async () => {
        const scenario = await createScenario();
        const bulkLotId = await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
        });
        await seedSupplies(scenario);
        const orderId = await plannedAndStarted(scenario);
        await testDb.superuserClient.query(
          `UPDATE app.inventory_lots SET status = 'quarantine' WHERE id = $1`,
          [bulkLotId],
        );

        const response = await execute(orderId, 0.35);

        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe("CONFLICT_SOURCE_LOT_NOT_DECANTABLE");
        expect(await onHand(bulkLotId)).toBe("114.650");
        expect(await movementsOfOrder(orderId)).toEqual([]);
      });

      it("un insumo en cuarentena no se consume: cuenta como faltante y no se ejecuta nada", async () => {
        const scenario = await createScenario();
        const bulkLotId = await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
        });
        const vialLotId = await seedSupplyLot(scenario.vialVariantId, {
          qty: 100,
          unitCostPyg: 4_500,
        });
        await seedSupplyLot(scenario.atomizerVariantId, { qty: 100, unitCostPyg: 2_500 });
        await seedSupplyLot(scenario.labelVariantId, { qty: 100, unitCostPyg: 300 });
        const orderId = await plannedAndStarted(scenario);
        await testDb.superuserClient.query(
          `UPDATE app.inventory_lots SET status = 'quarantine' WHERE id = $1`,
          [vialLotId],
        );

        const response = await execute(orderId, 0.35);

        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe("CONFLICT_MISSING_BOM_COMPONENT");
        expect(await onHand(bulkLotId)).toBe("114.650");
        expect(await onHand(vialLotId)).toBe("100.000");
        expect(await movementsOfOrder(orderId)).toEqual([]);
      });
    });

    // -------------------------------------------------------------------
    describe("RN-LOT-05 · bloqueo de lotes: las ejecuciones simultáneas sobre el mismo granel se serializan", () => {
      it("con granel para una sola, la segunda ve el saldo real, falla y el saldo nunca queda negativo", async () => {
        const scenario = await createScenario();
        const bulkLotId = await seedBulkLot(scenario.bulkVariantId, {
          qty: 10.5,
          unitCostPyg: 11_972,
        });
        await seedSupplies(scenario);
        // Sin reservas (WP-C18), las dos órdenes se planifican contra el mismo
        // granel y las dos pasan: es exactamente el hueco que C18 cierra.
        const first = await plannedAndStarted(scenario);
        const second = await plannedAndStarted(scenario);

        const responses = await Promise.all([execute(first, 0.35), execute(second, 0.35)]);

        expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
        expect(await onHand(bulkLotId)).toBe("0.150");
        expect(await driftRows()).toBe(0);
      });
    });

    // -------------------------------------------------------------------
    describe("RN-LOT-05 · la ejecución bloquea el granel antes de leer su saldo", () => {
      it("si otra transacción tiene el lote, la ejecución espera y recién entonces consume", async () => {
        const scenario = await createScenario();
        const bulkLotId = await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
        });
        await seedSupplies(scenario);
        const orderId = await plannedAndStarted(scenario);

        const status = await requestWaitsForLotLock(bulkLotId, () => execute(orderId, 0.35));

        expect(status).toBe(200);
        expect(await onHand(bulkLotId)).toBe("104.300");
      });

      it("toma los lotes en orden ascendente de id aunque el plan no lo dé: con el heap forzado, el granel de id más alto no queda tomado mientras espera el de id más bajo", async () => {
        const scenario = await createScenario();
        // El granel lleva el id MÁS ALTO y se inserta PRIMERO: en un recorrido del
        // heap sale primero. Sin el `ORDER BY` la ejecución lo tomaría antes que
        // los insumos y, con otra ejecución en orden inverso, habría interbloqueo.
        const bulkLotId = await seedBulkLot(scenario.bulkVariantId, {
          id: "ffffffff-0000-4000-8000-000000000001",
          qty: 114.65,
          unitCostPyg: 11_972,
        });
        const lowestLotId = await seedSupplyLot(scenario.vialVariantId, {
          id: "00000000-0000-4000-8000-000000000001",
          qty: 100,
          unitCostPyg: 4_500,
        });
        await seedSupplyLot(scenario.atomizerVariantId, {
          id: "00000000-0000-4000-8000-000000000002",
          qty: 100,
          unitCostPyg: 2_500,
        });
        await seedSupplyLot(scenario.labelVariantId, {
          id: "00000000-0000-4000-8000-000000000003",
          qty: 100,
          unitCostPyg: 300,
        });
        const orderId = await plannedAndStarted(scenario);
        let status = 0;

        await withHeapPlansForApiRole(async () => {
          await testDb.superuserClient.query("BEGIN");
          let released = false;
          let pending: Promise<{ statusCode: number }> | undefined;
          try {
            // Otra transacción retiene el lote de id más bajo...
            await testDb.superuserClient.query(
              "SELECT id FROM app.inventory_lots WHERE id = $1 FOR NO KEY UPDATE",
              [lowestLotId],
            );
            pending = execute(orderId, 0.35);
            await waitUntilABackendIsBlockedOnALock();
            // ...y la ejecución, que espera por él, todavía no tiene el granel: NOWAIT
            // lo consigue. Con el orden del heap ya lo tendría tomado y esto falla (55P03).
            await testDb.superuserClient.query(
              "SELECT id FROM app.inventory_lots WHERE id = $1 FOR UPDATE NOWAIT",
              [bulkLotId],
            );
            await testDb.superuserClient.query("COMMIT");
            released = true;
            status = (await pending).statusCode;
          } finally {
            if (!released) {
              await testDb.superuserClient.query("ROLLBACK");
              await pending?.catch(() => undefined);
            }
          }
        });

        expect(status).toBe(200);
        expect(await onHand(bulkLotId)).toBe("104.300");
      });
    });

    // -------------------------------------------------------------------
    describe("RF-FRA-06 · la cola de órdenes pendientes, agrupada por frasco de origen", () => {
      async function clearQueue(): Promise<void> {
        await testDb.superuserClient.query(
          `UPDATE app.decant_work_orders SET status = 'cancelled'
          WHERE tenant_id = $1 AND status IN ('pending', 'in_progress')`,
          [TENANT_ID],
        );
      }

      it("agrupa por frasco, el de apertura más antigua primero, con su saldo y lo que compromete su cola", async () => {
        await clearQueue();
        const scenario = await createScenario();
        // Los ids se fijan al revés de la apertura: el frasco de apertura más
        // antigua lleva el id MÁS ALTO. Con ids aleatorios, un orden por id pasaba
        // esta prueba una de cada dos veces por pura suerte.
        const newerBottle = await seedBulkLot(scenario.bulkVariantId, {
          id: "00000000-0000-4000-8000-0000000000b1",
          qty: 114.65,
          unitCostPyg: 11_972,
          openedAt: "2026-03-01T10:00:00Z",
        });
        const olderBottle = await seedBulkLot(scenario.bulkVariantId, {
          id: "ffffffff-0000-4000-8000-0000000000b2",
          qty: 50,
          unitCostPyg: 11_972,
          openedAt: "2026-02-15T10:00:00Z",
        });
        await seedSupplies(scenario);
        await planOk(scenario, { sourceLotId: newerBottle });
        await planOk(scenario, { sourceLotId: newerBottle, qtyUnits: 2 });
        await planOk(scenario, { sourceLotId: olderBottle });

        const queue = await call<{
          groups: {
            sourceLotId: string;
            onHandMl: number;
            committedMl: number;
            orders: { qtyUnits: number }[];
          }[];
        }>("inventory.decant.list", {});

        expect(queue.groups.map((group) => group.sourceLotId)).toEqual([olderBottle, newerBottle]);
        expect(queue.groups[0]).toMatchObject({ onHandMl: 50, committedMl: 10.2 });
        expect(queue.groups[1]).toMatchObject({ onHandMl: 114.65, committedMl: 30.6 });
        expect(queue.groups[1]!.orders.map((order) => order.qtyUnits)).toEqual([1, 2]);
      });

      it("una orden ejecutada sale de la cola", async () => {
        await clearQueue();
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, { qty: 114.65, unitCostPyg: 11_972 });
        await seedSupplies(scenario);
        const done = await plannedAndStarted(scenario);
        await mutateOk<ExecuteDecantOutput>("inventory.decant.execute", {
          workOrderId: done,
          wasteActual: 0.35,
        });
        const pending = await planOk(scenario);

        const queue = await call<{ groups: { orders: { id: string }[] }[] }>(
          "inventory.decant.list",
          {},
        );

        expect(queue.groups).toHaveLength(1);
        expect(queue.groups[0]!.orders.map((order) => order.id)).toEqual([pending.order.id]);
      });

      it("se puede filtrar por las que ya están en curso", async () => {
        await clearQueue();
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, { qty: 114.65, unitCostPyg: 11_972 });
        await seedSupplies(scenario);
        await planOk(scenario);
        const inProgress = await plannedAndStarted(scenario);

        const queue = await call<{ groups: { orders: { id: string }[] }[] }>(
          "inventory.decant.list",
          { status: "in_progress" },
        );

        expect(queue.groups[0]!.orders.map((order) => order.id)).toEqual([inProgress]);
      });

      it("sin órdenes pendientes la cola está vacía", async () => {
        await clearQueue();

        const queue = await call<{ groups: unknown[] }>("inventory.decant.list", {});

        expect(queue.groups).toEqual([]);
      });
    });

    // -------------------------------------------------------------------
    describe("docs/api-conventions.md §4.3 y §8.4 · sin permiso o de otro tenant se responde 404 (WP-C13)", () => {
      // Desde WP-B18 el vendedor tiene `inventory.decant:plan`, un permiso del
      // MISMO módulo (`inventory.decant`) que `execute`: con sesión y acceso al
      // módulo, la regla de api-conventions §4.3 manda 403 y no 404 (ya sabe que
      // el módulo existe). La cola exige `inventory.stock:read`, un módulo del que
      // no tiene nada, y sigue siendo 404. El 403 de `plan` es transitorio: WP-C19
      // la pasa a exigir `inventory.decant:plan`, y el vendedor la planifica.
      it("un vendedor, sin inventory.decant:execute ni inventory.stock:read, no puede planificar, iniciar, ejecutar (403, tiene un permiso del módulo) ni ver la cola (404)", async () => {
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, { qty: 114.65, unitCostPyg: 11_972 });
        await seedSupplies(scenario);
        const orderId = await plannedAndStarted(scenario);
        const vendedor = await loginAs(STAFF_VENDEDOR_EMAIL);

        const planned = await mutateAs(vendedor, "inventory.decant.plan", {
          saleOrderId: scenario.saleOrderId,
          targetVariantId: scenario.decantVariantId,
          qtyUnits: 1,
        });
        const started = await mutateAs(vendedor, "inventory.decant.start", {
          workOrderId: orderId,
        });
        const executed = await mutateAs(vendedor, "inventory.decant.execute", {
          workOrderId: orderId,
          wasteActual: 0.35,
        });
        const queue = await callAs(vendedor, "inventory.decant.list", {});

        expect([
          planned.statusCode,
          started.statusCode,
          executed.statusCode,
          queue.statusCode,
        ]).toEqual([403, 403, 403, 404]);
        expect(await movementsOfOrder(orderId)).toEqual([]);
      });

      it("el dueño de otro tenant no ve ni toca las órdenes de este: start, execute y plan dan 404 y la cola sale vacía", async () => {
        const scenario = await createScenario();
        await seedBulkLot(scenario.bulkVariantId, { qty: 114.65, unitCostPyg: 11_972 });
        await seedSupplies(scenario);
        const pendingOrder = (await planOk(scenario)).order.id;
        const inProgressOrder = await plannedAndStarted(scenario);
        const foreignOwner = await loginAs(STAFF_OTHER_OWNER_EMAIL);

        const started = await mutateAs(foreignOwner, "inventory.decant.start", {
          workOrderId: pendingOrder,
        });
        const executed = await mutateAs(foreignOwner, "inventory.decant.execute", {
          workOrderId: inProgressOrder,
          wasteActual: 0.35,
        });
        const planned = await mutateAs(foreignOwner, "inventory.decant.plan", {
          saleOrderId: scenario.saleOrderId,
          targetVariantId: scenario.decantVariantId,
          qtyUnits: 1,
        });
        const queue = await callAs(foreignOwner, "inventory.decant.list", {});

        expect([started.statusCode, executed.statusCode, planned.statusCode]).toEqual([
          404, 404, 404,
        ]);
        expect(queue.statusCode).toBe(200);
        expect(queue.json().result.data).toEqual({ groups: [] });
        expect(await movementsOfOrder(inProgressOrder)).toEqual([]);
      });

      it("un rol con solo decant:execute no puede leer el lote de origen (lots_read pide stock:read): ejecutar da 404 y no escribe nada, no un 500", async () => {
        const scenario = await createScenario();
        const bulkLotId = await seedBulkLot(scenario.bulkVariantId, {
          qty: 114.65,
          unitCostPyg: 11_972,
        });
        await seedSupplies(scenario);
        const orderId = await plannedAndStarted(scenario);
        const onlyDecant = await loginAs(STAFF_SOLO_DECANT_EMAIL);

        const response = await mutateAs(onlyDecant, "inventory.decant.execute", {
          workOrderId: orderId,
          wasteActual: 0.35,
        });

        expect(response.statusCode).toBe(404);
        expect(await onHand(bulkLotId)).toBe("114.650");
        expect(await movementsOfOrder(orderId)).toEqual([]);
        const order = await testDb.superuserClient.query(
          `SELECT status::text AS status FROM app.decant_work_orders WHERE id = $1`,
          [orderId],
        );
        expect(order.rows[0].status).toBe("in_progress");
      });
    });
  },
);
