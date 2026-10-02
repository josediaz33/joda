import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "../setup/db.js";
import { runSmokeBusinessFlow } from "../../scripts/lib/smoke.mjs";

// WP-B08b (docs/backlog.md). El invariante 22 prueba que toda tabla de
// app.* tiene RLS ACTIVO; no prueba que la política sea correcta (una
// `USING (true)` lo pasaría igual). Esto prueba el COMPORTAMIENTO, tabla
// por tabla, conectado como joda_api de verdad (docs/testing-strategy.md
// §3.2): sin tenant → cero filas; otro tenant → cero filas del tenant real;
// tenant real → exactamente sus filas, y no cero.
//
// Además ejercita como joda_api los triggers que rls_isolation.test.ts no
// cubre: el hueco que dejó pasar el hallazgo de WP-B09 desde WP-B01 fue
// que los triggers solo se habían probado como superusuario.
const REAL_TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PEER_TENANT_ID = "33333333-3333-3333-3333-333333333333";
const REAL_OWNER_ID = "22222222-2222-2222-2222-222222222222";
const PEER_OWNER_ID = "33333333-3333-3333-3333-3333333300a1";
// Sesiones vivas de fixtures/every_tenant_table.sql (WP-B13).
const REAL_OWNER_SESSION = "b08b0000-0000-0000-0000-0000000005a1";
const PEER_OWNER_SESSION = "b08b0000-0000-0000-0000-0000000005a2";
const JODA_API_TEST_PASSWORD = "rls-every-table-test-only";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/every_tenant_table.sql");

// Lista literal a propósito: el primer test falla si aparece una tabla con
// tenant_id que no está acá. Agregarla obliga a darle una fila en el
// fixture, y con eso las tres pruebas de abajo la cubren.
const TENANT_TABLES = [
  "accessory_details",
  "accounting_periods",
  "audit_log",
  "bom_components",
  "brands",
  "categories",
  "channel_listings",
  "chart_of_accounts",
  "customer_addresses",
  "customer_deposit_applications",
  "customer_deposits",
  "customers",
  "decant_work_orders",
  "fiscal_config",
  "fiscal_document_lines",
  "fiscal_documents",
  "fiscal_events",
  "goods_receipt_lines",
  "goods_receipts",
  "idempotency_keys",
  "inventory_balances",
  "inventory_lots",
  "inventory_movements",
  "journal_entries",
  "journal_lines",
  "media",
  "movement_cost_allocations",
  "payment_events",
  "payments",
  "perfume_details",
  "posting_rules",
  "product_categories",
  "product_media",
  "product_tags",
  "product_variants",
  "products",
  "purchase_order_lines",
  "purchase_order_transitions",
  "purchase_orders",
  "return_items",
  "returns",
  "role_permissions",
  "roles",
  "sale_order_lines",
  "sale_order_transitions",
  "sale_orders",
  "sales_channels",
  "serialized_units",
  "shipments",
  "sourcing_scenario_lines",
  "sourcing_scenarios",
  "staff_refresh_tokens",
  "staff_sessions",
  "staff_user_roles",
  "staff_users",
  "stock_reservations",
  "supplier_contacts",
  "suppliers",
  "tags",
  "unposted_events",
  "watch_details",
];

// Todo trigger no interno de app.*, con dónde se lo ejercita como
// joda_api. El test de cobertura falla si aparece uno que no está acá.
const TRIGGER_COVERAGE: Record<string, string> = {
  "audit_log.trg_audit_immutable": "este archivo: REVOKE de 0010 frena antes (42501)",
  "customers.trg_customers_updated": "este archivo: set_updated_at",
  "fiscal_documents.trg_fiscal_updated": "este archivo: set_updated_at",
  "fiscal_events.trg_fiscal_events_immutable": "este archivo: REVOKE de 0010 frena antes (42501)",
  "inventory_lots.trg_init_lot_balance": "rls_isolation.test.ts (WP-B09)",
  "inventory_lots.trg_lots_updated": "este archivo: set_updated_at",
  "inventory_lots.trg_sealed_lot_terminal": "rls_isolation.test.ts (WP-B08c)",
  "inventory_lots.trg_sealed_open_single_unit": "rls_isolation.test.ts (WP-C11)",
  "inventory_movements.trg_movement_uom": "rls_isolation.test.ts (WP-B09)",
  "inventory_movements.trg_movements_immutable": "este archivo: REVOKE de 0010 frena antes (42501)",
  "inventory_movements.trg_project_balance": "rls_isolation.test.ts (WP-B09)",
  "inventory_movements.trg_sealed_lot_guard": "rls_isolation.test.ts (WP-B09)",
  "journal_entries.trg_journal_entry_guard": "rls_isolation.test.ts (WP-B14)",
  "journal_lines.trg_journal_balanced": "rls_isolation.test.ts (WP-B09)",
  "journal_lines.trg_journal_lines_posted_guard": "rls_isolation.test.ts (WP-B10, WP-B14)",
  "movement_cost_allocations.trg_cost_alloc_immutable":
    "este archivo: REVOKE de 0010 frena antes (42501)",
  "movement_cost_allocations.trg_cost_allocation_matches": "rls_isolation.test.ts (WP-B09)",
  "payments.trg_payments_updated": "este archivo: set_updated_at",
  "product_variants.trg_variants_updated": "este archivo: set_updated_at",
  "products.trg_products_updated": "este archivo: set_updated_at",
  "purchase_order_transitions.trg_po_transitions_immutable": "este archivo: guard_append_only",
  "purchase_orders.trg_po_no_return_to_draft": "write_permissions.test.ts (WP-B11)",
  "purchase_orders.trg_po_updated": "este archivo: set_updated_at",
  "sale_order_transitions.trg_so_transitions_immutable": "este archivo: guard_append_only",
  "sale_orders.trg_so_updated": "este archivo: set_updated_at",
  "serialized_units.trg_serials_updated": "este archivo: set_updated_at",
  "staff_users.trg_staff_users_updated": "este archivo: set_updated_at",
  "suppliers.trg_suppliers_updated": "este archivo: set_updated_at",
  "tenants.trg_tenants_updated": "este archivo: set_updated_at",
};

// Tablas con set_updated_at y el filtro que deja al owner su propia fila.
// `tenants` no tiene tenant_id: su política es `id = current_tenant_id()`.
const UPDATED_AT_TABLES = [
  { table: "customers", filter: "tenant_id" },
  { table: "fiscal_documents", filter: "tenant_id" },
  { table: "inventory_lots", filter: "tenant_id" },
  { table: "payments", filter: "tenant_id" },
  { table: "product_variants", filter: "tenant_id" },
  { table: "products", filter: "tenant_id" },
  { table: "purchase_orders", filter: "tenant_id" },
  { table: "sale_orders", filter: "tenant_id" },
  { table: "serialized_units", filter: "tenant_id" },
  { table: "staff_users", filter: "tenant_id" },
  { table: "suppliers", filter: "tenant_id" },
  { table: "tenants", filter: "id" },
];

// Tablas append-only (guard_append_only) y qué frena un UPDATE de joda_api.
// En cuatro, el REVOKE de 0010 corta antes de que el trigger corra: el
// trigger solo se alcanza como superusuario (invariantes 1, 2 y 18). En las
// transiciones, joda_api tiene UPDATE y el que frena es el trigger.
const APPEND_ONLY_TABLES = [
  { table: "audit_log", code: "42501" },
  { table: "fiscal_events", code: "42501" },
  { table: "inventory_movements", code: "42501" },
  { table: "movement_cost_allocations", code: "42501" },
  { table: "purchase_order_transitions", code: "23001" },
  { table: "sale_order_transitions", code: "23001" },
];

describe("RLS aísla por tenant en CADA tabla con tenant_id, como joda_api (WP-B08b, docs/security-spec.md §3.1, ADR-016)", () => {
  let db: TestDb;
  let api: Client;

  async function actAsOwner(userId: string, tenantId: string, sessionId: string) {
    await api.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.tenant_id', $2, true),
              set_config('app.audience', 'staff', true),
              set_config('app.session_id', $3, true)`,
      [userId, tenantId, sessionId],
    );
  }

  beforeAll(async () => {
    db = await startTestDb();
    await runSmokeBusinessFlow(db.client);
    await db.client.query(readFileSync(FIXTURE, "utf8"));
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

  // Un test que falla a mitad de camino no deja la conexión abortada para
  // los siguientes (mismo motivo que en rls_isolation.test.ts).
  afterEach(async () => {
    await api.query("ROLLBACK");
  });

  afterAll(async () => {
    await api.end();
    await db.stop();
  });

  it("la lista cubre toda tabla de app.* con tenant_id", async () => {
    const { rows } = await db.client.query(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        WHERE n.nspname = 'app' AND c.relkind = 'r'
        ORDER BY c.relname`,
    );

    expect(rows.map((row) => row.relname)).toEqual(TENANT_TABLES);
  });

  it.each(TENANT_TABLES)("%s: sin tenant en contexto, joda_api no ve filas", async (table) => {
    await api.query("BEGIN");
    const { rows } = await api.query(`SELECT count(*)::int AS n FROM app.${table}`);
    await api.query("ROLLBACK");

    expect(rows[0].n).toBe(0);
  });

  it.each(TENANT_TABLES)(
    "%s: el owner de otro tenant, con todos los permisos, no ve ninguna fila del tenant real",
    async (table) => {
      await api.query("BEGIN");
      await actAsOwner(PEER_OWNER_ID, PEER_TENANT_ID, PEER_OWNER_SESSION);
      const { rows } = await api.query(
        `SELECT count(*)::int AS n FROM app.${table} WHERE tenant_id = $1`,
        [REAL_TENANT_ID],
      );
      await api.query("ROLLBACK");

      expect(rows[0].n).toBe(0);
    },
  );

  it.each(TENANT_TABLES)(
    "%s: el owner del tenant real ve exactamente sus filas, y hay filas (control positivo)",
    async (table) => {
      const truth = await db.client.query(
        `SELECT count(*)::int AS n FROM app.${table} WHERE tenant_id = $1`,
        [REAL_TENANT_ID],
      );
      await api.query("BEGIN");
      await actAsOwner(REAL_OWNER_ID, REAL_TENANT_ID, REAL_OWNER_SESSION);
      const seen = await api.query(`SELECT count(*)::int AS n FROM app.${table}`);
      await api.query("ROLLBACK");

      expect({ seen: seen.rows[0].n, hasRows: truth.rows[0].n > 0 }).toEqual({
        seen: truth.rows[0].n,
        hasRows: true,
      });
    },
  );

  describe("triggers ejercitados como joda_api", () => {
    it("todo trigger de app.* está en el mapa de cobertura", async () => {
      const { rows } = await db.client.query(
        `SELECT c.relname || '.' || tg.tgname AS key
           FROM pg_trigger tg
           JOIN pg_class c ON c.oid = tg.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND NOT tg.tgisinternal
          ORDER BY 1`,
      );

      expect(rows.map((row) => row.key)).toEqual(Object.keys(TRIGGER_COVERAGE).sort());
    });

    it.each(UPDATED_AT_TABLES)(
      "$table: una edición del owner renueva updated_at aunque intente fijarlo (set_updated_at)",
      async ({ table, filter }) => {
        await api.query("BEGIN");
        await actAsOwner(REAL_OWNER_ID, REAL_TENANT_ID, REAL_OWNER_SESSION);
        const { rows } = await api.query(
          `WITH edited AS (
             UPDATE app.${table} SET updated_at = '2000-01-01T00:00:00Z'
              WHERE ${filter} = $1
             RETURNING updated_at)
           SELECT count(*) > 0 AS edited,
                  bool_and(updated_at > '2000-01-01T00:00:00Z'::timestamptz) AS refreshed
             FROM edited`,
          [REAL_TENANT_ID],
        );
        await api.query("ROLLBACK");

        expect(rows).toEqual([{ edited: true, refreshed: true }]);
      },
    );

    it.each(APPEND_ONLY_TABLES)(
      "$table: el owner no puede reescribir una fila (append-only, rechazo $code)",
      async ({ table, code }) => {
        await api.query("BEGIN");
        await actAsOwner(REAL_OWNER_ID, REAL_TENANT_ID, REAL_OWNER_SESSION);
        await expect(
          api.query(`UPDATE app.${table} SET tenant_id = tenant_id WHERE tenant_id = $1`, [
            REAL_TENANT_ID,
          ]),
        ).rejects.toMatchObject({ code });
        await api.query("ROLLBACK");
      },
    );
  });
});
