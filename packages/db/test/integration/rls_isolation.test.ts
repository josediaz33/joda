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

// WP-B14: un rol que el seed no trae, solo con accounting.journal:read. Ve
// los asientos (a diferencia del vendedor) pero no tiene journal:write, así
// que para él la única barrera contra modificar un asiento contabilizado es
// el trigger, no RLS. Hallazgo de la revisión cruzada de B14.
const REAL_AUDITOR_ID = "22222222-2222-2222-2222-2222222200c1";

// WP-B11: desde 0030 el vendedor ya no escribe lotes (RLS exige un permiso de
// recepción, apertura, devolución o ajuste). Las pruebas de B09 que lo usaban
// para crear un lote probaban que los triggers SECURITY DEFINER funcionan para
// quien NO lee lotes; este rol conserva esa condición: escribe lotes con
// market.purchase_order:receive y no tiene inventory.stock:read.
const REAL_RECEIVER_ID = "22222222-2222-2222-2222-2222222200d1";

// WP-B13: has_permission() exige una sesión viva del usuario en el tenant
// de contexto. Una por usuario, sembradas en beforeAll; actAs() fija la
// que corresponde.
const SESSION_BY_USER = {
  [REAL_OWNER_ID]: "5e550000-0000-0000-0000-0000000000a1",
  [PEER_OWNER_ID]: "5e550000-0000-0000-0000-0000000000a2",
  [REAL_SELLER_ID]: "5e550000-0000-0000-0000-0000000000a3",
  [REAL_AUDITOR_ID]: "5e550000-0000-0000-0000-0000000000a4",
  [REAL_RECEIVER_ID]: "5e550000-0000-0000-0000-0000000000a5",
} as const;
type StaffUserId = keyof typeof SESSION_BY_USER;

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
  // WP-B13: también app.session_id, con la sesión viva del usuario sembrada
  // en beforeAll — sin ella has_permission() da false.
  async function actAs(userId: StaffUserId, tenantId: string): Promise<void> {
    await api.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.tenant_id', $2, true),
              set_config('app.audience', 'staff', true),
              set_config('app.session_id', $3, true)`,
      [userId, tenantId, SESSION_BY_USER[userId]],
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
      INSERT INTO app.staff_sessions (id, tenant_id, staff_user_id, expires_at) VALUES
        ('${SESSION_BY_USER[REAL_OWNER_ID]}', '${REAL_TENANT_ID}', '${REAL_OWNER_ID}', now() + interval '8 hours'),
        ('${SESSION_BY_USER[PEER_OWNER_ID]}', '${PEER_TENANT_ID}', '${PEER_OWNER_ID}', now() + interval '8 hours'),
        ('${SESSION_BY_USER[REAL_SELLER_ID]}', '${REAL_TENANT_ID}', '${REAL_SELLER_ID}', now() + interval '8 hours');
      INSERT INTO app.roles (id, tenant_id, code, name)
      VALUES ('aaaa0000-0000-0000-0000-0000000000c1', '${REAL_TENANT_ID}', 'auditor', 'Auditor');
      INSERT INTO app.role_permissions (tenant_id, role_id, permission_code)
      VALUES ('${REAL_TENANT_ID}', 'aaaa0000-0000-0000-0000-0000000000c1', 'accounting.journal:read');
      INSERT INTO app.staff_users (id, tenant_id, auth_subject, email, full_name)
      VALUES ('${REAL_AUDITOR_ID}', '${REAL_TENANT_ID}', 'sub-real-auditor', 'auditor@joda.test', 'Auditor');
      INSERT INTO app.staff_user_roles (staff_user_id, role_id, tenant_id)
      VALUES ('${REAL_AUDITOR_ID}', 'aaaa0000-0000-0000-0000-0000000000c1', '${REAL_TENANT_ID}');
      INSERT INTO app.staff_sessions (id, tenant_id, staff_user_id, expires_at)
      VALUES ('${SESSION_BY_USER[REAL_AUDITOR_ID]}', '${REAL_TENANT_ID}', '${REAL_AUDITOR_ID}', now() + interval '8 hours');
      INSERT INTO app.roles (id, tenant_id, code, name)
      VALUES ('aaaa0000-0000-0000-0000-0000000000d1', '${REAL_TENANT_ID}', 'recepcion', 'Recepción');
      INSERT INTO app.role_permissions (tenant_id, role_id, permission_code)
      VALUES ('${REAL_TENANT_ID}', 'aaaa0000-0000-0000-0000-0000000000d1', 'market.purchase_order:receive');
      INSERT INTO app.staff_users (id, tenant_id, auth_subject, email, full_name)
      VALUES ('${REAL_RECEIVER_ID}', '${REAL_TENANT_ID}', 'sub-real-receiver', 'recepcion@joda.test', 'Recepción');
      INSERT INTO app.staff_user_roles (staff_user_id, role_id, tenant_id)
      VALUES ('${REAL_RECEIVER_ID}', 'aaaa0000-0000-0000-0000-0000000000d1', '${REAL_TENANT_ID}');
      INSERT INTO app.staff_sessions (id, tenant_id, staff_user_id, expires_at)
      VALUES ('${SESSION_BY_USER[REAL_RECEIVER_ID]}', '${REAL_TENANT_ID}', '${REAL_RECEIVER_ID}', now() + interval '8 hours');
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
      await actAs(PEER_OWNER_ID, PEER_TENANT_ID);
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
      await actAs(REAL_OWNER_ID, REAL_TENANT_ID);
      const { rowCount } = await api.query(`SELECT * FROM app.${table}`);
      await api.query("ROLLBACK");

      expect(rowCount).toBeGreaterThan(0);
    },
  );

  it("products (WP-B10): la permisiva base tenant_access no abre la tabla — otro tenant sigue viendo cero filas", async () => {
    await api.query("BEGIN");
    await actAs(PEER_OWNER_ID, PEER_TENANT_ID);
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

    // WP-B09b (0024_revoke_balances_write.sql). Hallazgo de la revisión
    // cruzada de B09: el vendedor sumó 999.999 al saldo de un lote sin
    // tocar el ledger. La proyección solo la escriben los triggers
    // SECURITY DEFINER; la venta de arriba prueba que siguen proyectando.
    // Con el owner, que tiene todos los permisos: la barrera es el GRANT,
    // no un permiso de aplicación.
    const BALANCE_WRITES = [
      [
        "UPDATE",
        "UPDATE app.inventory_balances SET on_hand = on_hand + 999999 WHERE lot_id = $1 AND tenant_id = $2",
      ],
      [
        "INSERT",
        "INSERT INTO app.inventory_balances (lot_id, tenant_id, on_hand) VALUES ($1, $2, 999999)",
      ],
      ["DELETE", "DELETE FROM app.inventory_balances WHERE lot_id = $1 AND tenant_id = $2"],
    ] as const;

    it.each(
      BALANCE_WRITES.flatMap(([verb, sql]) => [
        ["el vendedor", verb, REAL_SELLER_ID, sql] as const,
        ["el owner", verb, REAL_OWNER_ID, sql] as const,
      ]),
    )(
      "%s no puede escribir el saldo por fuera del ledger: %s → 42501",
      async (_who, _verb, userId, sql) => {
        await api.query("BEGIN");
        await actAs(userId, REAL_TENANT_ID);
        await expect(api.query(sql, [BULK_LOT_ID, REAL_TENANT_ID])).rejects.toMatchObject({
          code: "42501",
        });
        await api.query("ROLLBACK");
      },
    );

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
        message: `El lote ${SEALED_OPEN_LOT_ID} está abierto para decantar: un sellado abierto no admite movimientos`,
      });
      await api.query("ROLLBACK");
    });

    // Hallazgo de la revisión cruzada de B09: el trigger decidía con la
    // variante que declara el movimiento; declarando la de granel, el
    // vendedor vendía un sellado de un lote abierto con saldo. Desde WP-C11
    // un sellado abierto es de una sola unidad, así que el escenario original
    // (tres frascos, uno abierto) ya no se puede armar; el lote de este test
    // es de una unidad y conserva su saldo porque el UPDATE del estado se
    // hace sin la salida que haría la apertura. El guard tiene que rechazar
    // igual, por sí solo.
    it("RN-LOT-03: el vendedor no puede vender un sellado de un lote abierto declarando la variante de granel", async () => {
      await api.query("BEGIN");
      await actAs(REAL_OWNER_ID, REAL_TENANT_ID);
      await api.query(
        `INSERT INTO app.inventory_lots
           (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
            fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
         VALUES ('99999999-0000-0000-0000-0000000000b3', $1, $2, 1, 'unit', 0, 'PYG', 1, 0, 0)`,
        [REAL_TENANT_ID, SEALED_VARIANT_ID],
      );
      await api.query(
        `INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
         VALUES ($1, '99999999-0000-0000-0000-0000000000b3', $2, 1, 'unit', 'purchase_receipt')`,
        [REAL_TENANT_ID, SEALED_VARIANT_ID],
      );
      await api.query(
        "UPDATE app.inventory_lots SET status = 'open_for_decant' WHERE id = '99999999-0000-0000-0000-0000000000b3'",
      );
      await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
      await expect(
        api.query(
          `INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
           VALUES ($1, '99999999-0000-0000-0000-0000000000b3', $2, -1, 'unit', 'sale')`,
          [REAL_TENANT_ID, BULK_VARIANT_ID],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        message:
          "El lote 99999999-0000-0000-0000-0000000000b3 está abierto para decantar: un sellado abierto no admite movimientos",
      });
      await api.query("ROLLBACK");
    });

    // WP-B08c (0023): RN-LOT-03 extendida. Un lote sellado en
    // open_for_decant es terminal y no admite NINGÚN movimiento: hasta 0023
    // un waste o un adjustment sacaban frascos sellados de un lote abierto
    // con saldo (pregunta de la revisión de B09, decidida por José). Desde
    // WP-C11 un sellado abierto es de una sola unidad: este lote lo es, y
    // conserva su saldo porque el estado se cambia sin la salida de la
    // unidad que haría la apertura.
    describe("RN-LOT-03 extendida (WP-B08c): un lote sellado abierto es terminal", () => {
      const OPEN_SEALED_LOT_WITH_BALANCE_ID = "99999999-0000-0000-0000-0000000000b4";

      async function openSealedLotWithBalance(): Promise<void> {
        await actAs(REAL_OWNER_ID, REAL_TENANT_ID);
        await api.query(
          `INSERT INTO app.inventory_lots
             (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
              fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
           VALUES ($1, $2, $3, 1, 'unit', 0, 'PYG', 1, 0, 0)`,
          [OPEN_SEALED_LOT_WITH_BALANCE_ID, REAL_TENANT_ID, SEALED_VARIANT_ID],
        );
        await api.query(
          `INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
           VALUES ($2, $1, $3, 1, 'unit', 'purchase_receipt')`,
          [OPEN_SEALED_LOT_WITH_BALANCE_ID, REAL_TENANT_ID, SEALED_VARIANT_ID],
        );
        await api.query("UPDATE app.inventory_lots SET status = 'open_for_decant' WHERE id = $1", [
          OPEN_SEALED_LOT_WITH_BALANCE_ID,
        ]);
      }

      it.each([
        ["waste", -1],
        ["adjustment", -1],
        ["adjustment", 1],
      ] as const)(
        "el vendedor no puede registrar %s %d sobre un sellado de un lote abierto",
        async (movementType, qty) => {
          await api.query("BEGIN");
          await openSealedLotWithBalance();
          await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
          await expect(
            api.query(
              `INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
               VALUES ($1, $2, $3, $4, 'unit', $5)`,
              [
                REAL_TENANT_ID,
                OPEN_SEALED_LOT_WITH_BALANCE_ID,
                SEALED_VARIANT_ID,
                qty,
                movementType,
              ],
            ),
          ).rejects.toMatchObject({
            code: "23514",
            message: `El lote ${OPEN_SEALED_LOT_WITH_BALANCE_ID} está abierto para decantar: un sellado abierto no admite movimientos`,
          });
          await api.query("ROLLBACK");
        },
      );

      // Sin esto, lo de arriba se elude volviendo el lote a available.
      it("el owner, con todos los permisos, no puede devolver a available un lote sellado abierto", async () => {
        await api.query("BEGIN");
        await openSealedLotWithBalance();
        await expect(
          api.query("UPDATE app.inventory_lots SET status = 'available' WHERE id = $1", [
            OPEN_SEALED_LOT_WITH_BALANCE_ID,
          ]),
        ).rejects.toMatchObject({
          code: "23514",
          message: `El lote ${OPEN_SEALED_LOT_WITH_BALANCE_ID} es un sellado abierto para decantar: su estado es terminal`,
        });
        await api.query("ROLLBACK");
      });

      // Mismo efecto que en journal_entries (revisión de B14): el vendedor,
      // sin inventory.stock:read, no ve el lote, y su UPDATE afecta cero
      // filas sin llegar al trigger. Lo deja escrito; la barrera para quien
      // sí lo ve es el trigger, probado arriba con el owner.
      it("el vendedor, sin inventory.stock:read, no alcanza el lote: su UPDATE afecta cero filas", async () => {
        await api.query("BEGIN");
        await openSealedLotWithBalance();
        await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
        const { rowCount } = await api.query(
          "UPDATE app.inventory_lots SET status = 'available' WHERE id = $1",
          [OPEN_SEALED_LOT_WITH_BALANCE_ID],
        );
        await api.query("ROLLBACK");

        expect(rowCount).toBe(0);
      });

      // WP-B11d: antes era una merma (`waste`), que ahora exige
      // `inventory.decant:execute` y el vendedor no tiene. La venta de granel
      // conserva lo que probaba: un lote abierto que no es sellado se mueve.
      it("el granel abierto, que no es sellado, se sigue moviendo (control positivo)", async () => {
        await api.query("BEGIN");
        await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
        const { rowCount } = await api.query(
          `INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
           VALUES ($1, $2, $3, -0.5, 'ml', 'sale')`,
          [REAL_TENANT_ID, BULK_LOT_ID, BULK_VARIANT_ID],
        );
        await api.query("ROLLBACK");

        expect(rowCount).toBe(1);
      });
    });

    // WP-C11 (0028): un sellado abierto es de una sola unidad. Marcar
    // abierto un lote de varios dejaba los otros frascos cerrados sin poder
    // venderse (RN-LOT-03, caso borde 21) y el granel heredaba el costo del
    // lote entero. La apertura separa primero la unidad; la base impide
    // saltearse eso, con cualquier credencial de la API.
    describe("RN-LOT-02 (WP-C11): un sellado abierto es de una sola unidad", () => {
      const THREE_UNIT_LOT_ID = "99999999-0000-0000-0000-0000000000c3";
      const SINGLE_UNIT_MESSAGE = (lotId: string) =>
        new RegExp(`^El lote ${lotId} es un sellado abierto de 3(\\.000)? unidades`);

      async function insertThreeUnitLot(status: "available" | "open_for_decant"): Promise<void> {
        await api.query(
          `INSERT INTO app.inventory_lots
             (id, tenant_id, variant_id, status, qty_initial, uom, unit_cost_minor, currency,
              fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
           VALUES ($1, $2, $3, $4, 3, 'unit', 0, 'PYG', 1, 0, 0)`,
          [THREE_UNIT_LOT_ID, REAL_TENANT_ID, SEALED_VARIANT_ID, status],
        );
      }

      it("el owner no puede marcar abierto un lote sellado de tres unidades", async () => {
        await api.query("BEGIN");
        await actAs(REAL_OWNER_ID, REAL_TENANT_ID);
        await insertThreeUnitLot("available");
        await expect(
          api.query("UPDATE app.inventory_lots SET status = 'open_for_decant' WHERE id = $1", [
            THREE_UNIT_LOT_ID,
          ]),
        ).rejects.toMatchObject({
          code: "23514",
          message: expect.stringMatching(SINGLE_UNIT_MESSAGE(THREE_UNIT_LOT_ID)),
        });
        await api.query("ROLLBACK");
      });

      // Quien recibe puede escribir lotes y no leerlos: el trigger tiene que
      // rechazar con su propio mensaje, no ser un efecto de RLS.
      it("quien recibe, sin inventory.stock:read, no puede crear un lote sellado de tres unidades ya abierto", async () => {
        await api.query("BEGIN");
        await actAs(REAL_RECEIVER_ID, REAL_TENANT_ID);
        await expect(insertThreeUnitLot("open_for_decant")).rejects.toMatchObject({
          code: "23514",
          message: expect.stringMatching(SINGLE_UNIT_MESSAGE(THREE_UNIT_LOT_ID)),
        });
        await api.query("ROLLBACK");
      });

      it("el owner no puede agrandar a tres unidades un sellado ya abierto", async () => {
        await api.query("BEGIN");
        await actAs(REAL_OWNER_ID, REAL_TENANT_ID);
        await expect(
          api.query("UPDATE app.inventory_lots SET qty_initial = 3 WHERE id = $1", [
            SEALED_OPEN_LOT_ID,
          ]),
        ).rejects.toMatchObject({
          code: "23514",
          message: expect.stringMatching(SINGLE_UNIT_MESSAGE(SEALED_OPEN_LOT_ID)),
        });
        await api.query("ROLLBACK");
      });

      it("un sellado de una unidad se abre (control positivo)", async () => {
        await api.query("BEGIN");
        await actAs(REAL_OWNER_ID, REAL_TENANT_ID);
        await api.query(
          `INSERT INTO app.inventory_lots
             (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
              fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
           VALUES ($1, $2, $3, 1, 'unit', 0, 'PYG', 1, 0, 0)`,
          [THREE_UNIT_LOT_ID, REAL_TENANT_ID, SEALED_VARIANT_ID],
        );
        const { rowCount } = await api.query(
          "UPDATE app.inventory_lots SET status = 'open_for_decant' WHERE id = $1",
          [THREE_UNIT_LOT_ID],
        );
        await api.query("ROLLBACK");

        expect(rowCount).toBe(1);
      });

      it("el owner no puede crear una segunda variante de granel para el mismo producto", async () => {
        await api.query("BEGIN");
        await actAs(REAL_OWNER_ID, REAL_TENANT_ID);
        await expect(
          api.query(
            `INSERT INTO app.product_variants (tenant_id, product_id, sku, variant_type, uom, price_pyg)
             SELECT tenant_id, product_id, 'LAY-BULK-2', 'bulk', 'ml', 0
               FROM app.product_variants WHERE id = $1`,
            [BULK_VARIANT_ID],
          ),
        ).rejects.toMatchObject({
          code: "23505",
          constraint: "product_variants_one_bulk_per_product",
        });
        await api.query("ROLLBACK");
      });
    });

    // WP-C12 (0029): la variante de una unidad serializada es la de su lote.
    // Hasta 0029 la declaraba quien inserta: un reloj de una variante quedaba
    // asociado al costo y al saldo de un lote de otra.
    describe("RN-SER-04 (WP-C12): una unidad serializada es de la variante de su lote", () => {
      const SERIAL_LOT_ID = "99999999-0000-0000-0000-0000000000d3";
      // Dos variantes sin serializar del tenant real, sembradas por el smoke.
      const VARIANT_A_ID = "55555555-0000-0000-0000-00000000a001";
      const VARIANT_B_ID = "55555555-0000-0000-0000-00000000a002";

      async function insertLotOfVariantA(): Promise<void> {
        await api.query(
          `INSERT INTO app.inventory_lots
             (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
              fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
           VALUES ($1, $2, $3, 1, 'unit', 0, 'PYG', 1, 0, 0)`,
          [SERIAL_LOT_ID, REAL_TENANT_ID, VARIANT_A_ID],
        );
      }

      function insertUnit(variantId: string): Promise<{ rowCount: number | null }> {
        return api.query(
          `INSERT INTO app.serialized_units (tenant_id, variant_id, lot_id, serial_number)
           VALUES ($1, $2, $3, 'SN-RLS-C12')`,
          [REAL_TENANT_ID, variantId, SERIAL_LOT_ID],
        );
      }

      it("el owner no puede crear una unidad que declara otra variante que la de su lote", async () => {
        await api.query("BEGIN");
        await actAs(REAL_OWNER_ID, REAL_TENANT_ID);
        await insertLotOfVariantA();
        await expect(insertUnit(VARIANT_B_ID)).rejects.toMatchObject({
          code: "23503",
          constraint: "serialized_units_lot_id_fkey",
        });
        await api.query("ROLLBACK");
      });

      it("el owner no puede cambiar la variante de un lote que ya tiene unidades serializadas", async () => {
        await api.query("BEGIN");
        await actAs(REAL_OWNER_ID, REAL_TENANT_ID);
        await insertLotOfVariantA();
        await insertUnit(VARIANT_A_ID);
        await expect(
          api.query("UPDATE app.inventory_lots SET variant_id = $2 WHERE id = $1", [
            SERIAL_LOT_ID,
            VARIANT_B_ID,
          ]),
        ).rejects.toMatchObject({ code: "23503", constraint: "serialized_units_lot_id_fkey" });
        await api.query("ROLLBACK");
      });

      it("la unidad con la variante de su lote se acepta (control positivo)", async () => {
        await api.query("BEGIN");
        await actAs(REAL_OWNER_ID, REAL_TENANT_ID);
        await insertLotOfVariantA();
        const { rowCount } = await insertUnit(VARIANT_A_ID);
        await api.query("ROLLBACK");

        expect(rowCount).toBe(1);
      });
    });

    // WP-B08c (0023): la variante de un movimiento es la de su lote. Sobre
    // el granel, que no es sellado, con su uom: lo único que lo frena es la
    // FK compuesta lote+variante. WP-B11d: antes era un ajuste (`adjustment`),
    // que ahora exige `inventory.stock:adjust`; con una venta, que el vendedor
    // sí escribe, lo único que lo frena sigue siendo la FK.
    it("el vendedor no puede declarar en un movimiento otra variante que la de su lote", async () => {
      await api.query("BEGIN");
      await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
      await expect(
        api.query(
          `INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
           VALUES ($1, $2, '55555555-0000-0000-0000-00000000a001', -1, 'ml', 'sale')`,
          [REAL_TENANT_ID, BULK_LOT_ID],
        ),
      ).rejects.toMatchObject({ code: "23503", constraint: "inventory_movements_lot_id_fkey" });
      await api.query("ROLLBACK");
    });

    // WP-B11: antes lo creaba el vendedor. Ahora lo crea quien recibe, que
    // escribe lotes sin poder leerlos, la misma condición que probaba B09.
    it("el lote que crea quien recibe, sin inventory.stock:read, nace con su fila de saldo en cero (init_lot_balance)", async () => {
      await api.query("BEGIN");
      await actAs(REAL_RECEIVER_ID, REAL_TENANT_ID);
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

    // WP-B11f (0037): el vendedor no lee el ledger (`inventory.stock:read`), así
    // que registra el movimiento SIN `RETURNING` (con él, la política de SELECT
    // sobre la fila nueva lo rechaza) y toma el id con `currval`. Las pruebas
    // de qué lee y qué no, en write_permissions.test.ts.
    it("las capas de costo que registra el vendedor se verifican contra el movimiento: si cuadran, pasan", async () => {
      await api.query("BEGIN");
      await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
      await api.query(
        `INSERT INTO app.inventory_movements
           (tenant_id, lot_id, variant_id, qty, uom, movement_type, total_cost_pyg)
         VALUES ($1, $2, $3, -1, 'ml', 'sale', 11972)`,
        [REAL_TENANT_ID, BULK_LOT_ID, BULK_VARIANT_ID],
      );
      await api.query(
        `INSERT INTO app.movement_cost_allocations
           (tenant_id, movement_id, lot_id, qty, unit_cost_pyg, total_cost_pyg)
         VALUES ($1, currval(pg_get_serial_sequence('app.inventory_movements', 'id')), $2, 1, 11972, 11972)`,
        [REAL_TENANT_ID, BULK_LOT_ID],
      );
      const check = await api.query("SET CONSTRAINTS app.trg_cost_allocation_matches IMMEDIATE");
      await api.query("ROLLBACK");

      expect(check.command).toBe("SET");
    });

    it("las capas de costo que registra el vendedor se verifican contra el movimiento: si no cuadran, se rechazan", async () => {
      await api.query("BEGIN");
      await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
      await api.query(
        `INSERT INTO app.inventory_movements
           (tenant_id, lot_id, variant_id, qty, uom, movement_type, total_cost_pyg)
         VALUES ($1, $2, $3, -1, 'ml', 'sale', 11972)`,
        [REAL_TENANT_ID, BULK_LOT_ID, BULK_VARIANT_ID],
      );
      await api.query(
        `INSERT INTO app.movement_cost_allocations
           (tenant_id, movement_id, lot_id, qty, unit_cost_pyg, total_cost_pyg)
         VALUES ($1, currval(pg_get_serial_sequence('app.inventory_movements', 'id')), $2, 1, 5000, 5000)`,
        [REAL_TENANT_ID, BULK_LOT_ID],
      );
      await expect(
        api.query("SET CONSTRAINTS app.trg_cost_allocation_matches IMMEDIATE"),
      ).rejects.toMatchObject({
        code: "23514",
        // Sin los montos: el vendedor no lee el costo (0037); con permiso de
        // lectura el mensaje los trae (write_permissions.test.ts).
        message: expect.stringMatching(
          /^Capas de costo del movimiento \d+ no cuadran con el costo del movimiento$/,
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
      // Desde WP-B08c (0023) la FK compuesta lo rechaza en el INSERT, antes
      // que el trigger diferido. El trigger, aislado, lo prueba el
      // invariante 35.
      await expect(
        api.query(
          `INSERT INTO app.movement_cost_allocations
             (tenant_id, movement_id, lot_id, qty, unit_cost_pyg, total_cost_pyg)
           VALUES ($1, $2, $3, 1, 1000, 1000)`,
          [PEER_TENANT_ID, realMovementId, PEER_LOT_ID],
        ),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "movement_cost_allocations_movement_id_fkey",
      });
      await api.query("ROLLBACK");
    });

    it("una capa de costo del tenant vecino no puede consumir un lote del tenant real", async () => {
      await api.query("BEGIN");
      await actAs(PEER_OWNER_ID, PEER_TENANT_ID);
      await seedPeerInventory();
      // Desde WP-B08c (0023) la FK compuesta lo rechaza en el INSERT. El
      // trigger diferido, aislado, lo prueba el invariante 36.
      await expect(
        api.query(
          `WITH m AS (
           INSERT INTO app.inventory_movements
             (tenant_id, lot_id, variant_id, qty, uom, movement_type, total_cost_pyg)
           VALUES ($1, $2, $3, 1, 'unit', 'adjustment', 1000)
           RETURNING id)
         INSERT INTO app.movement_cost_allocations
           (tenant_id, movement_id, lot_id, qty, unit_cost_pyg, total_cost_pyg)
         SELECT $1, m.id, $4, 1, 1000, 1000 FROM m`,
          [PEER_TENANT_ID, PEER_LOT_ID, PEER_VARIANT_ID, BULK_LOT_ID],
        ),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "movement_cost_allocations_lot_id_fkey",
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
    await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
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
    await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
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
    await actAs(PEER_OWNER_ID, PEER_TENANT_ID);
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
    await actAs(REAL_OWNER_ID, REAL_TENANT_ID);
    const { rowCount } = await api.query(
      `INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
       VALUES ($1, '99999999-0000-0000-0000-000000000002',
               '55555555-0000-0000-0000-000000000002', -5, 'ml', 'sale')`,
      [REAL_TENANT_ID],
    );
    await api.query("ROLLBACK");

    expect(rowCount).toBe(1);
  });
  // WP-B13 (0019_has_permission_session_bound.sql). Modelo de confianza de
  // ADR-016: RLS protege contra errores de la aplicación, no contra un
  // proceso de API comprometido. El error que se simula acá es un
  // withTenantTx armado con el user_id correcto pero sin la sesión que lo
  // respalda, o con una ajena.
  describe("has_permission exige una sesión viva del mismo usuario y tenant (WP-B13, docs/adr/016-rbac-tres-capas.md)", () => {
    it("el user_id del owner sin app.session_id no ve los lotes (inventory.stock:read)", async () => {
      await api.query("BEGIN");
      await api.query(
        `SELECT set_config('app.user_id', $1, true),
                set_config('app.tenant_id', $2, true),
                set_config('app.audience', 'staff', true)`,
        [REAL_OWNER_ID, REAL_TENANT_ID],
      );
      const permissionCheck = await api.query("SELECT app.has_permission($1) AS granted", [
        "inventory.stock:read",
      ]);
      const { rowCount } = await api.query("SELECT * FROM app.inventory_lots");
      await api.query("ROLLBACK");

      expect({ granted: permissionCheck.rows[0].granted, rowCount }).toEqual({
        granted: false,
        rowCount: 0,
      });
    });

    it("el user_id del owner con la sesión del vendedor no hereda los permisos del owner", async () => {
      await api.query("BEGIN");
      await api.query(
        `SELECT set_config('app.user_id', $1, true),
                set_config('app.tenant_id', $2, true),
                set_config('app.audience', 'staff', true),
                set_config('app.session_id', $3, true)`,
        [REAL_OWNER_ID, REAL_TENANT_ID, SESSION_BY_USER[REAL_SELLER_ID]],
      );
      const permissionCheck = await api.query("SELECT app.has_permission($1) AS granted", [
        "inventory.stock:read",
      ]);
      const { rowCount } = await api.query("SELECT * FROM app.inventory_lots");
      await api.query("ROLLBACK");

      expect({ granted: permissionCheck.rows[0].granted, rowCount }).toEqual({
        granted: false,
        rowCount: 0,
      });
    });

    it("el owner con su sesión revocada pierde el permiso aunque conserve el rol", async () => {
      await api.query("BEGIN");
      await actAs(REAL_OWNER_ID, REAL_TENANT_ID);
      await api.query(
        "UPDATE app.staff_sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1",
        [SESSION_BY_USER[REAL_OWNER_ID]],
      );
      const permissionCheck = await api.query("SELECT app.has_permission($1) AS granted", [
        "inventory.stock:read",
      ]);
      await api.query("ROLLBACK");

      expect(permissionCheck.rows[0].granted).toBe(false);
    });

    // Hallazgo de WP-B10, reproducido: con search_path = app, public,
    // pg_temp se buscaba PRIMERO y estas tablas temporales le daban al
    // vendedor accounting.journal:read. Ahora has_permission califica todo
    // con app. y deja pg_temp último.
    it("tablas temporales que sombrean roles, permisos y sesiones no le dan permisos al vendedor", async () => {
      await api.query("BEGIN");
      await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
      await api.query(
        `CREATE TEMP TABLE staff_user_roles (staff_user_id uuid, role_id uuid) ON COMMIT DROP`,
      );
      await api.query(
        `CREATE TEMP TABLE role_permissions (role_id uuid, permission_code text) ON COMMIT DROP`,
      );
      await api.query(
        `INSERT INTO pg_temp.staff_user_roles VALUES ($1, 'eeeeeeee-0000-0000-0000-000000000001')`,
        [REAL_SELLER_ID],
      );
      await api.query(
        `INSERT INTO pg_temp.role_permissions
         VALUES ('eeeeeeee-0000-0000-0000-000000000001', 'accounting.journal:read')`,
      );
      const permissionCheck = await api.query("SELECT app.has_permission($1) AS granted", [
        "accounting.journal:read",
      ]);
      const { rowCount } = await api.query("SELECT * FROM app.journal_entries");
      await api.query("ROLLBACK");

      expect({ granted: permissionCheck.rows[0].granted, rowCount }).toEqual({
        granted: false,
        rowCount: 0,
      });
    });
  });
  // WP-B14 (0020_journal_immutability.sql, RN-CTB-06), como joda_api con el
  // owner: tiene accounting.journal:write, así que el único freno es el
  // trigger. Todo dentro de una transacción que se revierte.
  describe("RN-CTB-06: un asiento contabilizado no se modifica, se reversa (WP-B14)", () => {
    const REAL_PERIOD_ID = "ffffffff-0000-0000-0000-000000000001";

    async function insertBalancedLines(entryId: string, debit: string, credit: string) {
      await api.query(
        `INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
         VALUES ($1, $2, $3, $5, 0), ($1, $2, $4, 0, $5)`,
        [REAL_TENANT_ID, entryId, debit, credit, 1000],
      );
    }

    it("el flujo real pasa: el asiento nace en borrador, recibe las líneas y se contabiliza en la misma transacción", async () => {
      await api.query("BEGIN");
      await actAs(REAL_OWNER_ID, REAL_TENANT_ID);
      await api.query(
        `INSERT INTO app.journal_entries (id, tenant_id, period_id, entry_no, entry_date, status, memo)
         VALUES ('f0000000-0000-0000-0000-0000000000e1', $1, $2, 901, current_date, 'draft', 'Flujo real')`,
        [REAL_TENANT_ID, REAL_PERIOD_ID],
      );
      await insertBalancedLines(
        "f0000000-0000-0000-0000-0000000000e1",
        realAccountId,
        realRevenueAccountId,
      );
      const { rowCount } = await api.query(
        "UPDATE app.journal_entries SET status = 'posted', posted_at = now() WHERE id = 'f0000000-0000-0000-0000-0000000000e1'",
      );
      const check = await api.query("SET CONSTRAINTS app.trg_journal_balanced IMMEDIATE");
      await api.query("ROLLBACK");

      expect({ rowCount, check: check.command }).toEqual({ rowCount: 1, check: "SET" });
    });

    it("el owner no puede colgar un par de líneas compensadas de un asiento contabilizado", async () => {
      await api.query("BEGIN");
      await actAs(REAL_OWNER_ID, REAL_TENANT_ID);
      await expect(
        insertBalancedLines(POSTED_ENTRY_ID, realAccountId, realRevenueAccountId),
      ).rejects.toMatchObject({
        code: "23001",
        message: "El asiento ya está contabilizado: no se modifica, se reversa",
      });
      await api.query("ROLLBACK");
    });

    it("el owner no puede reabrir un asiento contabilizado (posted → draft)", async () => {
      await api.query("BEGIN");
      await actAs(REAL_OWNER_ID, REAL_TENANT_ID);
      await expect(
        api.query("UPDATE app.journal_entries SET status = 'draft' WHERE id = $1", [
          POSTED_ENTRY_ID,
        ]),
      ).rejects.toMatchObject({
        code: "23001",
        message: "El asiento ya está contabilizado: no se modifica, se reversa",
      });
      await api.query("ROLLBACK");
    });

    it("el owner revierte con un asiento inverso contabilizado, y recién ahí el original pasa a reversed", async () => {
      await api.query("BEGIN");
      await actAs(REAL_OWNER_ID, REAL_TENANT_ID);
      await api.query(
        `INSERT INTO app.journal_entries (id, tenant_id, period_id, entry_no, entry_date, status, memo, reverses_id)
         VALUES ('f0000000-0000-0000-0000-0000000000e2', $1, $2, 902, current_date, 'draft', 'Reversión', $3)`,
        [REAL_TENANT_ID, REAL_PERIOD_ID, POSTED_ENTRY_ID],
      );
      await insertBalancedLines(
        "f0000000-0000-0000-0000-0000000000e2",
        realRevenueAccountId,
        realAccountId,
      );
      await api.query(
        "UPDATE app.journal_entries SET status = 'posted', posted_at = now() WHERE id = 'f0000000-0000-0000-0000-0000000000e2'",
      );
      await api.query("UPDATE app.journal_entries SET status = 'reversed' WHERE id = $1", [
        POSTED_ENTRY_ID,
      ]);
      const { rows } = await api.query("SELECT status FROM app.journal_entries WHERE id = $1", [
        POSTED_ENTRY_ID,
      ]);
      await api.query("ROLLBACK");

      expect(rows).toEqual([{ status: "reversed" }]);
    });

    // WP-B14b (0025_single_reversal.sql): un asiento se revierte una sola
    // vez. Antes de marcar el original reversed, contabilizar una segunda
    // reversión pasaba, y v_trial_balance sobre-revertía el saldo. Los dos
    // borradores conviven; el segundo falla al contabilizarse.
    it("el owner no puede contabilizar una segunda reversión del mismo asiento", async () => {
      await api.query("BEGIN");
      await actAs(REAL_OWNER_ID, REAL_TENANT_ID);
      await api.query(
        `INSERT INTO app.journal_entries (id, tenant_id, period_id, entry_no, entry_date, status, memo, reverses_id)
         VALUES ('f0000000-0000-0000-0000-0000000000e3', $1, $2, 903, current_date, 'draft', 'Reversión', $3),
                ('f0000000-0000-0000-0000-0000000000e4', $1, $2, 904, current_date, 'draft', 'Reversión repetida', $3)`,
        [REAL_TENANT_ID, REAL_PERIOD_ID, POSTED_ENTRY_ID],
      );
      await insertBalancedLines(
        "f0000000-0000-0000-0000-0000000000e3",
        realRevenueAccountId,
        realAccountId,
      );
      await insertBalancedLines(
        "f0000000-0000-0000-0000-0000000000e4",
        realRevenueAccountId,
        realAccountId,
      );
      await api.query(
        "UPDATE app.journal_entries SET status = 'posted', posted_at = now() WHERE id = 'f0000000-0000-0000-0000-0000000000e3'",
      );
      await expect(
        api.query(
          "UPDATE app.journal_entries SET status = 'posted', posted_at = now() WHERE id = 'f0000000-0000-0000-0000-0000000000e4'",
        ),
      ).rejects.toMatchObject({ code: "23505", constraint: "journal_entries_single_reversal" });
      await api.query("ROLLBACK");
    });

    // Hallazgo de la revisión cruzada de B14: el vendedor, sin
    // accounting.journal:read, ni siquiera llega al trigger. Para un UPDATE,
    // Postgres solo considera las filas que la política de SELECT deja ver
    // (accounting_read), así que su UPDATE afecta cero filas. Es un efecto
    // de cómo se combinan las políticas, no de una política de escritura:
    // 0016 dejó UPDATE en "solo tenant". Queda escrito para que nadie lo
    // tome por la defensa real.
    it("el vendedor, sin accounting.journal:read, no puede reabrir un asiento contabilizado: RLS lo deja sin filas", async () => {
      await api.query("BEGIN");
      await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
      const { rowCount } = await api.query(
        "UPDATE app.journal_entries SET status = 'draft' WHERE id = $1",
        [POSTED_ENTRY_ID],
      );
      await api.query("ROLLBACK");

      expect(rowCount).toBe(0);
    });

    // El auditor SÍ ve el asiento. Contra él, lo único que protege
    // RN-CTB-06 es el trigger, que no depende de ningún permiso.
    it("un auditor con accounting.journal:read pero sin :write ve el asiento contabilizado y el trigger le impide reabrirlo", async () => {
      await api.query("BEGIN");
      await actAs(REAL_AUDITOR_ID, REAL_TENANT_ID);
      const visible = await api.query("SELECT status FROM app.journal_entries WHERE id = $1", [
        POSTED_ENTRY_ID,
      ]);
      await expect(
        api.query("UPDATE app.journal_entries SET status = 'draft' WHERE id = $1", [
          POSTED_ENTRY_ID,
        ]),
      ).rejects.toMatchObject({
        code: "23001",
        message: "El asiento ya está contabilizado: no se modifica, se reversa",
      });
      await api.query("ROLLBACK");

      expect(visible.rows).toEqual([{ status: "posted" }]);
    });

    it("el owner de otro tenant no puede crear una reversión de un asiento del tenant real", async () => {
      await api.query("BEGIN");
      await actAs(PEER_OWNER_ID, PEER_TENANT_ID);
      await api.query(
        `INSERT INTO app.accounting_periods (id, tenant_id, code, starts_on, ends_on)
         VALUES ('f1000000-0000-0000-0000-0000000000a2', $1, '2026-09', '2026-09-01', '2026-09-30')`,
        [PEER_TENANT_ID],
      );
      await expect(
        api.query(
          `INSERT INTO app.journal_entries (tenant_id, period_id, entry_no, entry_date, status, memo, reverses_id)
           VALUES ($1, 'f1000000-0000-0000-0000-0000000000a2', 1, current_date, 'draft', 'Reversión cruzada', $2)`,
          [PEER_TENANT_ID, POSTED_ENTRY_ID],
        ),
      ).rejects.toMatchObject({
        code: "23503",
        message: `Asiento a revertir ${POSTED_ENTRY_ID} no encontrado en el tenant del asiento`,
      });
      await api.query("ROLLBACK");
    });
  });
  // WP-B12 (0021_app_views_security_invoker.sql). Las vistas de app.*
  // corrían como su dueño, que elude RLS: joda_api leía filas de todos los
  // tenants sin contexto. Ahora son security_invoker.
  describe("las vistas de app.* respetan RLS como una consulta directa (WP-B12, docs/data-model.md §5 y §7)", () => {
    it.each(["v_decant_yield", "v_trial_balance"])(
      "%s: sin tenant en contexto, joda_api no ve filas",
      async (view) => {
        await api.query("BEGIN");
        const { rowCount } = await api.query(`SELECT * FROM app.${view}`);
        await api.query("ROLLBACK");

        expect(rowCount).toBe(0);
      },
    );

    it.each(["v_decant_yield", "v_trial_balance"])(
      "%s: el owner de otro tenant, con todos los permisos, no ve las filas del tenant real",
      async (view) => {
        await api.query("BEGIN");
        await actAs(PEER_OWNER_ID, PEER_TENANT_ID);
        const { rowCount } = await api.query(`SELECT * FROM app.${view}`);
        await api.query("ROLLBACK");

        expect(rowCount).toBe(0);
      },
    );

    it.each(["v_decant_yield", "v_trial_balance"])(
      "%s: el owner del tenant real sí ve sus filas (control positivo)",
      async (view) => {
        await api.query("BEGIN");
        await actAs(REAL_OWNER_ID, REAL_TENANT_ID);
        const { rowCount } = await api.query(`SELECT * FROM app.${view}`);
        await api.query("ROLLBACK");

        expect(rowCount).toBeGreaterThan(0);
      },
    );

    // WP-B12b (0022_stock_available_invoker.sql). Hasta B12b este test
    // afirmaba lo contrario: v_stock_available corría como su dueño y
    // joda_api veía el saldo de todos los tenants sin contexto. Ahora es
    // invoker, y v_catalog_variants calcula la disponibilidad por su cuenta
    // (el describe del storefront, más abajo, cuida que siga andando).
    it("v_stock_available: sin tenant en contexto, joda_api no ve filas", async () => {
      await api.query("BEGIN");
      const { rowCount } = await api.query("SELECT * FROM app.v_stock_available");
      await api.query("ROLLBACK");

      expect(rowCount).toBe(0);
    });

    it("v_stock_available: el owner de otro tenant no ve el saldo del tenant real", async () => {
      await api.query("BEGIN");
      await actAs(PEER_OWNER_ID, PEER_TENANT_ID);
      const { rowCount } = await api.query("SELECT * FROM app.v_stock_available");
      await api.query("ROLLBACK");

      expect(rowCount).toBe(0);
    });

    // inventory_balances y stock_reservations exigen solo tenant: el
    // vendedor, sin inventory.stock:read, sigue viendo la disponibilidad de
    // su tenant, que es lo que necesita para vender (C10, C19).
    it.each([
      ["el owner", REAL_OWNER_ID],
      ["el vendedor", REAL_SELLER_ID],
    ] as const)(
      "v_stock_available: %s del tenant real ve el saldo de su tenant",
      async (_who, userId) => {
        await api.query("BEGIN");
        await actAs(userId, REAL_TENANT_ID);
        const { rows } = await api.query("SELECT DISTINCT tenant_id FROM app.v_stock_available");
        await api.query("ROLLBACK");

        expect(rows).toEqual([{ tenant_id: REAL_TENANT_ID }]);
      },
    );

    it("v_trial_balance: el vendedor, sin accounting.journal:read, no ve el balance de su propio tenant", async () => {
      await api.query("BEGIN");
      await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
      const { rowCount } = await api.query("SELECT * FROM app.v_trial_balance");
      await api.query("ROLLBACK");

      expect(rowCount).toBe(0);
    });

    // Con deriva cero la vista está vacía para todos y no prueba nada. Se
    // fabrica una deriva real de 1 ml en el granel (superusuario, fuera del
    // ledger) y se deshace al final.
    describe("v_balance_drift con una deriva real en el granel", () => {
      beforeAll(async () => {
        await db.client.query(
          "UPDATE app.inventory_balances SET on_hand = on_hand + 1 WHERE lot_id = $1",
          [BULK_LOT_ID],
        );
      });

      afterAll(async () => {
        await db.client.query(
          "UPDATE app.inventory_balances SET on_hand = on_hand - 1 WHERE lot_id = $1",
          [BULK_LOT_ID],
        );
      });

      it("sin tenant en contexto, joda_api no la ve", async () => {
        await api.query("BEGIN");
        const { rowCount } = await api.query("SELECT * FROM app.v_balance_drift");
        await api.query("ROLLBACK");

        expect(rowCount).toBe(0);
      });

      it("el owner de otro tenant no la ve", async () => {
        await api.query("BEGIN");
        await actAs(PEER_OWNER_ID, PEER_TENANT_ID);
        const { rowCount } = await api.query("SELECT * FROM app.v_balance_drift");
        await api.query("ROLLBACK");

        expect(rowCount).toBe(0);
      });

      // Documenta el fallo abierto del monitoreo (0021): para quien no ve
      // los lotes, la vista da cero filas aunque haya deriva. Un chequeo
      // de deriva tiene que correr con quien lo ve todo.
      it("el vendedor, sin inventory.stock:read, no la ve: cero filas no significa cero deriva", async () => {
        await api.query("BEGIN");
        await actAs(REAL_SELLER_ID, REAL_TENANT_ID);
        const { rowCount } = await api.query("SELECT * FROM app.v_balance_drift");
        await api.query("ROLLBACK");

        expect(rowCount).toBe(0);
      });

      it("el owner del tenant real ve la deriva de su lote", async () => {
        await api.query("BEGIN");
        await actAs(REAL_OWNER_ID, REAL_TENANT_ID);
        const { rows } = await api.query("SELECT lot_id, drift FROM app.v_balance_drift");
        await api.query("ROLLBACK");

        expect(rows).toEqual([{ lot_id: BULK_LOT_ID, drift: "1.000" }]);
      });
    });

    // public.v_catalog_* es la excepción deliberada: corre como su dueño.
    // Este test es el que descubrió, al escribir B12, que volver invoker a
    // v_stock_available dejaba al storefront sin disponibilidad (permission
    // denied como joda_readonly) mientras v_catalog_variants la consumía.
    // Desde WP-B12b la vista calcula la disponibilidad desde su propia
    // fuente, y esto cuida que siga andando. Se le da stock al
    // sellado (un lote nuevo con su recepción) para que in_stock tenga algo
    // que mostrar.
    describe("el storefront (joda_readonly) sigue viendo la disponibilidad del catálogo", () => {
      let storefront: Client;

      beforeAll(async () => {
        await db.client.query(`
          INSERT INTO app.inventory_lots
            (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
             fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
          VALUES ('99999999-0000-0000-0000-0000000000d2', '${REAL_TENANT_ID}',
                  '${SEALED_VARIANT_ID}', 2, 'unit', 0, 'PYG', 1, 0, 0);
          INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
          VALUES ('${REAL_TENANT_ID}', '99999999-0000-0000-0000-0000000000d2',
                  '${SEALED_VARIANT_ID}', 2, 'unit', 'purchase_receipt');
          ALTER ROLE joda_readonly PASSWORD '${JODA_API_TEST_PASSWORD}';
        `);
        storefront = new Client({
          host: db.container.getHost(),
          port: db.container.getPort(),
          database: db.container.getDatabase(),
          user: "joda_readonly",
          password: JODA_API_TEST_PASSWORD,
        });
        await storefront.connect();
      });

      afterAll(async () => {
        await storefront.end();
      });

      it("v_catalog_variants muestra el sellado como disponible, sin tenant en contexto", async () => {
        const { rows } = await storefront.query(
          "SELECT sku, in_stock FROM public.v_catalog_variants WHERE id = $1",
          [SEALED_VARIANT_ID],
        );

        expect(rows).toEqual([{ sku: "LAY-125-SEALED", in_stock: true }]);
      });

      // WP-B12b: v_catalog_variants corre como su dueño y ve el saldo de
      // todos los tenants. Es la única puerta a esa fuente, y joda_api no
      // la tiene concedida: si la tuviera, B12b solo habría movido la fuga.
      it("joda_api no puede leer public.v_catalog_variants", async () => {
        await expect(api.query("SELECT * FROM public.v_catalog_variants")).rejects.toMatchObject({
          code: "42501",
        });
      });

      it("joda_readonly no puede leer app.v_stock_available directamente", async () => {
        await expect(storefront.query("SELECT * FROM app.v_stock_available")).rejects.toMatchObject(
          {
            code: "42501",
          },
        );
      });
    });
  });
});
