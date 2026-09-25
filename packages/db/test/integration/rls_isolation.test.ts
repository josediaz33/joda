import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "../setup/db.js";
import { runSmokeBusinessFlow } from "../../scripts/lib/smoke.mjs";

// docs/security-spec.md §3.1 y ADR-016: la API se conecta con el rol
// joda_api (NOBYPASSRLS), nunca con una credencial elevada — si usara la
// del owner de las tablas o `service_role`, RLS no se evaluaría y la Capa 1
// sería decorativa. docs/testing-strategy.md §3.2 exige que esta prueba se
// conecte como joda_api DE VERDAD, no como el superusuario del contenedor:
// un test que corriera con esa credencial pasaría aunque el aislamiento
// estuviera roto, porque un superusuario elude RLS siempre.
//
// Por eso acá se abre una segunda conexión, autenticada como joda_api, en
// vez de reusar la conexión superusuario de startTestDb() con `SET ROLE`.
// joda_api no tiene password en ninguna migración — provisionar esa
// credencial en producción es una decisión del Bloque C (API), todavía
// pendiente — así que se le asigna una password de un solo uso dentro del
// contenedor efímero de este test, exclusivamente para poder autenticarse.
const REAL_TENANT_ID = "11111111-1111-1111-1111-111111111111";
// No corresponde a ningún tenant sembrado — no hace falta que exista una
// fila en `tenants`, porque `app.current_tenant_id()` solo lee un valor de
// sesión (sin FK) y la política compara por igualdad de UUID. Cualquier
// UUID distinto de REAL_TENANT_ID prueba lo mismo.
const OTHER_TENANT_ID = "22222222-0000-0000-0000-000000000099";
const JODA_API_TEST_PASSWORD = "rls-isolation-test-only";

// WP-B10 (packages/db/migrations/0016_rls_tenant_isolation_restrictive.sql).
// A diferencia de OTHER_TENANT_ID, este tenant SÍ existe, con roles reales y
// un staff con rol owner (todos los permisos): el escenario del defecto es un
// usuario legítimo de OTRO tenant, con el permiso de la tabla, no un contexto
// vacío. `app.has_permission()` resuelve por user_id sin mirar el tenant, así
// que el permiso es real y la única barrera es tenant_isolation.
const PEER_TENANT_ID = "33333333-3333-3333-3333-333333333333";
const PEER_OWNER_ID = "33333333-3333-3333-3333-3333333300a1";
// Owner del tenant real, sembrado por smoke_business_flow.sql.
const REAL_OWNER_ID = "22222222-2222-2222-2222-222222222222";
// Vendedor del tenant real: el rol del seed sin inventory.stock:read.
const REAL_SELLER_ID = "22222222-2222-2222-2222-2222222200b1";

// Fixtures de smoke_business_flow.sql: el frasco sellado Layton (lote en
// unidades, abierto para decantar) y su granel (lote en ml).
const SEALED_OPEN_LOT_ID = "99999999-0000-0000-0000-000000000001";
const SEALED_VARIANT_ID = "55555555-0000-0000-0000-000000000001";
const BULK_LOT_ID = "99999999-0000-0000-0000-000000000002";
const BULK_VARIANT_ID = "55555555-0000-0000-0000-000000000002";
const REAL_SALE_ORDER_ID = "cccccccc-0000-0000-0000-000000000001";

// WP-B09: fixtures propios de este archivo. Un borrador del tenant real
// (para ejercitar el cuadre como vendedor, sembrado en beforeAll) y una
// variante con su lote en el tenant vecino (para los intentos de cruce de
// tenant). Estos últimos los crea el owner vecino DENTRO de la transacción
// de cada test, que se revierte: sembrados en beforeAll, romperían las
// pruebas de arriba que exigen que el vecino vea cero filas.
const REAL_DRAFT_ENTRY_ID = "f0000000-0000-0000-0000-0000000000d1";
const PEER_PRODUCT_ID = "33333333-0000-0000-0000-0000000000a1";
const PEER_VARIANT_ID = "33333333-0000-0000-0000-0000000000b1";
const PEER_LOT_ID = "33333333-0000-0000-0000-0000000000c1";

describe("RLS aísla por tenant con el rol de aplicación joda_api (docs/security-spec.md §3.1, ADR-016)", () => {
  let db: TestDb;
  let api: Client;
  // Cuenta contable del tenant real (su id es aleatorio, lo genera el
  // seed). La usa el ataque de INSERT cruzado de WP-B10: la FK account_id
  // tampoco evalúa RLS, así que el tenant vecino puede nombrarla.
  let realAccountId: string;
  // WP-B09: cuenta de ingresos (contrapartida para cuadrar un borrador) y
  // un movimiento real del granel (blanco del cruce de capas de costo).
  let realRevenueAccountId: string;
  let realMovementId: string;

  // Contexto de staff dentro de la transacción abierta, igual que
  // withTenantTx: tercer parámetro de set_config en true.
  async function actAs(userId: string, tenantId: string): Promise<void> {
    await api.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.tenant_id', $2, true),
              set_config('app.audience', 'staff', true)`,
      [userId, tenantId],
    );
  }

  // Inventario propio del tenant vecino, creado por su owner (todos los
  // permisos) dentro de la transacción abierta: el atacante no necesita
  // nada del tenant real para tener un lote y una variante legítimos.
  async function seedPeerInventory(): Promise<void> {
    await api.query(
      `INSERT INTO app.products (id, tenant_id, kind, slug, name, status)
       VALUES ($1, $2, 'accessory', 'vecino-insumo', 'Insumo del vecino', 'draft')`,
      [PEER_PRODUCT_ID, PEER_TENANT_ID],
    );
    await api.query(
      `INSERT INTO app.product_variants (id, tenant_id, product_id, sku, variant_type, uom, price_pyg)
       VALUES ($1, $2, $3, 'VEC-001', 'unit', 'unit', 0)`,
      [PEER_VARIANT_ID, PEER_TENANT_ID, PEER_PRODUCT_ID],
    );
    await api.query(
      `INSERT INTO app.inventory_lots
         (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
          fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
       VALUES ($1, $2, $3, 10, 'unit', 0, 'PYG', 1, 10000, 1000)`,
      [PEER_LOT_ID, PEER_TENANT_ID, PEER_VARIANT_ID],
    );
  }

  beforeAll(async () => {
    db = await startTestDb();
    // Deja datos reales de un tenant (productos, lotes, movimientos de
    // inventario) para que "cero filas" sea una aserción real y no una
    // que pasaría igual sobre una base vacía.
    await runSmokeBusinessFlow(db.client);
    // WP-B10: smoke_business_flow.sql no deja filas en customer_deposits ni
    // en sourcing_scenarios — sin una fila del tenant real, "cero filas desde
    // otro tenant" pasaría igual sobre una tabla vacía. Además, el tenant
    // vecino con su owner y un vendedor del tenant real.
    await db.client.query(`
      INSERT INTO app.customer_deposits (tenant_id, customer_id, amount_pyg)
      VALUES ('${REAL_TENANT_ID}', 'aaaaaaaa-0000-0000-0000-000000000001', 100000);
      INSERT INTO app.sourcing_scenarios (tenant_id, name, created_by)
      VALUES ('${REAL_TENANT_ID}', 'Escenario de prueba', '${REAL_OWNER_ID}');
      INSERT INTO app.tenants (id, slug, legal_name, trade_name)
      VALUES ('${PEER_TENANT_ID}', 'tenant-vecino', 'Vecino SA', 'Vecino');
      SELECT app.seed_roles('${PEER_TENANT_ID}');
      INSERT INTO app.staff_users (id, tenant_id, auth_subject, email, full_name)
      VALUES ('${PEER_OWNER_ID}', '${PEER_TENANT_ID}', 'sub-peer-owner', 'owner@vecino.test', 'Owner vecino');
      INSERT INTO app.staff_user_roles (staff_user_id, role_id, tenant_id)
      SELECT '${PEER_OWNER_ID}', id, tenant_id FROM app.roles
       WHERE tenant_id = '${PEER_TENANT_ID}' AND code = 'owner';
      INSERT INTO app.staff_users (id, tenant_id, auth_subject, email, full_name)
      VALUES ('${REAL_SELLER_ID}', '${REAL_TENANT_ID}', 'sub-real-seller', 'vendedor@joda.test', 'Vendedor');
      INSERT INTO app.staff_user_roles (staff_user_id, role_id, tenant_id)
      SELECT '${REAL_SELLER_ID}', id, tenant_id FROM app.roles
       WHERE tenant_id = '${REAL_TENANT_ID}' AND code = 'vendedor';
    `);
    const account = await db.client.query(
      "SELECT id FROM app.chart_of_accounts WHERE tenant_id = $1 AND code = '1.1.01.001'",
      [REAL_TENANT_ID],
    );
    realAccountId = account.rows[0].id;
    const revenueAccount = await db.client.query(
      "SELECT id FROM app.chart_of_accounts WHERE tenant_id = $1 AND code = '4.1.01.001'",
      [REAL_TENANT_ID],
    );
    realRevenueAccountId = revenueAccount.rows[0].id;
    const movement = await db.client.query(
      "SELECT min(id) AS id FROM app.inventory_movements WHERE lot_id = $1",
      [BULK_LOT_ID],
    );
    realMovementId = movement.rows[0].id;
    await db.client.query(`
      INSERT INTO app.journal_entries (id, tenant_id, period_id, entry_no, entry_date, status, memo)
      VALUES ('${REAL_DRAFT_ENTRY_ID}', '${REAL_TENANT_ID}',
              'ffffffff-0000-0000-0000-000000000001', 50, current_date, 'draft',
              'Borrador de rls_isolation.test.ts');
    `);
    await db.client.query(`ALTER ROLE joda_api PASSWORD '${JODA_API_TEST_PASSWORD}'`);

    api = new Client({
      host: db.container.getHost(),
      port: db.container.getPort(),
      database: db.container.getDatabase(),
      user: "joda_api",
      password: JODA_API_TEST_PASSWORD,
    });
    await api.connect();
  }, 60_000);

  // Un test que falla a mitad de camino no llega a su ROLLBACK y deja la
  // transacción abortada: sin esto, todos los tests siguientes fallan en
  // cascada con "current transaction is aborted". Fuera de una transacción,
  // ROLLBACK solo emite un aviso.
  afterEach(async () => {
    await api.query("ROLLBACK");
  });

  afterAll(async () => {
    await api.end();
    await db.stop();
  });

  it("sin tenant_id en contexto, joda_api no ve filas de ningún tenant", async () => {
    await api.query("BEGIN");
    const { rowCount } = await api.query("SELECT * FROM app.products");
    await api.query("ROLLBACK");

    expect(rowCount).toBe(0);
  });

  it("con el tenant_id de otro tenant, joda_api no ve las filas del tenant real", async () => {
    await api.query("BEGIN");
    await api.query("SELECT set_config('app.tenant_id', $1, true)", [OTHER_TENANT_ID]);
    const { rowCount } = await api.query("SELECT * FROM app.products");
    await api.query("ROLLBACK");

    expect(rowCount).toBe(0);
  });

  it("con su propio tenant_id, joda_api sí ve las filas de ese tenant (control positivo)", async () => {
    await api.query("BEGIN");
    await api.query("SELECT set_config('app.tenant_id', $1, true)", [REAL_TENANT_ID]);
    const { rowCount } = await api.query("SELECT * FROM app.products");
    await api.query("ROLLBACK");

    expect(rowCount).toBeGreaterThan(0);
  });

  it("joda_api no puede hacer UPDATE sobre el ledger (inventory_movements)", async () => {
    await api.query("BEGIN");
    await expect(
      api.query(
        "UPDATE app.inventory_movements SET total_cost_pyg = total_cost_pyg WHERE id = $1",
        [0],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await api.query("ROLLBACK");
  });

  // WP-B08 (packages/db/migrations/0014_rls_sweep.sql), motivado por la
  // revisión cruzada de WP-C09: product_media no tenía tenant_id, así que
  // quedaba fuera de TODO lo que este archivo prueba arriba — una FK a
  // products no la protegía, porque los checks de integridad referencial
  // de Postgres no evalúan RLS. `product_categories` (misma forma de
  // tabla: solo IDs y una FK, sin tenant_id hasta este WP) es la prueba
  // concreta de que el barrido cerró ese hueco de verdad, no solo que
  // `pg_class.relrowsecurity` quedó en `true` — mismos tres casos que
  // `products` arriba, sobre una tabla que antes de este WP no tenía
  // ninguna protección.
  it("product_categories (WP-B08): sin tenant_id en contexto, joda_api no ve filas de ningún tenant", async () => {
    await api.query("BEGIN");
    const { rowCount } = await api.query("SELECT * FROM app.product_categories");
    await api.query("ROLLBACK");

    expect(rowCount).toBe(0);
  });

  it("product_categories (WP-B08): con el tenant_id de otro tenant, joda_api no ve las filas del tenant real", async () => {
    await api.query("BEGIN");
    await api.query("SELECT set_config('app.tenant_id', $1, true)", [OTHER_TENANT_ID]);
    const { rowCount } = await api.query("SELECT * FROM app.product_categories");
    await api.query("ROLLBACK");

    expect(rowCount).toBe(0);
  });

  it("product_categories (WP-B08): con su propio tenant_id, joda_api sí ve las filas de ese tenant (control positivo)", async () => {
    await api.query("BEGIN");
    await api.query("SELECT set_config('app.tenant_id', $1, true)", [REAL_TENANT_ID]);
    const { rowCount } = await api.query("SELECT * FROM app.product_categories");
    await api.query("ROLLBACK");

    expect(rowCount).toBeGreaterThan(0);
  });

  // WP-B10: las siete tablas con política de permiso además de
  // tenant_isolation. Antes de 0016 ambas eran PERMISSIVE y se combinaban
  // con OR: el owner del tenant vecino, con el permiso, leía las filas del
  // tenant real (demostrado sobre suppliers antes de escribir la migración).
  // ADR-016 pide tenant Y permiso. `has_permission` se devuelve junto con
  // las filas para que el cero no se pueda explicar por falta de permiso.
  const TABLES_WITH_PERMISSION_POLICY = [
    { table: "suppliers", permission: "market.supplier:read" },
    { table: "purchase_orders", permission: "market.purchase_order:read" },
    { table: "journal_entries", permission: "accounting.journal:read" },
    { table: "chart_of_accounts", permission: "accounting.journal:read" },
    { table: "customer_deposits", permission: "accounting.deposit:read" },
    { table: "sourcing_scenarios", permission: "market.sourcing:read" },
    { table: "inventory_lots", permission: "inventory.stock:read" },
  ];

  it.each(TABLES_WITH_PERMISSION_POLICY)(
    "$table (WP-B10): el staff de otro tenant, con $permission, no ve las filas del tenant real",
    async ({ table, permission }) => {
      await api.query("BEGIN");
      await api.query(
        `SELECT set_config('app.user_id', $1, true),
                set_config('app.tenant_id', $2, true),
                set_config('app.audience', 'staff', true)`,
        [PEER_OWNER_ID, PEER_TENANT_ID],
      );
      const permissionCheck = await api.query("SELECT app.has_permission($1) AS granted", [
        permission,
      ]);
      const { rowCount } = await api.query(`SELECT * FROM app.${table}`);
      await api.query("ROLLBACK");

      expect({ granted: permissionCheck.rows[0].granted, rowCount }).toEqual({
        granted: true,
        rowCount: 0,
      });
    },
  );

  it.each(TABLES_WITH_PERMISSION_POLICY)(
    "$table (WP-B10): el staff del tenant real, con $permission, sí ve sus filas (control positivo)",
    async ({ table }) => {
      await api.query("BEGIN");
      await api.query(
        `SELECT set_config('app.user_id', $1, true),
                set_config('app.tenant_id', $2, true),
                set_config('app.audience', 'staff', true)`,
        [REAL_OWNER_ID, REAL_TENANT_ID],
      );
      const { rowCount } = await api.query(`SELECT * FROM app.${table}`);
      await api.query("ROLLBACK");

      expect(rowCount).toBeGreaterThan(0);
    },
  );

  it("products (WP-B10): la permisiva base tenant_access no abre la tabla — otro tenant sigue viendo cero filas", async () => {
    await api.query("BEGIN");
    await api.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.tenant_id', $2, true),
              set_config('app.audience', 'staff', true)`,
      [PEER_OWNER_ID, PEER_TENANT_ID],
    );
    const { rowCount } = await api.query("SELECT * FROM app.products");
    await api.query("ROLLBACK");

    expect(rowCount).toBe(0);
  });

  // WP-B09 (0018_invariant_triggers_security_definer.sql). Hasta B09 este
  // test afirmaba lo contrario: con B10, inventory_lots exige
  // inventory.stock:read también dentro de los triggers de invariantes, que
  // eran SECURITY INVOKER; el vendedor veía el lote como inexistente (uom
  // NULL) y `assert_movement_uom` rechazaba todo movimiento suyo. Ahora son
  // SECURITY DEFINER: el vendedor vende, y el saldo se proyecta.
  describe("triggers de invariantes ejercitados por el vendedor, sin inventory.stock:read (WP-B09; RN-LOT-01, RN-LOT-03, RN-CTB-02, docs/data-model.md §4.2)", () => {
    it("el vendedor puede registrar una venta de su propio tenant, y el saldo del lote baja", async () => {
      await api.query("BEGIN");
      await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
      const before = await api.query(
        "SELECT on_hand FROM app.inventory_balances WHERE lot_id = $1",
        [BULK_LOT_ID],
      );
      const insert = await api.query(
        `INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
         VALUES ($1, $2, $3, -5, 'ml', 'sale')`,
        [REAL_TENANT_ID, BULK_LOT_ID, BULK_VARIANT_ID],
      );
      const after = await api.query(
        "SELECT on_hand FROM app.inventory_balances WHERE lot_id = $1",
        [BULK_LOT_ID],
      );
      await api.query("ROLLBACK");

      expect({
        inserted: insert.rowCount,
        before: before.rows[0].on_hand,
        after: after.rows[0].on_hand,
      }).toEqual({ inserted: 1, before: "114.650", after: "109.650" });
    });

    it("RN-LOT-01: el vendedor no puede mover unidades sobre un lote en ml — el trigger ve el lote de verdad, no un NULL", async () => {
      await api.query("BEGIN");
      await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
      await expect(
        api.query(
          `INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
           VALUES ($1, $2, $3, -1, 'unit', 'sale')`,
          [REAL_TENANT_ID, BULK_LOT_ID, BULK_VARIANT_ID],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        message: "Unidad de medida incompatible: el lote está en ml y el movimiento en unit",
      });
      await api.query("ROLLBACK");
    });

    // La trampa de B09: `assert_sealed_lot_not_open` fallaba ABIERTO para
    // el vendedor (lote invisible → NULL → la comparación no daba
    // verdadero), enmascarado por `trg_movement_uom`, que corre antes y
    // rechazaba primero. Con los dos SECURITY DEFINER, el que rechaza es
    // el guard del frasco abierto, con su propio mensaje.
    it("RN-LOT-03: el vendedor no puede vender como sellado un frasco abierto para decantar", async () => {
      await api.query("BEGIN");
      await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
      await expect(
        api.query(
          `INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
           VALUES ($1, $2, $3, -1, 'unit', 'sale')`,
          [REAL_TENANT_ID, SEALED_OPEN_LOT_ID, SEALED_VARIANT_ID],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        message: `El lote ${SEALED_OPEN_LOT_ID} está abierto para decantar: no puede venderse como sellado`,
      });
      await api.query("ROLLBACK");
    });

    it("el lote que crea el vendedor nace con su fila de saldo en cero (init_lot_balance)", async () => {
      await api.query("BEGIN");
      await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
      await api.query(
        `INSERT INTO app.inventory_lots
           (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
            fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
         VALUES ('99999999-0000-0000-0000-0000000000b9', $1, $2, 125, 'ml', 0, 'PYG', 1, 0, 0)`,
        [REAL_TENANT_ID, BULK_VARIANT_ID],
      );
      const { rows } = await api.query(
        "SELECT tenant_id, on_hand FROM app.inventory_balances WHERE lot_id = '99999999-0000-0000-0000-0000000000b9'",
      );
      await api.query("ROLLBACK");

      expect(rows).toEqual([{ tenant_id: REAL_TENANT_ID, on_hand: "0.000" }]);
    });

    it("las capas de costo que registra el vendedor se verifican contra el movimiento: si cuadran, pasan", async () => {
      await api.query("BEGIN");
      await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
      await api.query(
        `WITH m AS (
           INSERT INTO app.inventory_movements
             (tenant_id, lot_id, variant_id, qty, uom, movement_type, total_cost_pyg)
           VALUES ($1, $2, $3, -1, 'ml', 'sale', 11972)
           RETURNING id)
         INSERT INTO app.movement_cost_allocations
           (tenant_id, movement_id, lot_id, qty, unit_cost_pyg, total_cost_pyg)
         SELECT $1, m.id, $2, 1, 11972, 11972 FROM m`,
        [REAL_TENANT_ID, BULK_LOT_ID, BULK_VARIANT_ID],
      );
      const check = await api.query("SET CONSTRAINTS app.trg_cost_allocation_matches IMMEDIATE");
      await api.query("ROLLBACK");

      expect(check.command).toBe("SET");
    });

    it("las capas de costo que registra el vendedor se verifican contra el movimiento: si no cuadran, se rechazan", async () => {
      await api.query("BEGIN");
      await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
      await api.query(
        `WITH m AS (
           INSERT INTO app.inventory_movements
             (tenant_id, lot_id, variant_id, qty, uom, movement_type, total_cost_pyg)
           VALUES ($1, $2, $3, -1, 'ml', 'sale', 11972)
           RETURNING id)
         INSERT INTO app.movement_cost_allocations
           (tenant_id, movement_id, lot_id, qty, unit_cost_pyg, total_cost_pyg)
         SELECT $1, m.id, $2, 1, 5000, 5000 FROM m`,
        [REAL_TENANT_ID, BULK_LOT_ID, BULK_VARIANT_ID],
      );
      await expect(
        api.query("SET CONSTRAINTS app.trg_cost_allocation_matches IMMEDIATE"),
      ).rejects.toMatchObject({
        code: "23514",
        message: expect.stringMatching(
          /^Capas de costo del movimiento \d+ no cuadran: asignado=5000 declarado=11972$/,
        ),
      });
      await api.query("ROLLBACK");
    });

    it("RN-CTB-02: un borrador que el vendedor deja descuadrado se rechaza al verificar el cuadre", async () => {
      await api.query("BEGIN");
      await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
      await api.query(
        `INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
         VALUES ($1, $2, $3, 1000, 0), ($1, $2, $4, 0, 700)`,
        [REAL_TENANT_ID, REAL_DRAFT_ENTRY_ID, realAccountId, realRevenueAccountId],
      );
      await expect(
        api.query("SET CONSTRAINTS app.trg_journal_balanced IMMEDIATE"),
      ).rejects.toMatchObject({
        code: "23514",
        message: `Asiento ${REAL_DRAFT_ENTRY_ID} descuadrado: debe=1000 haber=700 (diferencia 300)`,
      });
      await api.query("ROLLBACK");
    });

    it("RN-CTB-02: un borrador que el vendedor deja cuadrado pasa la verificación (control positivo)", async () => {
      await api.query("BEGIN");
      await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
      await api.query(
        `INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
         VALUES ($1, $2, $3, 1000, 0), ($1, $2, $4, 0, 1000)`,
        [REAL_TENANT_ID, REAL_DRAFT_ENTRY_ID, realAccountId, realRevenueAccountId],
      );
      const check = await api.query("SET CONSTRAINTS app.trg_journal_balanced IMMEDIATE");
      await api.query("ROLLBACK");

      expect(check.command).toBe("SET");
    });

    it("una edición del vendedor actualiza updated_at aunque intente fijarlo (set_updated_at)", async () => {
      await api.query("BEGIN");
      await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
      const { rows } = await api.query(
        `UPDATE app.products SET updated_at = '2000-01-01T00:00:00Z'
          WHERE id = '44444444-4444-4444-4444-444444444444'
         RETURNING updated_at > '2000-01-01T00:00:00Z'::timestamptz AS refreshed`,
      );
      await api.query("ROLLBACK");

      expect(rows).toEqual([{ refreshed: true }]);
    });

    it("el vendedor no puede reescribir una transición de pedido (guard_append_only)", async () => {
      await api.query("BEGIN");
      await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
      await api.query(
        `INSERT INTO app.sale_order_transitions (tenant_id, sale_order_id, from_status, to_status)
         VALUES ($1, $2, 'awaiting_payment', 'paid')`,
        [REAL_TENANT_ID, REAL_SALE_ORDER_ID],
      );
      await expect(
        api.query(
          "UPDATE app.sale_order_transitions SET reason = 'reescrita' WHERE sale_order_id = $1",
          [REAL_SALE_ORDER_ID],
        ),
      ).rejects.toMatchObject({
        code: "23001",
        message: "La tabla app.sale_order_transitions es append-only; operación UPDATE rechazada",
      });
      await api.query("ROLLBACK");
    });

    // docs/data-model.md §4.2: `pg_temp` va último en el search_path de toda
    // función SECURITY DEFINER. Si fuera primero (el default cuando no se lo
    // nombra), esta tabla temporal haría creer al trigger que el granel está
    // en unidades.
    it("una tabla temporal que sombrea inventory_lots no engaña al trigger de unidad de medida", async () => {
      await api.query("BEGIN");
      await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
      await api.query(
        `CREATE TEMP TABLE inventory_lots (id uuid, tenant_id uuid, uom text, status text)
           ON COMMIT DROP`,
      );
      await api.query("INSERT INTO pg_temp.inventory_lots VALUES ($1, $2, 'unit', 'available')", [
        BULK_LOT_ID,
        REAL_TENANT_ID,
      ]);
      await expect(
        api.query(
          `INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
           VALUES ($1, $2, $3, -1, 'unit', 'sale')`,
          [REAL_TENANT_ID, BULK_LOT_ID, BULK_VARIANT_ID],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        message: "Unidad de medida incompatible: el lote está en ml y el movimiento en unit",
      });
      await api.query("ROLLBACK");
    });
  });

  // WP-B09: con SECURITY DEFINER los triggers ven filas de TODOS los tenants,
  // y las FK no evalúan RLS. El atacante es el owner del tenant vecino, con
  // todos los permisos: la única barrera es la verificación de tenant dentro
  // de cada trigger. Cada rechazo tiene el mismo mensaje que una fila
  // inexistente — no confirma que la fila ajena exista.
  describe("triggers de invariantes contra un staff de otro tenant (WP-B09, docs/data-model.md §4.2)", () => {
    it("un movimiento del tenant vecino no puede tocar un lote del tenant real", async () => {
      await api.query("BEGIN");
      await actAs(PEER_OWNER_ID, PEER_TENANT_ID);
      await expect(
        api.query(
          `INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
           VALUES ($1, $2, $3, 1, 'ml', 'adjustment')`,
          [PEER_TENANT_ID, BULK_LOT_ID, BULK_VARIANT_ID],
        ),
      ).rejects.toMatchObject({
        code: "23503",
        message: `Lote ${BULK_LOT_ID} no encontrado en el tenant del movimiento: no se puede verificar el movimiento`,
      });
      await api.query("ROLLBACK");
    });

    it("un movimiento del tenant vecino no puede declarar una variante del tenant real", async () => {
      await api.query("BEGIN");
      await actAs(PEER_OWNER_ID, PEER_TENANT_ID);
      await seedPeerInventory();
      await expect(
        api.query(
          `INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
           VALUES ($1, $2, $3, 1, 'unit', 'adjustment')`,
          [PEER_TENANT_ID, PEER_LOT_ID, SEALED_VARIANT_ID],
        ),
      ).rejects.toMatchObject({
        code: "23503",
        message: `Variante ${SEALED_VARIANT_ID} no encontrada en el tenant del movimiento: no se puede verificar el movimiento`,
      });
      await api.query("ROLLBACK");
    });

    it("una capa de costo del tenant vecino no puede colgarse de un movimiento del tenant real", async () => {
      await api.query("BEGIN");
      await actAs(PEER_OWNER_ID, PEER_TENANT_ID);
      await seedPeerInventory();
      await api.query(
        `INSERT INTO app.movement_cost_allocations
           (tenant_id, movement_id, lot_id, qty, unit_cost_pyg, total_cost_pyg)
         VALUES ($1, $2, $3, 1, 1000, 1000)`,
        [PEER_TENANT_ID, realMovementId, PEER_LOT_ID],
      );
      await expect(
        api.query("SET CONSTRAINTS app.trg_cost_allocation_matches IMMEDIATE"),
      ).rejects.toMatchObject({
        code: "23503",
        message: `Movimiento ${realMovementId} no encontrado en el tenant de la capa de costo: no se puede verificar la capa`,
      });
      await api.query("ROLLBACK");
    });

    it("una capa de costo del tenant vecino no puede consumir un lote del tenant real", async () => {
      await api.query("BEGIN");
      await actAs(PEER_OWNER_ID, PEER_TENANT_ID);
      await seedPeerInventory();
      await api.query(
        `WITH m AS (
           INSERT INTO app.inventory_movements
             (tenant_id, lot_id, variant_id, qty, uom, movement_type, total_cost_pyg)
           VALUES ($1, $2, $3, 1, 'unit', 'adjustment', 1000)
           RETURNING id)
         INSERT INTO app.movement_cost_allocations
           (tenant_id, movement_id, lot_id, qty, unit_cost_pyg, total_cost_pyg)
         SELECT $1, m.id, $4, 1, 1000, 1000 FROM m`,
        [PEER_TENANT_ID, PEER_LOT_ID, PEER_VARIANT_ID, BULK_LOT_ID],
      );
      await expect(
        api.query("SET CONSTRAINTS app.trg_cost_allocation_matches IMMEDIATE"),
      ).rejects.toMatchObject({
        code: "23503",
        message: `Lote ${BULK_LOT_ID} no encontrado en el tenant de la capa de costo: no se puede verificar la capa`,
      });
      await api.query("ROLLBACK");
    });
  });

  // RN-CTB-06 (docs/domain-rules.md): un asiento contabilizado no se
  // modifica. Hallazgo de la revisión cruzada de B10: con 0016,
  // `guard_posted_journal` (SECURITY INVOKER) ya no veía el asiento para un
  // staff sin accounting.journal:read, leía status NULL y dejaba pasar la
  // edición — falla ABIERTA. 0017 lo pasa a SECURITY DEFINER y falla
  // cerrado. El vendedor puede tocar journal_lines (la tabla no tiene
  // política de permiso, solo tenant); el que tiene que frenarlo es el
  // trigger.
  const POSTED_ENTRY_ID = "f0000000-0000-0000-0000-000000000001";

  it("journal_lines (WP-B10, RN-CTB-06): el vendedor, sin accounting.journal:read, no puede editar una línea de un asiento contabilizado", async () => {
    await api.query("BEGIN");
    await api.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.tenant_id', $2, true),
              set_config('app.audience', 'staff', true)`,
      [REAL_SELLER_ID, REAL_TENANT_ID],
    );
    await expect(
      api.query("UPDATE app.journal_lines SET memo = 'editado' WHERE entry_id = $1", [
        POSTED_ENTRY_ID,
      ]),
    ).rejects.toMatchObject({
      code: "23001",
      message: "El asiento ya está contabilizado: no se modifica, se reversa",
    });
    await api.query("ROLLBACK");
  });

  it("journal_lines (WP-B10, RN-CTB-06): el vendedor, sin accounting.journal:read, no puede borrar una línea de un asiento contabilizado", async () => {
    await api.query("BEGIN");
    await api.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.tenant_id', $2, true),
              set_config('app.audience', 'staff', true)`,
      [REAL_SELLER_ID, REAL_TENANT_ID],
    );
    await expect(
      api.query("DELETE FROM app.journal_lines WHERE entry_id = $1", [POSTED_ENTRY_ID]),
    ).rejects.toMatchObject({
      code: "23001",
      message: "El asiento ya está contabilizado: no se modifica, se reversa",
    });
    await api.query("ROLLBACK");
  });

  it("journal_lines (WP-B10): el owner de otro tenant no puede colgar una línea propia de un asiento del tenant real", async () => {
    await api.query("BEGIN");
    await api.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.tenant_id', $2, true),
              set_config('app.audience', 'staff', true)`,
      [PEER_OWNER_ID, PEER_TENANT_ID],
    );
    await expect(
      api.query(
        `INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
         VALUES ($1, $2, $3, 1000, 0)`,
        [PEER_TENANT_ID, POSTED_ENTRY_ID, realAccountId],
      ),
    ).rejects.toMatchObject({
      code: "23001",
      message:
        "Asiento f0000000-0000-0000-0000-000000000001 no encontrado en el tenant de la línea: no se puede verificar que sea editable",
    });
    await api.query("ROLLBACK");
  });

  it("inventory_movements (WP-B10): el mismo movimiento, insertado por el owner (con inventory.stock:read), sí se acepta (control positivo)", async () => {
    await api.query("BEGIN");
    await api.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.tenant_id', $2, true),
              set_config('app.audience', 'staff', true)`,
      [REAL_OWNER_ID, REAL_TENANT_ID],
    );
    const { rowCount } = await api.query(
      `INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
       VALUES ($1, '99999999-0000-0000-0000-000000000002',
               '55555555-0000-0000-0000-000000000002', -5, 'ml', 'sale')`,
      [REAL_TENANT_ID],
    );
    await api.query("ROLLBACK");

    expect(rowCount).toBe(1);
  });
});
