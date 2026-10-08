import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "../setup/db.js";
import { runSmokeBusinessFlow } from "../../scripts/lib/smoke.mjs";

// WP-B08c (0023_cross_tenant_fks.sql). Una FK no evalúa RLS: hasta 0023
// verificaba que la fila apuntada EXISTE, no que sea del mismo tenant, y
// un staff creaba filas propias que apuntaban a filas de otro tenant
// (reproducido en la revisión de B09 con inventory_lots.variant_id y
// parent_lot_id). Ahora cada FK entre tablas con tenant_id es compuesta,
// (col, tenant_id) → (id, tenant_id).
//
// Esto prueba el COMPORTAMIENTO de cada una, conectado como joda_api
// (docs/testing-strategy.md §3.2): el owner del tenant real, con todos los
// permisos y sesión viva, intenta apuntar una fila propia a una fila del
// tenant vecino. Tiene que fallar, y por la FK que corresponde.
const REAL_TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PEER_TENANT_ID = "33333333-3333-3333-3333-333333333333";
const REAL_OWNER_ID = "22222222-2222-2222-2222-222222222222";
// Sesión viva de fixtures/every_tenant_table.sql (WP-B13).
const REAL_OWNER_SESSION = "b08b0000-0000-0000-0000-0000000005a1";
const JODA_API_TEST_PASSWORD = "cross-tenant-fks-test-only";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/every_tenant_table.sql");

// Inventario escrito de toda FK entre dos tablas con tenant_id, por su
// columna de referencia. Lista literal a propósito: el primer test la
// compara contra pg_constraint y falla si aparece una FK nueva.
const CROSS_TENANT_FKS = [
  "accessory_details.product_id",
  "accounting_periods.closed_by",
  "bom_components.component_variant_id",
  "bom_components.parent_variant_id",
  "brands.logo_media_id",
  "categories.parent_id",
  "channel_listings.channel_id",
  "channel_listings.variant_id",
  "chart_of_accounts.parent_id",
  "customer_addresses.customer_id",
  "customer_deposit_applications.applied_by",
  "customer_deposit_applications.deposit_id",
  "customer_deposit_applications.sale_order_id",
  "customer_deposits.created_by",
  "customer_deposits.customer_id",
  "customer_deposits.payment_id",
  "customer_deposits.sale_order_id",
  "decant_work_orders.created_by",
  "decant_work_orders.executed_by",
  "decant_work_orders.sale_order_id",
  "decant_work_orders.source_lot_id",
  "decant_work_orders.target_variant_id",
  "fiscal_document_lines.fiscal_document_id",
  "fiscal_document_lines.sale_order_line_id",
  "fiscal_documents.references_id",
  "fiscal_documents.sale_order_id",
  "fiscal_events.fiscal_document_id",
  "goods_receipt_lines.goods_receipt_id",
  "goods_receipt_lines.lot_id",
  "goods_receipt_lines.purchase_order_line_id",
  "goods_receipt_lines.variant_id",
  "goods_receipts.purchase_order_id",
  "goods_receipts.received_by",
  "inventory_balances.lot_id",
  "inventory_lots.goods_receipt_line_id",
  "inventory_lots.parent_lot_id",
  "inventory_lots.variant_id",
  "inventory_movements.created_by",
  "inventory_movements.lot_id",
  "inventory_movements.serial_unit_id",
  "inventory_movements.variant_id",
  "journal_entries.created_by",
  "journal_entries.period_id",
  "journal_entries.reverses_id",
  "journal_lines.account_id",
  "journal_lines.entry_id",
  "movement_cost_allocations.lot_id",
  "movement_cost_allocations.movement_id",
  "payment_events.payment_id",
  "payments.sale_order_id",
  "perfume_details.product_id",
  "product_categories.category_id",
  "product_categories.product_id",
  "product_media.media_id",
  "product_media.product_id",
  "product_media.variant_id",
  "product_tags.product_id",
  "product_tags.tag_id",
  "product_variants.product_id",
  "product_variants.source_variant_id",
  "products.brand_id",
  "purchase_order_lines.purchase_order_id",
  "purchase_order_lines.variant_id",
  "purchase_order_transitions.actor_id",
  "purchase_order_transitions.purchase_order_id",
  "purchase_orders.approved_by",
  "purchase_orders.created_by",
  "purchase_orders.supplier_id",
  "return_items.return_id",
  "return_items.sale_order_line_id",
  "return_items.serial_unit_id",
  "returns.customer_id",
  "returns.sale_order_id",
  "role_permissions.role_id",
  "sale_order_lines.sale_order_id",
  "sale_order_lines.serial_unit_id",
  "sale_order_lines.variant_id",
  "sale_order_transitions.sale_order_id",
  "sale_orders.channel_id",
  "sale_orders.created_by",
  "sale_orders.customer_id",
  "serialized_units.lot_id",
  "serialized_units.sold_order_line_id",
  "serialized_units.variant_id",
  "shipments.sale_order_id",
  "sourcing_scenario_lines.scenario_id",
  "sourcing_scenario_lines.supplier_id",
  "sourcing_scenario_lines.variant_id",
  "sourcing_scenarios.converted_to_po_id",
  "sourcing_scenarios.created_by",
  "staff_refresh_tokens.replaced_by",
  "staff_refresh_tokens.session_id",
  "staff_sessions.staff_user_id",
  "staff_user_roles.granted_by",
  "staff_user_roles.role_id",
  "staff_user_roles.staff_user_id",
  "stock_reservations.created_by",
  "stock_reservations.lot_id",
  "stock_reservations.serial_unit_id",
  "stock_reservations.variant_id",
  "supplier_contacts.supplier_id",
  "unposted_events.entry_id",
  "watch_details.product_id",
];

// Tablas donde joda_api no puede hacer UPDATE (REVOKE de 0010) o donde un
// trigger append-only lo rechaza antes: el intento es un INSERT que copia
// una fila real del tenant y cambia solo la columna de la FK.
const INSERT_ONLY_TABLES = new Set([
  "audit_log",
  "fiscal_events",
  "inventory_movements",
  "movement_cost_allocations",
  "purchase_order_transitions",
  "sale_order_transitions",
]);

// FKs cuyo cruce rechaza OTRA barrera antes que la FK compuesta. Siguen
// rechazadas, que es lo que importa; cada una dice cuál la frena y por qué.
const REJECTED_BEFORE_THE_FK: Record<string, { code: string; message: RegExp; why: string }> = {
  "inventory_balances.lot_id": {
    code: "42501",
    message: /^permission denied for table inventory_balances/,
    why: "WP-B09b (0024): joda_api no escribe la proyección de saldos, solo los triggers SECURITY DEFINER",
  },
  "inventory_movements.lot_id": {
    code: "23503",
    message: /^Lote .* no encontrado en el tenant del movimiento/,
    why: "trg_movement_uom (BEFORE, 0018) busca el lote en el tenant del movimiento",
  },
  "inventory_movements.variant_id": {
    code: "23503",
    message: /^Variante .* no encontrada en el tenant del movimiento/,
    why: "trg_sealed_lot_guard (BEFORE, 0018/0023) busca la variante en el tenant del movimiento",
  },
  "journal_lines.entry_id": {
    code: "23001",
    message: /^Asiento .* no encontrado en el tenant de la línea/,
    why: "trg_journal_lines_posted_guard (BEFORE, 0017/0020) busca el asiento en el tenant de la línea",
  },
  "journal_entries.reverses_id": {
    code: "23503",
    message: /^Asiento a revertir .* no encontrado en el tenant del asiento/,
    why: "trg_journal_entry_guard (BEFORE, 0020) busca el asiento revertido en el tenant",
  },
  "purchase_order_lines.purchase_order_id": {
    code: "23514",
    message: /^La línea .* no puede pasar a la orden/,
    why: "trg_po_line_no_reparent (BEFORE, 0036): una línea no cambia de orden, ni a la de otro tenant. Tampoco sirve un INSERT: la política de INSERT (0034) exige ver la orden padre en borrador y la del vecino es invisible, así que RLS rechaza antes que la FK",
  },
};

// Para UPDATE: qué fila del tenant real usar, cuando no sirve cualquiera.
// Un asiento contabilizado es inmutable (RN-CTB-06): se usa un borrador,
// sembrado en beforeAll, para que lo único que pueda rechazar sea la FK.
// Un lote con movimientos no cambia de variante (la FK lote+variante de
// los movimientos lo frena primero): se usa uno sin movimientos. Para
// copiar un movimiento, uno de un lote disponible: el sellado abierto no
// admite ninguno (RN-LOT-03). Los permisos de un rol de sistema no se escriben
// desde la API (WP-B11c, 0033): se usa la fila de un rol personalizado,
// sembrada en beforeAll, para que lo único que pueda rechazar sea la FK.
const ROW_FILTER: Record<string, string> = {
  inventory_lots:
    "NOT EXISTS (SELECT 1 FROM app.inventory_movements m WHERE m.lot_id = inventory_lots.id)",
  inventory_movements: "lot_id IN (SELECT id FROM app.inventory_lots WHERE status = 'available')",
  journal_entries: "status = 'draft'",
  journal_lines: "entry_id IN (SELECT id FROM app.journal_entries WHERE status = 'draft')",
  role_permissions:
    "NOT EXISTS (SELECT 1 FROM app.roles r WHERE r.id = role_permissions.role_id AND r.is_system)",
};

// Blanco propio para algunas FKs, clonado de una fila real que cumpla el
// filtro. Las tablas de detalle tienen además la FK (product_id, kind):
// un producto vecino de otro kind la haría fallar a ella primero. Y a un
// rol vecino con permisos, mover un permiso podría chocar con la PK
// (role_id, permission_code) antes que con la FK: el clon no tiene ninguno.
const PEER_TARGET: Record<string, string> = {
  "accessory_details.product_id": "t.kind = 'accessory'",
  "perfume_details.product_id": "t.kind = 'perfume'",
  "role_permissions.role_id": "true",
  "watch_details.product_id": "t.kind = 'watch'",
};

// Al clonar una fila destino para el tenant vecino, las columnas con un
// UNIQUE que no incluye tenant_id reciben un valor nuevo, o la copia
// chocaría con la original.
const GLOBALLY_UNIQUE_COLUMNS: Record<string, string[]> = {
  customers: ["auth_subject"],
  fiscal_documents: ["cdc"],
  payments: ["provider_ref"],
  roles: ["code"],
  staff_refresh_tokens: ["token_hash"],
};

// Columnas que un INSERT puede escribir: sin las generadas
// (products.search_vector).
async function insertableColumns(client: Client, table: string): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = $1 AND is_generated = 'NEVER'
      ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((row) => row.column_name as string);
}

type ForeignKey = {
  key: string;
  child: string;
  col: string;
  target: string;
  refcol: string;
  conname: string;
};

describe("toda FK entre tablas con tenant_id rechaza apuntar a otro tenant, como joda_api (WP-B08c, ADR-016)", () => {
  let db: TestDb;
  let api: Client;
  let fks: Map<string, ForeignKey>;
  // Id de una fila del tenant vecino para cada FK.
  const peerRowByFk = new Map<string, string>();

  async function actAsRealOwner(): Promise<void> {
    await api.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.tenant_id', $2, true),
              set_config('app.audience', 'staff', true),
              set_config('app.session_id', $3, true)`,
      [REAL_OWNER_ID, REAL_TENANT_ID, REAL_OWNER_SESSION],
    );
  }

  // Copia una fila real que cumpla el filtro, con otro id y el tenant
  // vecino. Las columnas con un UNIQUE global reciben un valor nuevo.
  async function clonePeerRow(target: string, filter: string): Promise<string> {
    const { rows: idRows } = await db.client.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = $1 AND column_name = 'id'`,
      [target],
    );
    const newId =
      idRows[0].data_type === "uuid"
        ? "to_jsonb(gen_random_uuid())"
        : `to_jsonb((SELECT max(id) + 1000000 FROM app.${target}))`;
    const cols = await insertableColumns(db.client, target);
    const fresh = (GLOBALLY_UNIQUE_COLUMNS[target] ?? [])
      .map((c) => `, '${c}', left(md5(random()::text) || md5(random()::text), 44)`)
      .join("");
    const { rows } = await db.client.query(
      `INSERT INTO app.${target} (${cols.map((c) => `"${c}"`).join(", ")}) OVERRIDING SYSTEM VALUE
       SELECT ${cols.map((c) => `r."${c}"`).join(", ")}
         FROM app.${target} t,
              jsonb_populate_record(NULL::app.${target},
                to_jsonb(t) || jsonb_build_object('id', ${newId}, 'tenant_id', $1::uuid${fresh})) r
        WHERE t.tenant_id = $2 AND ${filter}
        LIMIT 1
       RETURNING id::text`,
      [PEER_TENANT_ID, REAL_TENANT_ID],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    db = await startTestDb();
    await runSmokeBusinessFlow(db.client);
    await db.client.query(readFileSync(FIXTURE, "utf8"));

    // WP-B11c: un rol personalizado con un permiso en el tenant real, para el
    // UPDATE de `role_permissions` (ver ROW_FILTER).
    await db.client.query(`
      INSERT INTO app.roles (id, tenant_id, code, name)
      VALUES ('b11c0000-0000-0000-0000-0000000000f1', '${REAL_TENANT_ID}', 'b11c-fk',
              'Rol personalizado B11c');
      INSERT INTO app.role_permissions (tenant_id, role_id, permission_code)
      VALUES ('${REAL_TENANT_ID}', 'b11c0000-0000-0000-0000-0000000000f1', 'catalog.product:read');
    `);

    const { rows } = await db.client.query<ForeignKey>(
      `SELECT ch.relname || '.' || a.attname AS key,
              ch.relname AS child, a.attname AS col,
              tg.relname AS target, ra.attname AS refcol, c.conname
         FROM pg_constraint c
         JOIN pg_class ch     ON ch.oid = c.conrelid
         JOIN pg_class tg     ON tg.oid = c.confrelid
         JOIN pg_attribute a  ON a.attrelid  = c.conrelid  AND a.attnum  = c.conkey[1]
         JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = c.confkey[1]
         JOIN pg_attribute ct ON ct.attrelid = c.conrelid  AND ct.attname = 'tenant_id'
         JOIN pg_attribute tt ON tt.attrelid = c.confrelid AND tt.attname = 'tenant_id'
        WHERE c.contype = 'f'
          AND c.connamespace = 'app'::regnamespace
          AND a.attname <> 'tenant_id'
          AND NOT ('kind' = ANY (SELECT attname FROM pg_attribute
                                   WHERE attrelid = c.conrelid AND attnum = ANY (c.conkey)))
        ORDER BY 1`,
    );
    fks = new Map(rows.map((row) => [row.key, row]));

    // Una fila del tenant vecino en cada tabla destino: se copia una fila
    // real con otro id y el tenant vecino. Es solo un blanco: no importa
    // que sus propias FKs apunten al tenant real, así que se inserta con
    // session_replication_role = replica, que no evalúa FKs ni triggers.
    // Solo el superusuario del contenedor puede hacerlo.
    await db.client.query("SET session_replication_role = replica");
    const shared = new Map<string, string>();
    for (const fk of rows) {
      const own = PEER_TARGET[fk.key];
      if (own === undefined && shared.has(fk.target)) {
        peerRowByFk.set(fk.key, shared.get(fk.target)!);
        continue;
      }
      // Si el fixture ya le dio una fila al vecino (su owner, sus roles, su
      // sesión), se usa esa: clonar chocaría con uniques globales como
      // staff_users.auth_subject.
      const { rows: existing } =
        own === undefined
          ? await db.client.query(
              `SELECT id::text FROM app.${fk.target} WHERE tenant_id = $1 LIMIT 1`,
              [PEER_TENANT_ID],
            )
          : { rows: [] };
      const id = existing[0]?.id ?? (await clonePeerRow(fk.target, own ?? "true"));
      peerRowByFk.set(fk.key, id);
      if (own === undefined) shared.set(fk.target, id);
    }
    await db.client.query("SET session_replication_role = origin");

    // Un borrador del tenant real con dos líneas que cuadran, y un lote sin
    // movimientos (ver ROW_FILTER).
    await db.client.query(`
      INSERT INTO app.inventory_lots
        (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
         fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
      VALUES ('99999999-0000-0000-0000-0000000008c2', '${REAL_TENANT_ID}',
              '55555555-0000-0000-0000-00000000a001', 1, 'unit', 0, 'PYG', 1, 0, 0);
      INSERT INTO app.journal_entries (id, tenant_id, period_id, entry_no, entry_date, status, memo)
      VALUES ('f0000000-0000-0000-0000-0000000008c1', '${REAL_TENANT_ID}',
              'ffffffff-0000-0000-0000-000000000001', 81, current_date, 'draft', 'Borrador B08c');
      INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
      SELECT '${REAL_TENANT_ID}', 'f0000000-0000-0000-0000-0000000008c1', id,
             CASE code WHEN '1.1.01.001' THEN 1000 ELSE 0 END,
             CASE code WHEN '1.1.01.001' THEN 0 ELSE 1000 END
        FROM app.chart_of_accounts
       WHERE tenant_id = '${REAL_TENANT_ID}' AND code IN ('1.1.01.001', '4.1.01.001');
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

  afterEach(async () => {
    await api.query("ROLLBACK");
  });

  afterAll(async () => {
    await api.end();
    await db.stop();
  });

  it("el inventario escrito cubre toda FK entre tablas con tenant_id", () => {
    expect([...fks.keys()]).toEqual(CROSS_TENANT_FKS);
  });

  // Revisión cruzada de B08c: la FK compuesta también impide el otro lado,
  // que una fila APUNTADA cambie de tenant. Como joda_api, RLS (WITH CHECK
  // de tenant_isolation) lo frena antes y no deja ver la FK. Como el
  // superusuario del contenedor, que elude RLS, la única barrera es la FK.
  it("una variante con lotes no cambia de tenant: lo frena la FK aunque se eluda RLS", async () => {
    await db.client.query("BEGIN");
    await expect(
      db.client.query("UPDATE app.product_variants SET tenant_id = $1 WHERE id = $2", [
        PEER_TENANT_ID,
        "55555555-0000-0000-0000-000000000002",
      ]),
    ).rejects.toMatchObject({ code: "23503" });
    await db.client.query("ROLLBACK");
  });

  it("cada FK tiene una fila del tenant vecino para apuntarle", () => {
    expect(CROSS_TENANT_FKS.filter((key) => !peerRowByFk.has(key))).toEqual([]);
  });

  it.each(CROSS_TENANT_FKS)(
    "%s: el owner del tenant real no puede apuntar a una fila del tenant vecino",
    async (key) => {
      const fk = fks.get(key)!;
      const peerId = peerRowByFk.get(key)!;
      const filter = ROW_FILTER[fk.child] ?? "true";
      await api.query("BEGIN");
      await actAsRealOwner();

      let attempt: Promise<unknown>;
      if (INSERT_ONLY_TABLES.has(fk.child)) {
        // Todas las columnas menos el id, que lo genera la base.
        const cols = (await insertableColumns(api, fk.child))
          .filter((c) => c !== "id")
          .map((column_name) => ({ column_name }));
        // El único destino con id bigint es inventory_movements.
        const cast = fk.target === "inventory_movements" ? "bigint" : "uuid";
        const names = cols.map((c) => `"${c.column_name}"`).join(", ");
        const values = cols
          .map((c) => (c.column_name === fk.col ? `$1::${cast}` : `t."${c.column_name}"`))
          .join(", ");
        // Una fila con cantidad positiva, si la tabla la tiene: copiar una
        // salida podría fallar por saldo antes de llegar a la FK.
        const positive = cols.some((c) => c.column_name === "qty") ? "t.qty > 0" : "true";
        attempt = api.query(
          `INSERT INTO app.${fk.child} (${names})
           SELECT ${values}
             FROM app.${fk.child} t
            WHERE t.tenant_id = $2 AND ${positive} AND ${filter}
            LIMIT 1`,
          [peerId, REAL_TENANT_ID],
        );
      } else {
        attempt = api.query(
          `UPDATE app.${fk.child} SET "${fk.col}" = $1
            WHERE ctid = (SELECT ctid FROM app.${fk.child}
                           WHERE tenant_id = $2 AND ${filter} LIMIT 1)`,
          [peerId, REAL_TENANT_ID],
        );
      }

      const other = REJECTED_BEFORE_THE_FK[key];
      if (other) {
        await expect(attempt).rejects.toMatchObject({
          code: other.code,
          message: expect.stringMatching(other.message),
        });
      } else {
        await expect(attempt).rejects.toMatchObject({ code: "23503", constraint: fk.conname });
      }
      await api.query("ROLLBACK");
    },
  );
});
