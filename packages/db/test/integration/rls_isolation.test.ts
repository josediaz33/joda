import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("RLS aísla por tenant con el rol de aplicación joda_api (docs/security-spec.md §3.1, ADR-016)", () => {
  let db: TestDb;
  let api: Client;

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

  // COMPORTAMIENTO CONOCIDO, NO DESEADO — lo corrige WP-B09. Con B10,
  // inventory_lots exige inventory.stock:read también para los triggers de
  // invariantes (0009/0015), que son SECURITY INVOKER y leen el lote con los
  // permisos de quien inserta. El vendedor no tiene ese permiso: el trigger
  // ve el lote como inexistente (uom NULL) y rechaza el movimiento. Hoy no
  // rompe nada (ningún módulo de ventas escribe todavía), pero bloquea
  // WP-C19. Cuando B09 pase esas funciones a SECURITY DEFINER, este test
  // TIENE que fallar: invertirlo a "el vendedor sí puede insertar".
  it("inventory_movements (WP-B10, conocido — lo corrige WP-B09): un staff sin inventory.stock:read no puede insertar un movimiento de su propio tenant", async () => {
    await api.query("BEGIN");
    await api.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.tenant_id', $2, true),
              set_config('app.audience', 'staff', true)`,
      [REAL_SELLER_ID, REAL_TENANT_ID],
    );
    await expect(
      api.query(
        `INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
         VALUES ($1, '99999999-0000-0000-0000-000000000002',
                 '55555555-0000-0000-0000-000000000002', -5, 'ml', 'sale')`,
        [REAL_TENANT_ID],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      message: "Unidad de medida incompatible: el lote está en <NULL> y el movimiento en ml",
    });
    await api.query("ROLLBACK");
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
