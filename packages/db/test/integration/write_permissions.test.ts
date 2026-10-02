import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "../setup/db.js";
import { runSmokeBusinessFlow } from "../../scripts/lib/smoke.mjs";

// WP-B11 (packages/db/migrations/0030_write_permissions_sensitive_tables.sql).
// Regla que verifican: docs/security-spec.md §3.1 (capa 1) y ADR-016 — en
// suppliers, purchase_orders, inventory_lots, chart_of_accounts y
// customer_deposits, escribir exige tenant Y el permiso de escritura, no solo
// tenant. WP-B11b (0032_write_permissions_sourcing_scenarios.sql) suma
// sourcing_scenarios: UPDATE y DELETE exigen market.sourcing:write.
//
// Cada prueba ejercita la operación REAL del rol, conectado como joda_api
// (nunca como el superusuario del contenedor, que elude RLS): el INSERT ...
// RETURNING que emite Prisma y el UPDATE ... WHERE. No alcanza con que la
// política exista. Con RLS esas dos operaciones evalúan TAMBIÉN la política
// de lectura: un rol que escribe sin poder leer no recibe un error claro, su
// INSERT ... RETURNING se rechaza con 42501 y su UPDATE o DELETE afecta cero
// filas. Las pruebas de "sin lectura" fijan eso.
const REAL_TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PEER_TENANT_ID = "44444444-4444-4444-4444-444444444444";
const JODA_API_TEST_PASSWORD = "write-permissions-test-only";

// Sembrados por smoke_business_flow.sql.
const REAL_OWNER_ID = "22222222-2222-2222-2222-222222222222";
const SUPPLIER_ID = "66666666-6666-6666-6666-666666666666";
const SEALED_VARIANT_ID = "55555555-0000-0000-0000-000000000001";
const CUSTOMER_ID = "aaaaaaaa-0000-0000-0000-000000000001";

// Sembrados por este archivo, con la superconexión (las pruebas de abajo
// los modifican dentro de una transacción que se revierte).
const DRAFT_PO_ID = "b1100000-0000-0000-0000-0000000000d1";
const SENT_PO_ID = "b1100000-0000-0000-0000-0000000000d2";
const PENDING_PO_ID = "b1100000-0000-0000-0000-0000000000d3";
const APPROVED_PO_ID = "b1100000-0000-0000-0000-0000000000d4";
const PARTIAL_PO_ID = "b1100000-0000-0000-0000-0000000000d5";
const RECEIVED_PO_ID = "b1100000-0000-0000-0000-0000000000d6";
const CANCELLED_PO_ID = "b1100000-0000-0000-0000-0000000000d7";
const LOT_ID = "b1100000-0000-0000-0000-0000000000c1";
const NEW_LOT_ID = "b1100000-0000-0000-0000-0000000000c2";
const DEPOSIT_ID = "b1100000-0000-0000-0000-0000000000e1";
const SCENARIO_ID = "b1100000-0000-0000-0000-0000000000f1";
// WP-B11c: un rol personalizado con un permiso y asignado a un usuario, para
// que las pruebas lo editen, lo revoquen y lo borren sin tocar roles de sistema.
const TARGET_ROLE_ID = "b1100000-0000-0000-0000-0000000000b1";
// WP-B11d: una línea de orden para las pruebas de líneas (se edita y se borra),
// otra que referencia la recepción (la FK impide borrarla), la recepción con su
// línea, y un pedido por cada estado de la máquina de A08. Sembrados por el
// smoke: el canal de ventas.
const SALES_CHANNEL_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const PO_LINE_ID = "b1100000-0000-0000-0000-0000000000a2";
const RECEIPT_PO_LINE_ID = "b1100000-0000-0000-0000-0000000000a3";
const RECEIPT_ID = "b1100000-0000-0000-0000-0000000000a4";
const RECEIPT_LINE_ID = "b1100000-0000-0000-0000-0000000000a5";
const NEW_RECEIPT_ID = "b1100000-0000-0000-0000-0000000000a6";
const SALE_ORDER_IDS = {
  draft: "b1100000-0000-0000-0000-000000000500",
  awaiting_payment: "b1100000-0000-0000-0000-000000000501",
  paid: "b1100000-0000-0000-0000-000000000502",
  preparing: "b1100000-0000-0000-0000-000000000503",
  ready: "b1100000-0000-0000-0000-000000000504",
  shipped: "b1100000-0000-0000-0000-000000000505",
  delivered: "b1100000-0000-0000-0000-000000000506",
  cancelled: "b1100000-0000-0000-0000-000000000507",
  refunded: "b1100000-0000-0000-0000-000000000508",
} as const;
const SCENARIO_LINE_ID = "b1100000-0000-0000-0000-0000000000f2";

interface Actor {
  userId: string;
  sessionId: string;
}

// Roles y permisos que crea este archivo además de los del seed. Sin lógica
// en los tests: cada uno es una lista literal.
const READ_ONLY = [
  "market.supplier:read",
  "market.purchase_order:read",
  "inventory.stock:read",
  "accounting.journal:read",
  "accounting.deposit:read",
  "market.sourcing:read",
  "settings.user:read",
];
const CUSTOM_ROLES = {
  // Lee todo lo sensible y no escribe nada.
  readOnly: { n: 1, permissions: READ_ONLY },
  // Escribe proveedores, órdenes de compra, plan de cuentas y lotes SIN el
  // permiso de lectura de esa tabla: la trampa de la lectura.
  supplierWriterNoRead: { n: 2, permissions: ["market.supplier:write"] },
  accountantNoRead: { n: 3, permissions: ["accounting.journal:write"] },
  receiverNoRead: { n: 4, permissions: ["market.purchase_order:receive"] },
  // Aprueba órdenes de compra y las lee; no tiene :write.
  approver: { n: 5, permissions: ["market.purchase_order:read", "market.purchase_order:approve"] },
  // Los cuatro permisos que el mapeo de José (2026-09-25) habilita para
  // crear o mover lotes, cada uno solo y con la lectura de lotes.
  receives: { n: 6, permissions: ["market.purchase_order:receive", "inventory.stock:read"] },
  decants: { n: 7, permissions: ["inventory.decant:execute", "inventory.stock:read"] },
  refunds: { n: 8, permissions: ["sales.order:refund", "inventory.stock:read"] },
  adjusts: { n: 9, permissions: ["inventory.stock:adjust", "inventory.stock:read"] },
  // Lee lotes y nada más.
  stockReader: { n: 10, permissions: ["inventory.stock:read"] },
  // Lee y escribe la contabilidad del plan de cuentas.
  accountant: { n: 11, permissions: ["accounting.journal:read", "accounting.journal:write"] },
  // Recibe y lee órdenes: la combinación que el depósito del seed no tiene.
  orderReceiver: {
    n: 12,
    permissions: ["market.purchase_order:receive", "market.purchase_order:read"],
  },
  // WP-B11b: escribe escenarios de sourcing SIN leerlos (la trampa de la
  // lectura) y, aparte, los lee y escribe.
  sourcingWriterNoRead: { n: 13, permissions: ["market.sourcing:write"] },
  sourcingEditor: { n: 14, permissions: ["market.sourcing:read", "market.sourcing:write"] },
  // WP-B11c: administra usuarios y roles, con y sin el permiso de lectura de
  // `settings.user`. Como el SELECT de las tres tablas es por tenant, la
  // trampa de la lectura no existe: los dos escriben igual.
  userAdmin: { n: 15, permissions: ["settings.user:read", "settings.user:write"] },
  userAdminNoRead: { n: 16, permissions: ["settings.user:write"] },
  // WP-B11d: escribe compras (crea órdenes y devuelve a proveedores, `return_out`)
  // y las lee; no recibe, no vende ni ajusta.
  poWriter: { n: 17, permissions: ["market.purchase_order:read", "market.purchase_order:write"] },
} as const;

// Las denegaciones de un rol que tampoco LEE usan las formas que no
// necesitan la política de lectura: un INSERT sin RETURNING y un UPDATE sin
// WHERE. Con RETURNING, o con un WHERE que lee columnas, ese rol ya queda
// afuera por la lectura, y la prueba pasaría aunque la política de escritura
// no existiera. (Un UPDATE sin WHERE, o con `WHERE true`, no lee nada.)
const UPDATE_ALL_SUPPLIERS = `UPDATE app.suppliers SET notes = 'editado'`;
const UPDATE_ALL_POS = `UPDATE app.purchase_orders SET notes = 'editada'`;
const UPDATE_ALL_LOTS = `UPDATE app.inventory_lots SET batch_code = 'B11'`;
const UPDATE_ALL_DEPOSITS = `UPDATE app.customer_deposits SET notes = 'editada'`;

const INSERT_SUPPLIER = `INSERT INTO app.suppliers (tenant_id, code, name)
  VALUES ('${REAL_TENANT_ID}', 'PROV-B11', 'Proveedor B11')`;
const UPDATE_SUPPLIER = `UPDATE app.suppliers SET notes = 'editado' WHERE id = '${SUPPLIER_ID}'`;
const DELETE_SUPPLIER = `DELETE FROM app.suppliers WHERE id = '${SUPPLIER_ID}'`;

const INSERT_PO = `INSERT INTO app.purchase_orders (tenant_id, supplier_id, code, currency, created_by)
  VALUES ('${REAL_TENANT_ID}', '${SUPPLIER_ID}', 'OC-B11-NUEVA', 'USD', '${REAL_OWNER_ID}')`;
const UPDATE_PO = `UPDATE app.purchase_orders SET notes = 'editada' WHERE id = '${DRAFT_PO_ID}'`;
const DELETE_DRAFT_PO = `DELETE FROM app.purchase_orders WHERE id = '${DRAFT_PO_ID}'`;
const DELETE_SENT_PO = `DELETE FROM app.purchase_orders WHERE id = '${SENT_PO_ID}'`;
const DELETE_PENDING_PO = `DELETE FROM app.purchase_orders WHERE id = '${PENDING_PO_ID}'`;
// Devolver una orden a borrador: el primer paso del rodeo que la revisión de
// B11 encontró para borrar una orden enviada.
const RETURN_TO_DRAFT = (id: string) =>
  `UPDATE app.purchase_orders SET status = 'draft' WHERE id = '${id}'`;
const RETURN_ALL_TO_DRAFT = `UPDATE app.purchase_orders SET status = 'draft'`;
// El rodeo de tres pasos: pending_approval es el otro estado previo a la
// aprobación, y desde él se llega a borrador. Si una orden aprobada vuelve a
// pending_approval, la guarda de borrador no sostiene nada.
const RETURN_TO_PENDING = (id: string) =>
  `UPDATE app.purchase_orders SET status = 'pending_approval' WHERE id = '${id}'`;

const INSERT_LOT = `INSERT INTO app.inventory_lots
  (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
   fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
  VALUES ('${NEW_LOT_ID}', '${REAL_TENANT_ID}', '${SEALED_VARIANT_ID}', 1, 'unit', 0, 'PYG', 1, 0, 0)`;
const UPDATE_LOT = `UPDATE app.inventory_lots SET batch_code = 'B11' WHERE id = '${LOT_ID}'`;
const DELETE_LOT = `DELETE FROM app.inventory_lots WHERE id = '${LOT_ID}'`;

const INSERT_ACCOUNT = `INSERT INTO app.chart_of_accounts (tenant_id, code, name, account_type)
  VALUES ('${REAL_TENANT_ID}', '9.9.99.001', 'Cuenta B11', 'asset')`;
const UPDATE_ACCOUNT = `UPDATE app.chart_of_accounts SET name = 'editada' WHERE code = '1.1.01.001'`;
const DELETE_ACCOUNT = `DELETE FROM app.chart_of_accounts WHERE code = '1.1.01.001'`;

const INSERT_DEPOSIT = `INSERT INTO app.customer_deposits (tenant_id, customer_id, amount_pyg)
  VALUES ('${REAL_TENANT_ID}', '${CUSTOMER_ID}', 250000)`;
const UPDATE_DEPOSIT = `UPDATE app.customer_deposits SET applied_pyg = 50000 WHERE id = '${DEPOSIT_ID}'`;
const DELETE_DEPOSIT = `DELETE FROM app.customer_deposits WHERE id = '${DEPOSIT_ID}'`;

const INSERT_SCENARIO = `INSERT INTO app.sourcing_scenarios (tenant_id, name, created_by)
  VALUES ('${REAL_TENANT_ID}', 'Escenario B11b nuevo', '${REAL_OWNER_ID}')`;
const UPDATE_SCENARIO = `UPDATE app.sourcing_scenarios SET name = 'editado' WHERE id = '${SCENARIO_ID}'`;
const UPDATE_ALL_SCENARIOS = `UPDATE app.sourcing_scenarios SET name = 'editado'`;
const DELETE_SCENARIO = `DELETE FROM app.sourcing_scenarios WHERE id = '${SCENARIO_ID}'`;
const DELETE_ALL_SCENARIOS = `DELETE FROM app.sourcing_scenarios`;

// WP-B11c. `INSERT ... SELECT` y `WHERE role_id` leen `roles` y las otras dos
// tablas: su SELECT es por tenant, así que ningún rol tiene la trampa de la
// lectura y todas las operaciones valen con o sin `settings.user:read`.
const INSERT_ROLE = `INSERT INTO app.roles (tenant_id, code, name)
  VALUES ('${REAL_TENANT_ID}', 'b11c-nuevo', 'Rol B11c nuevo')`;
const INSERT_SYSTEM_ROLE = `INSERT INTO app.roles (tenant_id, code, name, is_system)
  VALUES ('${REAL_TENANT_ID}', 'b11c-sistema', 'Rol de sistema falso', true)`;
const RENAME_TARGET_ROLE = `UPDATE app.roles SET name = 'renombrado' WHERE id = '${TARGET_ROLE_ID}'`;
const RENAME_ALL_ROLES = `UPDATE app.roles SET name = 'renombrado'`;
const DELETE_TARGET_ROLE = `DELETE FROM app.roles WHERE id = '${TARGET_ROLE_ID}'`;
const DELETE_DEPOSITO_ROLE = `DELETE FROM app.roles
  WHERE tenant_id = '${REAL_TENANT_ID}' AND code = 'deposito'`;
const OWNER_ROLE = `tenant_id = '${REAL_TENANT_ID}' AND code = 'owner'`;
const DELETE_OWNER_ROLE = `DELETE FROM app.roles WHERE ${OWNER_ROLE}`;
const RENAME_OWNER_ROLE = `UPDATE app.roles SET name = 'Otro nombre' WHERE ${OWNER_ROLE}`;
const RECODE_OWNER_ROLE = `UPDATE app.roles SET code = 'otro-codigo' WHERE ${OWNER_ROLE}`;
const UNMARK_OWNER_ROLE = `UPDATE app.roles SET is_system = false WHERE ${OWNER_ROLE}`;

const INSERT_ROLE_PERMISSION = `INSERT INTO app.role_permissions (tenant_id, role_id, permission_code)
  VALUES ('${REAL_TENANT_ID}', '${TARGET_ROLE_ID}', 'catalog.product:write')`;
const UPDATE_ROLE_PERMISSION = `UPDATE app.role_permissions SET permission_code = 'catalog.product:publish'
  WHERE role_id = '${TARGET_ROLE_ID}' AND permission_code = 'catalog.product:read'`;
const UPDATE_ALL_ROLE_PERMISSIONS = `UPDATE app.role_permissions SET permission_code = 'catalog.product:publish'`;
const DELETE_ROLE_PERMISSION = `DELETE FROM app.role_permissions
  WHERE role_id = '${TARGET_ROLE_ID}' AND permission_code = 'catalog.product:read'`;
// La fila que deja UPDATE_ROLE_PERMISSION, para quien cambia y después quita.
const DELETE_UPDATED_ROLE_PERMISSION = `DELETE FROM app.role_permissions
  WHERE role_id = '${TARGET_ROLE_ID}' AND permission_code = 'catalog.product:publish'`;
const DELETE_ALL_ROLE_PERMISSIONS = `DELETE FROM app.role_permissions`;
const COUNT_TARGET_ROLE_PERMISSIONS = `SELECT count(*)::int AS n FROM app.role_permissions
  WHERE role_id = '${TARGET_ROLE_ID}'`;
const COUNT_DEPOSITO_PERMISSIONS = `SELECT count(*)::int AS n FROM app.role_permissions rp
  JOIN app.roles r ON r.id = rp.role_id
  WHERE r.tenant_id = '${REAL_TENANT_ID}' AND r.code = 'deposito'`;
const COUNT_ROLE = (where: string) => `SELECT count(*)::int AS n FROM app.roles WHERE ${where}`;

// WP-B11d. Un movimiento del ledger sobre `LOT_ID`, un lote sellado de
// unidades con saldo (lo siembra el beforeAll con un ajuste). El INSERT lleva
// RETURNING, como el de Prisma: el SELECT del ledger es por tenant, así que no
// hay trampa de la lectura. `reference` es SQL literal: `NULL` o `'lot_opening'`.
const INSERT_MOVEMENT = (type: string, qty: number, reference = "NULL") =>
  `INSERT INTO app.inventory_movements
     (tenant_id, lot_id, variant_id, qty, uom, movement_type, reference_type)
   VALUES ('${REAL_TENANT_ID}', '${LOT_ID}', '${SEALED_VARIANT_ID}', ${qty}, 'unit', '${type}',
           ${reference})
   RETURNING id`;

const INSERT_PO_LINE = `INSERT INTO app.purchase_order_lines
  (tenant_id, purchase_order_id, variant_id, qty_ordered, uom, unit_price_minor)
  VALUES ('${REAL_TENANT_ID}', '${DRAFT_PO_ID}', '${SEALED_VARIANT_ID}', 2, 'unit', 5000)`;
const UPDATE_PO_LINE = `UPDATE app.purchase_order_lines SET unit_price_minor = 1
  WHERE id = '${PO_LINE_ID}'`;
const UPDATE_ALL_PO_LINES = `UPDATE app.purchase_order_lines SET unit_price_minor = 1`;
const DELETE_PO_LINE = `DELETE FROM app.purchase_order_lines WHERE id = '${PO_LINE_ID}'`;

const INSERT_RECEIPT = `INSERT INTO app.goods_receipts
  (id, tenant_id, purchase_order_id, code, fx_rate_to_pyg, received_by)
  VALUES ('${NEW_RECEIPT_ID}', '${REAL_TENANT_ID}', '${APPROVED_PO_ID}', 'REC-B11D-NUEVA', 7400,
          '${REAL_OWNER_ID}')`;
const UPDATE_RECEIPT = `UPDATE app.goods_receipts SET notes = 'editada' WHERE id = '${RECEIPT_ID}'`;
const UPDATE_ALL_RECEIPTS = `UPDATE app.goods_receipts SET notes = 'editada'`;
const DELETE_RECEIPT = `DELETE FROM app.goods_receipts WHERE id = '${RECEIPT_ID}'`;
const INSERT_RECEIPT_LINE = `INSERT INTO app.goods_receipt_lines
  (tenant_id, goods_receipt_id, purchase_order_line_id, variant_id, qty_received, uom,
   unit_price_minor)
  VALUES ('${REAL_TENANT_ID}', '${RECEIPT_ID}', '${RECEIPT_PO_LINE_ID}', '${SEALED_VARIANT_ID}', 1,
          'unit', 5000)`;
const UPDATE_RECEIPT_LINE = `UPDATE app.goods_receipt_lines SET batch_code = 'L-B11D'
  WHERE id = '${RECEIPT_LINE_ID}'`;
const UPDATE_ALL_RECEIPT_LINES = `UPDATE app.goods_receipt_lines SET batch_code = 'L-B11D'`;
const DELETE_RECEIPT_LINE = `DELETE FROM app.goods_receipt_lines WHERE id = '${RECEIPT_LINE_ID}'`;

const SET_SALE_STATUS = (status: string, id: string) =>
  `UPDATE app.sale_orders SET status = '${status}' WHERE id = '${id}'`;
const DELETE_SALE_ORDER = (id: string) => `DELETE FROM app.sale_orders WHERE id = '${id}'`;
const UPDATE_ALL_SALE_ORDERS = `UPDATE app.sale_orders SET notes = 'editado'`;
const COUNT_SALE_ORDER = (id: string) =>
  `SELECT count(*)::int AS n FROM app.sale_orders WHERE id = '${id}'`;
// Los permisos de los roles de sistema son la matriz de security-spec §2.1: los
// cambia el seed, no la API. Del tenant real: dueño 28, encargado 27, vendedor 6,
// depósito 5.
const COUNT_OWNER_ROLE_PERMISSIONS = `SELECT count(*)::int AS n FROM app.role_permissions rp
  JOIN app.roles r ON r.id = rp.role_id
  WHERE r.tenant_id = '${REAL_TENANT_ID}' AND r.code = 'owner'`;
const COUNT_SYSTEM_ROLE_PERMISSIONS = `SELECT count(*)::int AS n FROM app.role_permissions rp
  JOIN app.roles r ON r.id = rp.role_id
  WHERE r.tenant_id = '${REAL_TENANT_ID}' AND r.is_system`;
const DELETE_OWNER_ROLE_PERMISSIONS = `DELETE FROM app.role_permissions
  WHERE role_id = (SELECT id FROM app.roles WHERE ${OWNER_ROLE})`;
const CAN_ADMINISTER_USERS = `SELECT app.has_permission('settings.user:write') AS ok`;
const SELLER_ROLE_ID = `(SELECT id FROM app.roles
  WHERE tenant_id = '${REAL_TENANT_ID}' AND code = 'vendedor')`;
const INSERT_PERMISSION_INTO_SYSTEM_ROLE = `INSERT INTO app.role_permissions
  (tenant_id, role_id, permission_code)
  VALUES ('${REAL_TENANT_ID}', ${SELLER_ROLE_ID}, 'settings.user:write')`;
const UPDATE_SYSTEM_ROLE_PERMISSION = `UPDATE app.role_permissions
  SET permission_code = 'catalog.product:publish'
  WHERE role_id = ${SELLER_ROLE_ID} AND permission_code = 'catalog.product:read'`;
const MOVE_PERMISSION_TO_SYSTEM_ROLE = `UPDATE app.role_permissions
  SET role_id = ${SELLER_ROLE_ID} WHERE role_id = '${TARGET_ROLE_ID}'`;

const INSERT_PERMISSION = `INSERT INTO app.permissions (code, description)
  VALUES ('b11c.prueba:read', 'Permiso de prueba')`;
const UPDATE_PERMISSION = `UPDATE app.permissions SET description = 'editado'
  WHERE code = 'catalog.product:read'`;
const DELETE_PERMISSION = `DELETE FROM app.permissions WHERE code = 'catalog.product:read'`;
// Las líneas del escenario llevan precios de proveedor, FX asumido y margen
// proyectado: se leen con `market.sourcing:read` y se escriben con `:write`.
const SELECT_SCENARIO_LINES = `SELECT unit_price_minor FROM app.sourcing_scenario_lines`;
const INSERT_SCENARIO_LINE = `INSERT INTO app.sourcing_scenario_lines
  (tenant_id, scenario_id, variant_id, qty, unit_price_minor, currency, fx_assumed)
  VALUES ('${REAL_TENANT_ID}', '${SCENARIO_ID}', '${SEALED_VARIANT_ID}', 1, 9000, 'USD', 7400)`;
const UPDATE_SCENARIO_LINE = `UPDATE app.sourcing_scenario_lines SET unit_price_minor = 1
  WHERE id = '${SCENARIO_LINE_ID}'`;
const UPDATE_ALL_SCENARIO_LINES = `UPDATE app.sourcing_scenario_lines SET unit_price_minor = 1`;
const DELETE_SCENARIO_LINE = `DELETE FROM app.sourcing_scenario_lines
  WHERE id = '${SCENARIO_LINE_ID}'`;
const DELETE_ALL_SCENARIO_LINES = `DELETE FROM app.sourcing_scenario_lines`;
const COUNT_SCENARIO_LINES = `SELECT count(*)::int AS n FROM app.sourcing_scenario_lines
  WHERE scenario_id = '${SCENARIO_ID}'`;

describe("escribir en las tablas sensibles exige el permiso de escritura, no solo tenant (WP-B11, docs/security-spec.md §3.1, ADR-016)", () => {
  let db: TestDb;
  let api: Client;
  let owner: Actor;
  let seller: Actor;
  let warehouse: Actor;
  let manager: Actor;
  let peerOwner: Actor;
  const custom = {} as Record<keyof typeof CUSTOM_ROLES, Actor>;
  // Todos los actores por nombre, para las pruebas parametrizadas (it.each) que
  // se escriben antes de que el beforeAll los cree. Lo llena el beforeAll.
  const actorsByKey = {} as Record<string, Actor>;

  // Mismo contexto que withTenantTx: tercer parámetro de set_config en true.
  async function actAs(actor: Actor, tenantId: string): Promise<void> {
    await api.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.tenant_id', $2, true),
              set_config('app.audience', 'staff', true),
              set_config('app.session_id', $3, true)`,
      [actor.userId, tenantId, actor.sessionId],
    );
  }

  // Abre la transacción, fija el contexto del rol y ejecuta. El ROLLBACK lo
  // hace el afterEach, también cuando la consulta falla.
  async function as(actor: Actor, sql: string, tenantId = REAL_TENANT_ID) {
    await api.query("BEGIN");
    await actAs(actor, tenantId);
    return api.query(sql);
  }

  // Filas que el mismo actor ve después de su escritura, en la misma
  // transacción: prueba que un DELETE denegado no borró nada.
  async function visibleCount(table: string, id: string): Promise<number> {
    const { rows } = await api.query(`SELECT count(*)::int AS n FROM app.${table} WHERE id = $1`, [
      id,
    ]);
    return rows[0].n;
  }

  // Lo que quedó, mirado como el owner dentro de la MISMA transacción del actor
  // denegado (que puede no ver la fila): una consulta por otra conexión no ve
  // lo que esta transacción no confirmó, y la prueba pasaría en falso.
  async function countAsOwnerHere(sql: string): Promise<number> {
    await actAs(owner, REAL_TENANT_ID);
    const { rows } = await api.query(sql);
    return rows[0].n;
  }

  async function createActor(id: string, tenantId: string, roleId: string): Promise<Actor> {
    const actor = {
      userId: `b1100000-0000-0000-0000-00000000a${id}`,
      sessionId: `b1150000-0000-0000-0000-00000000a${id}`,
    };
    await db.client.query(
      `INSERT INTO app.staff_users (id, tenant_id, auth_subject, email, full_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [actor.userId, tenantId, `sub-b11-${id}`, `b11-${id}@joda.test`, `Actor ${id}`],
    );
    await db.client.query(
      `INSERT INTO app.staff_user_roles (staff_user_id, role_id, tenant_id) VALUES ($1, $2, $3)`,
      [actor.userId, roleId, tenantId],
    );
    await db.client.query(
      `INSERT INTO app.staff_sessions (id, tenant_id, staff_user_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '8 hours')`,
      [actor.sessionId, tenantId, actor.userId],
    );
    return actor;
  }

  async function seedRoleActor(id: string, tenantId: string, code: string): Promise<Actor> {
    const { rows } = await db.client.query(
      "SELECT id FROM app.roles WHERE tenant_id = $1 AND code = $2",
      [tenantId, code],
    );
    return createActor(id, tenantId, rows[0].id);
  }

  beforeAll(async () => {
    db = await startTestDb();
    await runSmokeBusinessFlow(db.client);

    // Tenant vecino con su owner (todos los permisos): el atacante legítimo
    // de otro tenant, con el permiso de la tabla.
    await db.client.query(`
      INSERT INTO app.tenants (id, slug, legal_name, trade_name)
      VALUES ('${PEER_TENANT_ID}', 'tenant-vecino-b11', 'Vecino B11 SA', 'Vecino B11');
      SELECT app.seed_roles('${PEER_TENANT_ID}');
    `);
    peerOwner = await seedRoleActor("000", PEER_TENANT_ID, "owner");

    // El owner del smoke no tiene sesión viva: has_permission() la exige.
    owner = {
      userId: REAL_OWNER_ID,
      sessionId: "b1150000-0000-0000-0000-0000000000a1",
    };
    await db.client.query(
      `INSERT INTO app.staff_sessions (id, tenant_id, staff_user_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '8 hours')`,
      [owner.sessionId, REAL_TENANT_ID, REAL_OWNER_ID],
    );
    seller = await seedRoleActor("001", REAL_TENANT_ID, "vendedor");
    warehouse = await seedRoleActor("002", REAL_TENANT_ID, "deposito");
    manager = await seedRoleActor("003", REAL_TENANT_ID, "manager");

    for (const [name, role] of Object.entries(CUSTOM_ROLES)) {
      const roleId = `b1100000-0000-0000-0000-0000000000${String(role.n).padStart(2, "0")}`;
      await db.client.query(
        `INSERT INTO app.roles (id, tenant_id, code, name) VALUES ($1, $2, $3, $3)`,
        [roleId, REAL_TENANT_ID, `b11-${name}`],
      );
      await db.client.query(
        `INSERT INTO app.role_permissions (tenant_id, role_id, permission_code)
         SELECT $2, $1, unnest($3::text[])`,
        [roleId, REAL_TENANT_ID, role.permissions],
      );
      custom[name as keyof typeof CUSTOM_ROLES] = await createActor(
        `1${String(role.n).padStart(2, "0")}`,
        REAL_TENANT_ID,
        roleId,
      );
    }

    // Una fila por tabla para los UPDATE y DELETE. Las órdenes, una por
    // estado que importa a la guarda de 0031: las posteriores a la aprobación
    // exigen constancia de quién aprobó.
    await db.client.query(`
      INSERT INTO app.purchase_orders (id, tenant_id, supplier_id, code, status, currency, created_by,
                                       approved_by, approved_at)
      VALUES ('${DRAFT_PO_ID}', '${REAL_TENANT_ID}', '${SUPPLIER_ID}', 'OC-B11-BORRADOR', 'draft',
              'USD', '${REAL_OWNER_ID}', NULL, NULL),
             ('${PENDING_PO_ID}', '${REAL_TENANT_ID}', '${SUPPLIER_ID}', 'OC-B11-PENDIENTE',
              'pending_approval', 'USD', '${REAL_OWNER_ID}', NULL, NULL),
             ('${APPROVED_PO_ID}', '${REAL_TENANT_ID}', '${SUPPLIER_ID}', 'OC-B11-APROBADA', 'approved',
              'USD', '${REAL_OWNER_ID}', '${REAL_OWNER_ID}', now()),
             ('${PARTIAL_PO_ID}', '${REAL_TENANT_ID}', '${SUPPLIER_ID}', 'OC-B11-PARCIAL',
              'partially_received', 'USD', '${REAL_OWNER_ID}', '${REAL_OWNER_ID}', now()),
             ('${SENT_PO_ID}', '${REAL_TENANT_ID}', '${SUPPLIER_ID}', 'OC-B11-ENVIADA', 'sent',
              'USD', '${REAL_OWNER_ID}', '${REAL_OWNER_ID}', now()),
             ('${RECEIVED_PO_ID}', '${REAL_TENANT_ID}', '${SUPPLIER_ID}', 'OC-B11-RECIBIDA', 'received',
              'USD', '${REAL_OWNER_ID}', '${REAL_OWNER_ID}', now()),
             ('${CANCELLED_PO_ID}', '${REAL_TENANT_ID}', '${SUPPLIER_ID}', 'OC-B11-CANCELADA',
              'cancelled', 'USD', '${REAL_OWNER_ID}', NULL, NULL);
      INSERT INTO app.inventory_lots
        (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
         fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
      VALUES ('${LOT_ID}', '${REAL_TENANT_ID}', '${SEALED_VARIANT_ID}', 1, 'unit', 0, 'PYG', 1, 0, 0);
      INSERT INTO app.customer_deposits (id, tenant_id, customer_id, amount_pyg)
      VALUES ('${DEPOSIT_ID}', '${REAL_TENANT_ID}', '${CUSTOMER_ID}', 100000);
      INSERT INTO app.sourcing_scenarios (id, tenant_id, name, created_by)
      VALUES ('${SCENARIO_ID}', '${REAL_TENANT_ID}', 'Escenario B11b', '${REAL_OWNER_ID}');
      INSERT INTO app.sourcing_scenario_lines
        (id, tenant_id, scenario_id, variant_id, qty, unit_price_minor, currency, fx_assumed)
      VALUES ('${SCENARIO_LINE_ID}', '${REAL_TENANT_ID}', '${SCENARIO_ID}', '${SEALED_VARIANT_ID}',
              3, 12000, 'USD', 7400);
    `);

    // WP-B11c: el rol personalizado que editan las pruebas de roles, con un
    // permiso y asignado al usuario de `stockReader`.
    await db.client.query(`
      INSERT INTO app.roles (id, tenant_id, code, name)
      VALUES ('${TARGET_ROLE_ID}', '${REAL_TENANT_ID}', 'b11c-objetivo', 'Rol objetivo B11c');
      INSERT INTO app.role_permissions (tenant_id, role_id, permission_code)
      VALUES ('${REAL_TENANT_ID}', '${TARGET_ROLE_ID}', 'catalog.product:read');
      INSERT INTO app.staff_user_roles (staff_user_id, role_id, tenant_id)
      VALUES ('${custom.stockReader.userId}', '${TARGET_ROLE_ID}', '${REAL_TENANT_ID}');
    `);

    // WP-B11d: saldo para los movimientos de salida sobre `LOT_ID`; las líneas
    // de orden y la recepción; y un pedido por estado, con la seña de uno
    // cobrado enganchada (el borrado de una venta la desengancha).
    await db.client.query(`
      INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
      VALUES ('${REAL_TENANT_ID}', '${LOT_ID}', '${SEALED_VARIANT_ID}', 100, 'unit', 'adjustment');
      INSERT INTO app.purchase_order_lines
        (id, tenant_id, purchase_order_id, variant_id, qty_ordered, uom, unit_price_minor)
      VALUES ('${PO_LINE_ID}', '${REAL_TENANT_ID}', '${DRAFT_PO_ID}', '${SEALED_VARIANT_ID}', 2,
              'unit', 5000),
             ('${RECEIPT_PO_LINE_ID}', '${REAL_TENANT_ID}', '${APPROVED_PO_ID}',
              '${SEALED_VARIANT_ID}', 2, 'unit', 5000);
      INSERT INTO app.goods_receipts
        (id, tenant_id, purchase_order_id, code, fx_rate_to_pyg, received_by)
      VALUES ('${RECEIPT_ID}', '${REAL_TENANT_ID}', '${APPROVED_PO_ID}', 'REC-B11D', 7400,
              '${REAL_OWNER_ID}');
      INSERT INTO app.goods_receipt_lines
        (id, tenant_id, goods_receipt_id, purchase_order_line_id, variant_id, qty_received, uom,
         unit_price_minor)
      VALUES ('${RECEIPT_LINE_ID}', '${REAL_TENANT_ID}', '${RECEIPT_ID}', '${RECEIPT_PO_LINE_ID}',
              '${SEALED_VARIANT_ID}', 1, 'unit', 5000);
    `);
    for (const [status, id] of Object.entries(SALE_ORDER_IDS)) {
      await db.client.query(
        `INSERT INTO app.sale_orders (id, tenant_id, channel_id, code, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, REAL_TENANT_ID, SALES_CHANNEL_ID, `VTA-B11D-${status}`, status],
      );
    }
    await db.client.query(`UPDATE app.customer_deposits SET sale_order_id = $1 WHERE id = $2`, [
      SALE_ORDER_IDS.paid,
      DEPOSIT_ID,
    ]);

    Object.assign(actorsByKey, { owner, seller, warehouse, manager, peerOwner, ...custom });

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

  // Un test que falla a mitad de camino no deja la transacción abortada para
  // los siguientes (mismo motivo que en rls_isolation.test.ts).
  afterEach(async () => {
    await api.query("ROLLBACK");
  });

  afterAll(async () => {
    await api.end();
    await db.stop();
  });

  describe("suppliers: market.supplier:write", () => {
    it("el owner crea un proveedor, con el RETURNING que emite Prisma, y lo edita", async () => {
      const created = await as(owner, `${INSERT_SUPPLIER} RETURNING id`);
      const edited = await api.query(UPDATE_SUPPLIER);

      expect({ created: created.rowCount, edited: edited.rowCount }).toEqual({
        created: 1,
        edited: 1,
      });
    });

    it("el vendedor no puede crear un proveedor, aunque el INSERT no pida RETURNING", async () => {
      await expect(as(seller, INSERT_SUPPLIER)).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("el vendedor no edita proveedores: un UPDATE sin WHERE afecta cero filas", async () => {
      const { rowCount } = await as(seller, UPDATE_ALL_SUPPLIERS);

      expect(rowCount).toBe(0);
    });

    it("un rol que solo lee proveedores no puede crear uno", async () => {
      await expect(as(custom.readOnly, `${INSERT_SUPPLIER} RETURNING id`)).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("un rol que solo lee proveedores los ve pero su UPDATE afecta cero filas", async () => {
      const { rowCount } = await as(custom.readOnly, UPDATE_SUPPLIER);

      expect(rowCount).toBe(0);
    });

    // La trampa de la lectura: el permiso de escribir alcanza para que la
    // política de INSERT acepte la fila, pero el RETURNING de Prisma también
    // necesita la política de lectura.
    it("quien escribe proveedores sin leerlos: el INSERT pasa, el INSERT ... RETURNING se rechaza", async () => {
      const plain = await as(custom.supplierWriterNoRead, INSERT_SUPPLIER);
      await api.query("ROLLBACK");

      expect(plain.rowCount).toBe(1);
      await expect(
        as(custom.supplierWriterNoRead, `${INSERT_SUPPLIER} RETURNING id`),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("quien escribe proveedores sin leerlos no edita ninguno: su UPDATE afecta cero filas", async () => {
      const { rowCount } = await as(custom.supplierWriterNoRead, UPDATE_SUPPLIER);

      expect(rowCount).toBe(0);
    });

    it("nadie borra un proveedor, ni el owner: se desactiva (is_active)", async () => {
      const { rowCount } = await as(owner, DELETE_SUPPLIER);
      const remaining = await visibleCount("suppliers", SUPPLIER_ID);

      expect({ deleted: rowCount, remaining }).toEqual({ deleted: 0, remaining: 1 });
    });
  });

  describe("purchase_orders: market.purchase_order:write, :approve o :receive para el UPDATE", () => {
    it("el owner crea una orden, con RETURNING, y la edita", async () => {
      const created = await as(owner, `${INSERT_PO} RETURNING id`);
      const edited = await api.query(UPDATE_PO);

      expect({ created: created.rowCount, edited: edited.rowCount }).toEqual({
        created: 1,
        edited: 1,
      });
    });

    // Capa 1: el UPDATE es la unión de los tres permisos sobre la fila
    // entera. Qué transición le toca a cada uno, lo impone la capa 2.
    it("quien aprueba, sin :write, edita la orden (UPDATE con WHERE y lectura)", async () => {
      const { rowCount } = await as(custom.approver, UPDATE_PO);

      expect(rowCount).toBe(1);
    });

    it("quien aprueba, sin :write, no puede crear una orden", async () => {
      await expect(as(custom.approver, `${INSERT_PO} RETURNING id`)).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("el vendedor no puede crear una orden ni editar ninguna (INSERT sin RETURNING, UPDATE sin WHERE)", async () => {
      const edit = await as(seller, UPDATE_ALL_POS);
      await api.query("ROLLBACK");

      expect(edit.rowCount).toBe(0);
      await expect(as(seller, INSERT_PO)).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("un rol que solo lee órdenes las ve pero no las edita: su UPDATE afecta cero filas", async () => {
      const { rowCount } = await as(custom.readOnly, UPDATE_PO);

      expect(rowCount).toBe(0);
    });

    // Caso registrado para WP-C15: el depósito tiene :receive y no :read.
    // Su permiso alcanza para la política de UPDATE, pero no ve la orden, así
    // que no la puede modificar. El depósito carga la recepción en borrador
    // (goods_receipts) y la contabiliza quien lee la orden.
    it("el depósito, con :receive y sin :read, no ve la orden que recibe: su UPDATE ... WHERE afecta cero filas", async () => {
      const { rowCount } = await as(warehouse, UPDATE_PO);

      expect(rowCount).toBe(0);
    });

    // El otro lado de lo mismo, fijado a propósito: un UPDATE que no lee
    // columnas no necesita la lectura, y `:receive` habilita el UPDATE de la
    // FILA ENTERA. La capa 1 no sabe qué campo toca; que el depósito solo
    // registre recepciones lo imponen la capa 2 y el dominio.
    it("el depósito, con :receive, sí edita órdenes con un UPDATE sin WHERE: la capa 1 no ve qué campo toca", async () => {
      const { rowCount } = await as(warehouse, UPDATE_ALL_POS);

      expect(rowCount).toBeGreaterThan(0);
    });

    // Sin esta, quitar `:receive` de la política de UPDATE no lo detecta
    // ninguna prueba: la del depósito da cero filas con o sin ese permiso.
    it("quien recibe y lee órdenes, sin :write ni :approve, edita la orden (UPDATE con WHERE)", async () => {
      const { rowCount } = await as(custom.orderReceiver, UPDATE_PO);

      expect(rowCount).toBe(1);
    });

    it("quien recibe y lee órdenes, sin :write, no puede crear una orden", async () => {
      await expect(as(custom.orderReceiver, INSERT_PO)).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("el owner borra una orden en borrador", async () => {
      const { rowCount } = await as(owner, DELETE_DRAFT_PO);

      expect(rowCount).toBe(1);
    });

    it("el owner, con :write, no borra una orden enviada: la política exige el borrador", async () => {
      const { rowCount } = await as(owner, DELETE_SENT_PO);
      const remaining = await visibleCount("purchase_orders", SENT_PO_ID);

      expect({ deleted: rowCount, remaining }).toEqual({ deleted: 0, remaining: 1 });
    });

    it("quien aprueba, sin :write, no borra ni una orden en borrador", async () => {
      const { rowCount } = await as(custom.approver, DELETE_DRAFT_PO);

      expect(rowCount).toBe(0);
    });
  });

  // ADR-026: la política de DELETE lee `status = 'draft'` como "nunca
  // enviada", y `trg_po_no_return_to_draft` (0031) la sostiene: se entra a
  // borrador solo desde `draft` o `pending_approval`. Sin él, estas pruebas
  // eran el rodeo de dos pasos que encontró la revisión de B11.
  describe("una orden no vuelve a borrador desde approved en adelante (WP-B11, ADR-026)", () => {
    it.each([
      ["approved", APPROVED_PO_ID],
      ["sent", SENT_PO_ID],
      ["partially_received", PARTIAL_PO_ID],
      ["received", RECEIVED_PO_ID],
      ["cancelled", CANCELLED_PO_ID],
    ])("el owner, con :write y :read, no devuelve una orden %s a borrador", async (_status, id) => {
      await expect(as(owner, RETURN_TO_DRAFT(id))).rejects.toMatchObject({
        code: "23514",
        message: expect.stringContaining("no puede volver a"),
      });
    });

    it.each([
      ["approved", APPROVED_PO_ID],
      ["sent", SENT_PO_ID],
      ["partially_received", PARTIAL_PO_ID],
      ["received", RECEIVED_PO_ID],
      ["cancelled", CANCELLED_PO_ID],
    ])(
      "el owner no devuelve una orden %s a pending_approval: sería el primer paso de un rodeo de tres",
      async (_status, id) => {
        await expect(as(owner, RETURN_TO_PENDING(id))).rejects.toMatchObject({
          code: "23514",
          message: expect.stringContaining("no puede volver a"),
        });
      },
    );

    it("una orden en borrador sigue pasando a pending_approval (el camino hacia adelante)", async () => {
      const { rowCount } = await as(owner, RETURN_TO_PENDING(DRAFT_PO_ID));

      expect(rowCount).toBe(1);
    });

    it("el rodeo de dos pasos falla en el primero: la orden enviada sigue ahí después del DELETE", async () => {
      await expect(as(owner, RETURN_TO_DRAFT(SENT_PO_ID))).rejects.toMatchObject({
        code: "23514",
      });
      await api.query("ROLLBACK");
      const { rowCount } = await as(owner, DELETE_SENT_PO);
      const remaining = await visibleCount("purchase_orders", SENT_PO_ID);

      expect({ deleted: rowCount, remaining }).toEqual({ deleted: 0, remaining: 1 });
    });

    // La variante del depósito de la revisión: `:receive`, sin `:read`, con un
    // UPDATE sin WHERE que toca todas las órdenes del tenant. La política lo
    // deja pasar fila por fila; el trigger lo frena en la primera que no es
    // un borrador.
    it("el depósito, con un UPDATE sin WHERE, no devuelve a borrador las órdenes del tenant", async () => {
      await expect(as(warehouse, RETURN_ALL_TO_DRAFT)).rejects.toMatchObject({
        code: "23514",
      });
    });

    it("una orden en pending_approval vuelve a borrador (la arista que permite la máquina de A08)", async () => {
      const { rowCount } = await as(owner, RETURN_TO_DRAFT(PENDING_PO_ID));

      expect(rowCount).toBe(1);
    });

    it("la orden devuelta a corregir, ya en borrador, se borra", async () => {
      await as(owner, RETURN_TO_DRAFT(PENDING_PO_ID));
      const { rowCount } = await api.query(DELETE_PENDING_PO);

      expect(rowCount).toBe(1);
    });

    it("un borrador se edita y sigue siendo borrador", async () => {
      const { rowCount } = await as(owner, RETURN_TO_DRAFT(DRAFT_PO_ID));

      expect(rowCount).toBe(1);
    });
  });

  describe("inventory_lots: recepción, apertura, devolución o ajuste (mapeo aprobado el 2026-09-25)", () => {
    it.each([
      ["market.purchase_order:receive (recepción de compra)", "receives"],
      ["inventory.decant:execute (apertura de frasco, decant por anticipado)", "decants"],
      ["sales.order:refund (devolución a cuarentena)", "refunds"],
      ["inventory.stock:adjust (ajuste y saldo de apertura)", "adjusts"],
    ] as const)("con %s, y la lectura de lotes, crea un lote y lo edita", async (_label, role) => {
      const created = await as(custom[role], `${INSERT_LOT} RETURNING id`);
      const edited = await api.query(UPDATE_LOT);

      expect({ created: created.rowCount, edited: edited.rowCount }).toEqual({
        created: 1,
        edited: 1,
      });
    });

    it("el depósito del seed crea un lote con el RETURNING de Prisma y lo edita", async () => {
      const created = await as(warehouse, `${INSERT_LOT} RETURNING id`);
      const edited = await api.query(UPDATE_LOT);

      expect({ created: created.rowCount, edited: edited.rowCount }).toEqual({
        created: 1,
        edited: 1,
      });
    });

    it("el vendedor no puede dar de alta un lote con el costo que quiera, aunque el INSERT no pida RETURNING", async () => {
      await expect(as(seller, INSERT_LOT)).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("el vendedor no edita lotes: un UPDATE sin WHERE afecta cero filas", async () => {
      const { rowCount } = await as(seller, UPDATE_ALL_LOTS);

      expect(rowCount).toBe(0);
    });

    it("quien solo lee lotes no puede crear uno", async () => {
      await expect(as(custom.stockReader, `${INSERT_LOT} RETURNING id`)).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("quien solo lee lotes los ve pero su UPDATE afecta cero filas", async () => {
      const { rowCount } = await as(custom.stockReader, UPDATE_LOT);

      expect(rowCount).toBe(0);
    });

    // El caso que dejó anotado C11: un rol con el permiso de escribir y sin
    // inventory.stock:read recibe 404 en la API. Acá, la base.
    it("quien recibe sin poder leer lotes: el INSERT pasa y el lote nace con su saldo en cero", async () => {
      const inserted = await as(custom.receiverNoRead, INSERT_LOT);
      const { rows } = await api.query(
        `SELECT on_hand FROM app.inventory_balances WHERE lot_id = '${NEW_LOT_ID}'`,
      );

      expect({ inserted: inserted.rowCount, balances: rows }).toEqual({
        inserted: 1,
        balances: [{ on_hand: "0.000" }],
      });
    });

    it("quien recibe sin poder leer lotes: el INSERT ... RETURNING se rechaza", async () => {
      await expect(as(custom.receiverNoRead, `${INSERT_LOT} RETURNING id`)).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("quien recibe sin poder leer lotes no edita ninguno: su UPDATE afecta cero filas", async () => {
      const { rowCount } = await as(custom.receiverNoRead, UPDATE_LOT);

      expect(rowCount).toBe(0);
    });

    it("nadie borra un lote, ni el owner: es historial de costo y se corrige con un ajuste", async () => {
      const { rowCount } = await as(owner, DELETE_LOT);
      const remaining = await visibleCount("inventory_lots", LOT_ID);

      expect({ deleted: rowCount, remaining }).toEqual({ deleted: 0, remaining: 1 });
    });
  });

  describe("chart_of_accounts: accounting.journal:write", () => {
    it("el owner crea una cuenta, con RETURNING, y la edita", async () => {
      const created = await as(owner, `${INSERT_ACCOUNT} RETURNING id`);
      const edited = await api.query(UPDATE_ACCOUNT);

      expect({ created: created.rowCount, edited: edited.rowCount }).toEqual({
        created: 1,
        edited: 1,
      });
    });

    it("quien escribe y lee la contabilidad crea una cuenta y la edita", async () => {
      const created = await as(custom.accountant, `${INSERT_ACCOUNT} RETURNING id`);
      const edited = await api.query(UPDATE_ACCOUNT);

      expect({ created: created.rowCount, edited: edited.rowCount }).toEqual({
        created: 1,
        edited: 1,
      });
    });

    it("el vendedor no puede crear una cuenta, aunque el INSERT no pida RETURNING", async () => {
      await expect(as(seller, INSERT_ACCOUNT)).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("el depósito no puede crear una cuenta, aunque el INSERT no pida RETURNING", async () => {
      await expect(as(warehouse, INSERT_ACCOUNT)).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("un rol que solo lee la contabilidad no crea cuentas y su UPDATE afecta cero filas", async () => {
      const edited = await as(custom.readOnly, UPDATE_ACCOUNT);
      await api.query("ROLLBACK");

      expect(edited.rowCount).toBe(0);
      await expect(as(custom.readOnly, `${INSERT_ACCOUNT} RETURNING id`)).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("quien escribe la contabilidad sin leerla: el INSERT ... RETURNING se rechaza", async () => {
      await expect(
        as(custom.accountantNoRead, `${INSERT_ACCOUNT} RETURNING id`),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("nadie borra una cuenta, ni el owner: se desactiva (is_active)", async () => {
      const { rowCount } = await as(owner, DELETE_ACCOUNT);
      const { rows } = await api.query(
        "SELECT count(*)::int AS n FROM app.chart_of_accounts WHERE code = '1.1.01.001'",
      );

      expect({ deleted: rowCount, remaining: rows[0].n }).toEqual({ deleted: 0, remaining: 1 });
    });
  });

  describe("customer_deposits: accounting.deposit:write, y :read para verla", () => {
    // La operación real del vendedor: registra una seña y la aplica al
    // vender. Antes de B11 no podía ni registrarla, porque tenía :write sin
    // :read y el RETURNING de Prisma se rechazaba.
    it("el vendedor registra una seña, con el RETURNING de Prisma, y la aplica", async () => {
      const created = await as(seller, `${INSERT_DEPOSIT} RETURNING id`);
      const applied = await api.query(UPDATE_DEPOSIT);

      expect({ created: created.rowCount, applied: applied.rowCount }).toEqual({
        created: 1,
        applied: 1,
      });
    });

    it("el owner registra una seña y la aplica", async () => {
      const created = await as(owner, `${INSERT_DEPOSIT} RETURNING id`);
      const applied = await api.query(UPDATE_DEPOSIT);

      expect({ created: created.rowCount, applied: applied.rowCount }).toEqual({
        created: 1,
        applied: 1,
      });
    });

    it("el depósito no puede registrar una seña, aunque el INSERT no pida RETURNING", async () => {
      await expect(as(warehouse, INSERT_DEPOSIT)).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("el depósito no aplica señas: un UPDATE sin WHERE afecta cero filas", async () => {
      const { rowCount } = await as(warehouse, UPDATE_ALL_DEPOSITS);

      expect(rowCount).toBe(0);
    });

    it("un rol que solo lee señas no puede registrar una", async () => {
      await expect(as(custom.readOnly, `${INSERT_DEPOSIT} RETURNING id`)).rejects.toMatchObject({
        code: "42501",
      });
    });

    // Sin esta, cambiar `:write` por `:read` en la política de UPDATE no lo
    // detecta ninguna prueba: la lectura le alcanzaría para editar señas.
    it("un rol que solo lee señas las ve pero su UPDATE afecta cero filas", async () => {
      const { rowCount } = await as(custom.readOnly, UPDATE_DEPOSIT);

      expect(rowCount).toBe(0);
    });

    it("nadie borra una seña, ni el owner: se devuelve o se aplica", async () => {
      const { rowCount } = await as(owner, DELETE_DEPOSIT);
      const remaining = await visibleCount("customer_deposits", DEPOSIT_ID);

      expect({ deleted: rowCount, remaining }).toEqual({ deleted: 0, remaining: 1 });
    });

    it("el vendedor, que la ve, tampoco borra una seña", async () => {
      const { rowCount } = await as(seller, DELETE_DEPOSIT);
      const remaining = await visibleCount("customer_deposits", DEPOSIT_ID);

      expect({ deleted: rowCount, remaining }).toEqual({ deleted: 0, remaining: 1 });
    });

    // Caja sigue oculta: el vendedor gana la lectura de señas, no la de caja.
    it("el vendedor del seed tiene exactamente estos permisos, sin accounting.cashbox:read", async () => {
      const { rows } = await db.client.query(
        `SELECT rp.permission_code
           FROM app.role_permissions rp JOIN app.roles r ON r.id = rp.role_id
          WHERE r.tenant_id = $1 AND r.code = 'vendedor'
          ORDER BY rp.permission_code`,
        [REAL_TENANT_ID],
      );

      expect(rows.map((row) => row.permission_code)).toEqual([
        "accounting.deposit:read",
        "accounting.deposit:write",
        "catalog.product:read",
        "fiscal.document:issue",
        "sales.order:read",
        "sales.order:write",
      ]);
    });
  });

  // WP-B11b. A diferencia de las cinco tablas de arriba, un escenario SÍ se
  // borra: es una simulación, y borrarlo exige el mismo permiso que escribirlo.
  describe("sourcing_scenarios: market.sourcing:write para crear, editar y borrar (WP-B11b)", () => {
    // El actor denegado puede no ver la fila (no tiene :read): para saber si
    // sigue ahí se mira como el owner, dentro de la misma transacción.
    async function scenariosLeftAsOwner(): Promise<number> {
      await actAs(owner, REAL_TENANT_ID);
      return visibleCount("sourcing_scenarios", SCENARIO_ID);
    }

    it("el owner crea un escenario, con el RETURNING que emite Prisma, lo edita y lo borra", async () => {
      const created = await as(owner, `${INSERT_SCENARIO} RETURNING id`);
      const edited = await api.query(UPDATE_SCENARIO);
      const deleted = await api.query(DELETE_SCENARIO);

      expect({
        created: created.rowCount,
        edited: edited.rowCount,
        deleted: deleted.rowCount,
      }).toEqual({ created: 1, edited: 1, deleted: 1 });
    });

    it("el encargado del seed, que lee y escribe sourcing, edita y borra un escenario", async () => {
      const edited = await as(manager, UPDATE_SCENARIO);
      const deleted = await api.query(DELETE_SCENARIO);

      expect({ edited: edited.rowCount, deleted: deleted.rowCount }).toEqual({
        edited: 1,
        deleted: 1,
      });
    });

    it("quien lee y escribe sourcing (rol personalizado) crea, edita y borra", async () => {
      const created = await as(custom.sourcingEditor, `${INSERT_SCENARIO} RETURNING id`);
      const edited = await api.query(UPDATE_SCENARIO);
      const deleted = await api.query(DELETE_SCENARIO);

      expect({
        created: created.rowCount,
        edited: edited.rowCount,
        deleted: deleted.rowCount,
      }).toEqual({ created: 1, edited: 1, deleted: 1 });
    });

    it("el vendedor no puede crear un escenario, aunque el INSERT no pida RETURNING", async () => {
      await expect(as(seller, INSERT_SCENARIO)).rejects.toMatchObject({ code: "42501" });
    });

    it("el vendedor no edita escenarios: un UPDATE sin WHERE afecta cero filas", async () => {
      const { rowCount } = await as(seller, UPDATE_ALL_SCENARIOS);

      expect(rowCount).toBe(0);
    });

    it("el vendedor no borra escenarios: un DELETE sin WHERE afecta cero filas y el escenario sigue", async () => {
      const { rowCount } = await as(seller, DELETE_ALL_SCENARIOS);
      const remaining = await scenariosLeftAsOwner();

      expect({ deleted: rowCount, remaining }).toEqual({ deleted: 0, remaining: 1 });
    });

    it("el depósito no edita ni borra escenarios (sin WHERE: no necesita la lectura)", async () => {
      const edited = await as(warehouse, UPDATE_ALL_SCENARIOS);
      const deleted = await api.query(DELETE_ALL_SCENARIOS);
      const remaining = await scenariosLeftAsOwner();

      expect({ edited: edited.rowCount, deleted: deleted.rowCount, remaining }).toEqual({
        edited: 0,
        deleted: 0,
        remaining: 1,
      });
    });

    it("un rol que solo lee sourcing no puede crear un escenario", async () => {
      await expect(as(custom.readOnly, `${INSERT_SCENARIO} RETURNING id`)).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("un rol que solo lee sourcing ve el escenario, pero no lo edita ni lo borra", async () => {
      const edited = await as(custom.readOnly, UPDATE_SCENARIO);
      const deleted = await api.query(DELETE_SCENARIO);
      const remaining = await visibleCount("sourcing_scenarios", SCENARIO_ID);

      expect({ edited: edited.rowCount, deleted: deleted.rowCount, remaining }).toEqual({
        edited: 0,
        deleted: 0,
        remaining: 1,
      });
    });

    // La trampa de la lectura, como en proveedores: el permiso de escribir
    // alcanza para que la política de INSERT acepte la fila, pero el RETURNING
    // de Prisma también necesita la política de lectura.
    it("quien escribe sourcing sin leerlo: el INSERT pasa, el INSERT ... RETURNING se rechaza", async () => {
      const plain = await as(custom.sourcingWriterNoRead, INSERT_SCENARIO);
      await api.query("ROLLBACK");

      expect(plain.rowCount).toBe(1);
      await expect(
        as(custom.sourcingWriterNoRead, `${INSERT_SCENARIO} RETURNING id`),
      ).rejects.toMatchObject({ code: "42501" });
    });

    // Fijado a propósito: la capa 1 acepta lo que no lee. Un UPDATE o un
    // DELETE sin WHERE no necesitan la política de lectura y solo piden el
    // permiso de escritura; con WHERE ese rol ya no ve la fila.
    it("quien escribe sourcing sin leerlo: UPDATE ... WHERE afecta cero filas, y sin WHERE sí edita", async () => {
      const withWhere = await as(custom.sourcingWriterNoRead, UPDATE_SCENARIO);
      const withoutWhere = await api.query(UPDATE_ALL_SCENARIOS);

      expect({ withWhere: withWhere.rowCount, withoutWhere: withoutWhere.rowCount }).toEqual({
        withWhere: 0,
        withoutWhere: 1,
      });
    });

    it("quien escribe sourcing sin leerlo: DELETE ... WHERE afecta cero filas, y sin WHERE sí borra", async () => {
      const withWhere = await as(custom.sourcingWriterNoRead, DELETE_SCENARIO);
      const withoutWhere = await api.query(DELETE_ALL_SCENARIOS);
      const remaining = await scenariosLeftAsOwner();

      expect({
        withWhere: withWhere.rowCount,
        withoutWhere: withoutWhere.rowCount,
        remaining,
      }).toEqual({ withWhere: 0, withoutWhere: 1, remaining: 0 });
    });
  });

  // WP-B11d. El SELECT de todas estas tablas es por tenant: ni `INSERT ...
  // RETURNING` ni `UPDATE ... WHERE` dependen de otro permiso, así que no hay
  // trampa de la lectura y los rechazos se prueban con la forma natural de
  // cada operación.
  describe("el ledger, las líneas de órdenes, las recepciones y el borrado de pedidos exigen permiso (WP-B11d)", () => {
    // Un actor del beforeAll por nombre (las tablas de abajo se escriben antes
    // de que exista).
    function actorFor(key: string): Actor {
      const actor = actorsByKey[key];
      if (!actor) throw new Error(`no hay un actor "${key}" en el beforeAll`);
      return actor;
    }

    // La operación de cada tipo de movimiento: quién la hace (el permiso
    // mínimo del mapeo) y quién no. El denegado es, a propósito, el vecino más
    // plausible: el permiso con el que se la confundiría.
    describe("inventory_movements: el permiso depende del movement_type", () => {
      it.each([
        ["sale", -1, "NULL", "seller"],
        ["adjustment", 5, "NULL", "adjusts"],
        ["decant_consumption", -1, "NULL", "decants"],
        ["decant_yield", 1, "NULL", "decants"],
        ["bom_consumption", -1, "NULL", "decants"],
        ["waste", -1, "NULL", "decants"],
        ["transfer_out", -1, "'lot_separation'", "decants"],
        ["transfer_in", 1, "'lot_opening'", "decants"],
        ["purchase_receipt", 1, "NULL", "receives"],
        ["return_in", 1, "NULL", "refunds"],
        // Devolución a proveedor: es compras y genera un crédito, no ventas.
        ["return_out", -1, "NULL", "poWriter"],
      ])("%s: lo inserta el rol que tiene su permiso", async (type, qty, reference, allowed) => {
        const { rowCount } = await as(actorFor(allowed), INSERT_MOVEMENT(type, qty, reference));

        expect(rowCount).toBe(1);
      });

      it.each([
        ["sale", -1, "NULL", "warehouse"],
        // El defecto: como vendedor, un ajuste de +5 sobre un lote funcionaba.
        ["adjustment", 5, "NULL", "seller"],
        ["decant_consumption", -1, "NULL", "adjusts"],
        ["decant_yield", 1, "NULL", "adjusts"],
        ["bom_consumption", -1, "NULL", "adjusts"],
        ["waste", -1, "NULL", "adjusts"],
        ["transfer_out", -1, "'lot_separation'", "adjusts"],
        ["transfer_in", 1, "'lot_opening'", "adjusts"],
        ["purchase_receipt", 1, "NULL", "decants"],
        ["return_in", 1, "NULL", "poWriter"],
        // El mapeo anterior mandaba `return_out` a `sales.order:refund`.
        ["return_out", -1, "NULL", "refunds"],
      ])(
        "%s: no lo inserta el rol que tiene el permiso de otra operación",
        async (type, qty, reference, denied) => {
          await expect(
            as(actorFor(denied), INSERT_MOVEMENT(type, qty, reference)),
          ).rejects.toMatchObject({ code: "42501" });
        },
      );

      it("el owner, que tiene todos los permisos, inserta una venta, una devolución a proveedor y un transfer", async () => {
        const sale = await as(owner, INSERT_MOVEMENT("sale", -1));
        const returnOut = await api.query(INSERT_MOVEMENT("return_out", -1));
        const transfer = await api.query(INSERT_MOVEMENT("transfer_in", 1, "'lot_opening'"));

        expect({
          sale: sale.rowCount,
          returnOut: returnOut.rowCount,
          transfer: transfer.rowCount,
        }).toEqual({ sale: 1, returnOut: 1, transfer: 1 });
      });

      it("un rol que solo lee no inserta ningún movimiento", async () => {
        await expect(as(custom.readOnly, INSERT_MOVEMENT("adjustment", 1))).rejects.toMatchObject({
          code: "42501",
        });
      });

      it("el owner de otro tenant no inserta un movimiento del tenant real (42501)", async () => {
        await expect(
          as(peerOwner, INSERT_MOVEMENT("adjustment", 1), PEER_TENANT_ID),
        ).rejects.toMatchObject({ code: "42501" });
      });

      // La política de `transfer_*` no puede depender de un texto libre: sin
      // este CHECK, alcanzaría con escribir otro `reference_type`.
      it("un transfer con un reference_type que no es de la apertura ni de la separación se rechaza (CHECK)", async () => {
        await expect(
          as(owner, INSERT_MOVEMENT("transfer_in", 1, "'otro_texto'")),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "movement_transfer_reference_type",
        });
      });

      it("un transfer sin reference_type se rechaza (CHECK): un NULL no pasa", async () => {
        await expect(as(owner, INSERT_MOVEMENT("transfer_out", -1))).rejects.toMatchObject({
          code: "23514",
          constraint: "movement_transfer_reference_type",
        });
      });

      it("un movimiento que no es transfer sigue aceptando un reference_type libre", async () => {
        const { rowCount } = await as(seller, INSERT_MOVEMENT("sale", -1, "'sale_order'"));

        expect(rowCount).toBe(1);
      });
    });

    describe("purchase_order_lines: los permisos de purchase_orders", () => {
      it("el owner agrega una línea, con RETURNING, cambia su precio y la borra", async () => {
        const created = await as(owner, `${INSERT_PO_LINE} RETURNING id`);
        const edited = await api.query(UPDATE_PO_LINE);
        const deleted = await api.query(DELETE_PO_LINE);

        expect({
          created: created.rowCount,
          edited: edited.rowCount,
          deleted: deleted.rowCount,
        }).toEqual({ created: 1, edited: 1, deleted: 1 });
      });

      it("quien escribe compras agrega, edita y borra líneas", async () => {
        const created = await as(custom.poWriter, `${INSERT_PO_LINE} RETURNING id`);
        const edited = await api.query(UPDATE_PO_LINE);
        const deleted = await api.query(DELETE_PO_LINE);

        expect({
          created: created.rowCount,
          edited: edited.rowCount,
          deleted: deleted.rowCount,
        }).toEqual({ created: 1, edited: 1, deleted: 1 });
      });

      // La recepción actualiza `qty_received` en la línea: el UPDATE es la unión
      // de los tres permisos de la orden, igual que en `purchase_orders`.
      it("quien aprueba, sin :write, edita una línea pero no la agrega ni la borra", async () => {
        const edited = await as(custom.approver, UPDATE_PO_LINE);
        const deleted = await api.query(DELETE_PO_LINE);

        expect({ edited: edited.rowCount, deleted: deleted.rowCount }).toEqual({
          edited: 1,
          deleted: 0,
        });
      });

      it("quien aprueba, sin :write, no puede agregar una línea (42501)", async () => {
        await expect(as(custom.approver, INSERT_PO_LINE)).rejects.toMatchObject({ code: "42501" });
      });

      it("el depósito, con :receive, edita una línea (qty_received) pero no la agrega ni la borra", async () => {
        const edited = await as(warehouse, UPDATE_PO_LINE);
        const deleted = await api.query(DELETE_PO_LINE);

        expect({ edited: edited.rowCount, deleted: deleted.rowCount }).toEqual({
          edited: 1,
          deleted: 0,
        });
      });

      it("el depósito no puede agregar una línea (42501)", async () => {
        await expect(as(warehouse, INSERT_PO_LINE)).rejects.toMatchObject({ code: "42501" });
      });

      // El defecto: como vendedor funcionó `UPDATE purchase_order_lines SET
      // unit_price_minor = 1`.
      it("el vendedor no cambia el precio de una línea: el UPDATE afecta cero filas", async () => {
        const { rowCount } = await as(seller, UPDATE_PO_LINE);

        expect(rowCount).toBe(0);
      });

      it("el vendedor no edita líneas: un UPDATE sin WHERE afecta cero filas", async () => {
        const { rowCount } = await as(seller, UPDATE_ALL_PO_LINES);

        expect(rowCount).toBe(0);
      });

      it("el vendedor no agrega una línea (42501) ni la borra (cero filas)", async () => {
        const deleted = await as(seller, DELETE_PO_LINE);
        await api.query("ROLLBACK");

        expect(deleted.rowCount).toBe(0);
        await expect(as(seller, INSERT_PO_LINE)).rejects.toMatchObject({ code: "42501" });
      });

      it("un rol que solo lee no agrega, edita ni borra líneas", async () => {
        const edited = await as(custom.readOnly, UPDATE_PO_LINE);
        const deleted = await api.query(DELETE_PO_LINE);

        expect({ edited: edited.rowCount, deleted: deleted.rowCount }).toEqual({
          edited: 0,
          deleted: 0,
        });
      });

      it("el owner de otro tenant no escribe líneas del tenant real", async () => {
        const edited = await as(peerOwner, UPDATE_PO_LINE, PEER_TENANT_ID);
        const deleted = await api.query(DELETE_PO_LINE);

        expect({ edited: edited.rowCount, deleted: deleted.rowCount }).toEqual({
          edited: 0,
          deleted: 0,
        });
      });

      // Fijado a propósito, NO es una decisión: el SELECT de las líneas sigue
      // por tenant, y muestran el precio de compra a todo el staff. Cerrar la
      // lectura rompe lo que el depósito ve al recibir (WP-C15); anotado en
      // `docs/backlog.md` (WP-B11d).
      it("la lectura de las líneas sigue por tenant: el vendedor las ve (hallazgo anotado)", async () => {
        const { rowCount } = await as(
          seller,
          `SELECT unit_price_minor FROM app.purchase_order_lines`,
        );

        expect(rowCount).toBeGreaterThan(0);
      });
    });

    describe("goods_receipts y goods_receipt_lines: market.purchase_order:receive, sin DELETE", () => {
      it("el depósito carga una recepción, con RETURNING, y la edita", async () => {
        const created = await as(warehouse, `${INSERT_RECEIPT} RETURNING id`);
        const edited = await api.query(UPDATE_RECEIPT);

        expect({ created: created.rowCount, edited: edited.rowCount }).toEqual({
          created: 1,
          edited: 1,
        });
      });

      it("el depósito agrega una línea a la recepción, con RETURNING, y la edita", async () => {
        const created = await as(warehouse, `${INSERT_RECEIPT_LINE} RETURNING id`);
        const edited = await api.query(UPDATE_RECEIPT_LINE);

        expect({ created: created.rowCount, edited: edited.rowCount }).toEqual({
          created: 1,
          edited: 1,
        });
      });

      it("quien aprueba órdenes, sin :receive, no carga una recepción (42501)", async () => {
        await expect(as(custom.approver, INSERT_RECEIPT)).rejects.toMatchObject({ code: "42501" });
      });

      it("el vendedor no carga una recepción (42501) ni una línea (42501)", async () => {
        await expect(as(seller, INSERT_RECEIPT)).rejects.toMatchObject({ code: "42501" });
        await api.query("ROLLBACK");
        await expect(as(seller, INSERT_RECEIPT_LINE)).rejects.toMatchObject({ code: "42501" });
      });

      it("el vendedor no edita recepciones ni líneas: sin WHERE afecta cero filas", async () => {
        const receipts = await as(seller, UPDATE_ALL_RECEIPTS);
        const lines = await api.query(UPDATE_ALL_RECEIPT_LINES);

        expect({ receipts: receipts.rowCount, lines: lines.rowCount }).toEqual({
          receipts: 0,
          lines: 0,
        });
      });

      it("un rol que solo lee no carga ni edita recepciones", async () => {
        await expect(as(custom.readOnly, INSERT_RECEIPT)).rejects.toMatchObject({ code: "42501" });
      });

      // Documentos con costos reales de los que cuelgan lotes y asientos: se
      // cancelan con su estado (`cancelled`), no se borran.
      it("nadie borra una recepción, ni el owner: se cancela con su estado", async () => {
        const deleted = await as(owner, DELETE_RECEIPT);
        const remaining = await countAsOwnerHere(
          `SELECT count(*)::int AS n FROM app.goods_receipts WHERE id = '${RECEIPT_ID}'`,
        );

        expect({ deleted: deleted.rowCount, remaining }).toEqual({ deleted: 0, remaining: 1 });
      });

      it("nadie borra la línea de una recepción, ni el owner", async () => {
        const deleted = await as(owner, DELETE_RECEIPT_LINE);
        const remaining = await countAsOwnerHere(
          `SELECT count(*)::int AS n FROM app.goods_receipt_lines WHERE id = '${RECEIPT_LINE_ID}'`,
        );

        expect({ deleted: deleted.rowCount, remaining }).toEqual({ deleted: 0, remaining: 1 });
      });

      it("el owner de otro tenant no escribe recepciones del tenant real", async () => {
        const edited = await as(peerOwner, UPDATE_RECEIPT, PEER_TENANT_ID);

        expect(edited.rowCount).toBe(0);
      });
    });

    // El borrado de un pedido solo en borrador, y la guarda que sostiene que
    // `draft` signifique "nunca confirmada" (ADR-026, igual que la orden de
    // compra en 0031).
    describe("sale_orders: se borra solo en borrador, con sales.order:write", () => {
      it("el vendedor, con sales.order:write, borra un pedido en borrador", async () => {
        const { rowCount } = await as(seller, DELETE_SALE_ORDER(SALE_ORDER_IDS.draft));

        expect(rowCount).toBe(1);
      });

      it("el owner borra un pedido en borrador", async () => {
        const { rowCount } = await as(owner, DELETE_SALE_ORDER(SALE_ORDER_IDS.draft));

        expect(rowCount).toBe(1);
      });

      it("el depósito, sin sales.order:write, no borra ni un borrador", async () => {
        const { rowCount } = await as(warehouse, DELETE_SALE_ORDER(SALE_ORDER_IDS.draft));
        const remaining = await countAsOwnerHere(COUNT_SALE_ORDER(SALE_ORDER_IDS.draft));

        expect({ deleted: rowCount, remaining }).toEqual({ deleted: 0, remaining: 1 });
      });

      it("un rol que solo lee no borra un pedido en borrador", async () => {
        const { rowCount } = await as(custom.readOnly, DELETE_SALE_ORDER(SALE_ORDER_IDS.draft));

        expect(rowCount).toBe(0);
      });

      it.each([
        "awaiting_payment",
        "paid",
        "preparing",
        "ready",
        "shipped",
        "delivered",
        "cancelled",
        "refunded",
      ] as const)(
        "el vendedor no borra un pedido en %s: afecta cero filas y el pedido sigue",
        async (status) => {
          const { rowCount } = await as(seller, DELETE_SALE_ORDER(SALE_ORDER_IDS[status]));
          const remaining = await countAsOwnerHere(COUNT_SALE_ORDER(SALE_ORDER_IDS[status]));

          expect({ deleted: rowCount, remaining }).toEqual({ deleted: 0, remaining: 1 });
        },
      );

      // El defecto: el FK `ON DELETE SET NULL` desenganchaba la seña de una
      // venta borrada.
      it("la seña de una venta cobrada sigue enganchada: el borrado de la venta no pasa", async () => {
        await as(seller, DELETE_SALE_ORDER(SALE_ORDER_IDS.paid));
        const stillLinked = await countAsOwnerHere(
          `SELECT count(*)::int AS n FROM app.customer_deposits
            WHERE id = '${DEPOSIT_ID}' AND sale_order_id = '${SALE_ORDER_IDS.paid}'`,
        );

        expect(stillLinked).toBe(1);
      });

      it("el owner de otro tenant no borra un pedido del tenant real", async () => {
        const { rowCount } = await as(
          peerOwner,
          DELETE_SALE_ORDER(SALE_ORDER_IDS.draft),
          PEER_TENANT_ID,
        );

        expect(rowCount).toBe(0);
      });

      // Fijado a propósito: INSERT y UPDATE de `sale_orders` siguen solo por
      // tenant. Un pago confirmado por un webhook (audiencia `system`) los
      // escribe, y `has_permission` exige staff: hay que definir primero ese
      // camino (WP-G13). Anotado en `docs/backlog.md` (WP-B11d).
      it("INSERT y UPDATE de pedidos siguen por tenant: el depósito edita un pedido (hallazgo anotado)", async () => {
        const { rowCount } = await as(warehouse, UPDATE_ALL_SALE_ORDERS);

        expect(rowCount).toBeGreaterThan(0);
      });

      describe("no vuelve a borrador: se entra a `draft` solo desde `draft` (0034, ADR-026)", () => {
        it.each([
          "awaiting_payment",
          "paid",
          "preparing",
          "ready",
          "shipped",
          "delivered",
          "cancelled",
          "refunded",
        ] as const)(
          "un pedido en %s no vuelve a draft, con el rol que lo borraría",
          async (status) => {
            await expect(
              as(seller, SET_SALE_STATUS("draft", SALE_ORDER_IDS[status])),
            ).rejects.toMatchObject({
              code: "23514",
              message: expect.stringContaining(`está en ${status} y no puede volver a draft`),
            });
          },
        );

        it("el depósito, con un UPDATE sin WHERE, no devuelve a borrador los pedidos del tenant", async () => {
          await expect(
            as(warehouse, `UPDATE app.sale_orders SET status = 'draft'`),
          ).rejects.toMatchObject({ code: "23514" });
        });

        // El rodeo contra la matriz de A08 (`SALE_ORDER_TRANSITIONS`): ninguna
        // arista lleva a `draft`, así que cada camino válido que sale de él
        // termina en un estado del que no se vuelve. Cada UPDATE de ida pasa.
        it("tras cancelar (draft → awaiting_payment → cancelled) no vuelve a draft", async () => {
          const toAwaiting = await as(
            seller,
            SET_SALE_STATUS("awaiting_payment", SALE_ORDER_IDS.draft),
          );
          const toCancelled = await api.query(SET_SALE_STATUS("cancelled", SALE_ORDER_IDS.draft));

          expect({ toAwaiting: toAwaiting.rowCount, toCancelled: toCancelled.rowCount }).toEqual({
            toAwaiting: 1,
            toCancelled: 1,
          });
          await expect(
            api.query(SET_SALE_STATUS("draft", SALE_ORDER_IDS.draft)),
          ).rejects.toMatchObject({ code: "23514" });
        });

        it("tras cobrar y reembolsar (awaiting_payment → paid → refunded) no vuelve a draft", async () => {
          const toPaid = await as(seller, SET_SALE_STATUS("paid", SALE_ORDER_IDS.awaiting_payment));
          const toRefunded = await api.query(
            SET_SALE_STATUS("refunded", SALE_ORDER_IDS.awaiting_payment),
          );

          expect({ toPaid: toPaid.rowCount, toRefunded: toRefunded.rowCount }).toEqual({
            toPaid: 1,
            toRefunded: 1,
          });
          await expect(
            api.query(SET_SALE_STATUS("draft", SALE_ORDER_IDS.awaiting_payment)),
          ).rejects.toMatchObject({ code: "23514" });
        });

        // El rodeo de dos pasos de B11: volver a borrador y borrar. Falla en el
        // primero, y el pedido cobrado sigue ahí.
        it("el rodeo de dos pasos falla en el primero: el pedido cobrado sigue después del DELETE", async () => {
          await expect(
            as(seller, SET_SALE_STATUS("draft", SALE_ORDER_IDS.paid)),
          ).rejects.toMatchObject({ code: "23514" });
          await api.query("ROLLBACK");
          const deleted = await as(seller, DELETE_SALE_ORDER(SALE_ORDER_IDS.paid));
          const remaining = await countAsOwnerHere(COUNT_SALE_ORDER(SALE_ORDER_IDS.paid));

          expect({ deleted: deleted.rowCount, remaining }).toEqual({ deleted: 0, remaining: 1 });
        });

        it("un borrador se edita y sigue siendo borrador", async () => {
          const { rowCount } = await as(
            seller,
            `UPDATE app.sale_orders SET status = 'draft', notes = 'editado'
              WHERE id = '${SALE_ORDER_IDS.draft}'`,
          );

          expect(rowCount).toBe(1);
        });

        // Control positivo: sin esto, un trigger que rechazara todo cambio de
        // estado pasaría todo lo anterior. Recorre la máquina de A08 hacia
        // adelante, una arista por UPDATE.
        it("el camino hacia adelante sigue andando: draft → awaiting_payment → paid → … → refunded", async () => {
          const id = SALE_ORDER_IDS.draft;
          const first = await as(seller, SET_SALE_STATUS("awaiting_payment", id));
          const paid = await api.query(SET_SALE_STATUS("paid", id));
          const preparing = await api.query(SET_SALE_STATUS("preparing", id));
          const ready = await api.query(SET_SALE_STATUS("ready", id));
          const shipped = await api.query(SET_SALE_STATUS("shipped", id));
          const delivered = await api.query(SET_SALE_STATUS("delivered", id));
          const refunded = await api.query(SET_SALE_STATUS("refunded", id));

          expect([
            first.rowCount,
            paid.rowCount,
            preparing.rowCount,
            ready.rowCount,
            shipped.rowCount,
            delivered.rowCount,
            refunded.rowCount,
          ]).toEqual([1, 1, 1, 1, 1, 1, 1]);
        });
      });
    });
  });

  // WP-B11c. Quien escribe estas tres tablas se da permisos: si bastara con el
  // tenant, B11 entero se anularía con un INSERT en role_permissions.
  describe("roles, role_permissions y staff_user_roles: settings.user:write; los roles de sistema no se borran ni se renombran (WP-B11c)", () => {
    // El actor denegado puede no ver lo que quedó (o la transacción se abortó
    // con el error): se cuenta como el owner, en la misma transacción.
    async function countAsOwner(sql: string): Promise<number> {
      await actAs(owner, REAL_TENANT_ID);
      const { rows } = await api.query(sql);
      return rows[0].n;
    }

    // Con una sola conexión de superusuario, fuera de la transacción del actor.
    async function countAsSuperuser(sql: string): Promise<number> {
      const { rows } = await db.client.query(sql);
      return rows[0].n;
    }

    describe("role_permissions", () => {
      it("el owner agrega, cambia y quita un permiso de un rol, con el RETURNING que emite Prisma", async () => {
        const created = await as(owner, `${INSERT_ROLE_PERMISSION} RETURNING role_id`);
        const edited = await api.query(UPDATE_ROLE_PERMISSION);
        const deleted = await api.query(DELETE_UPDATED_ROLE_PERMISSION);

        expect({
          created: created.rowCount,
          edited: edited.rowCount,
          deleted: deleted.rowCount,
        }).toEqual({ created: 1, edited: 1, deleted: 1 });
      });

      it("quien administra usuarios sin settings.user:read también escribe: no hay trampa de la lectura", async () => {
        const created = await as(
          custom.userAdminNoRead,
          `${INSERT_ROLE_PERMISSION} RETURNING role_id`,
        );
        const edited = await api.query(UPDATE_ROLE_PERMISSION);
        const deleted = await api.query(DELETE_UPDATED_ROLE_PERMISSION);

        expect({
          created: created.rowCount,
          edited: edited.rowCount,
          deleted: deleted.rowCount,
        }).toEqual({ created: 1, edited: 1, deleted: 1 });
      });

      it("el vendedor no puede darse un permiso: el INSERT en role_permissions se rechaza (42501)", async () => {
        const grantSelfSupplierWrite = `INSERT INTO app.role_permissions (tenant_id, role_id, permission_code)
          SELECT tenant_id, id, 'market.supplier:write' FROM app.roles
           WHERE tenant_id = '${REAL_TENANT_ID}' AND code = 'vendedor'`;

        await expect(as(seller, grantSelfSupplierWrite)).rejects.toMatchObject({ code: "42501" });
      });

      it("el encargado, que tiene todo salvo settings.user:write, no agrega permisos a un rol", async () => {
        await expect(as(manager, INSERT_ROLE_PERMISSION)).rejects.toMatchObject({ code: "42501" });
      });

      it("el encargado no cambia ni quita permisos: afecta cero filas y el rol los conserva", async () => {
        const edited = await as(manager, UPDATE_ROLE_PERMISSION);
        const deleted = await api.query(DELETE_ROLE_PERMISSION);
        const remaining = await countAsOwner(COUNT_TARGET_ROLE_PERMISSIONS);

        expect({ edited: edited.rowCount, deleted: deleted.rowCount, remaining }).toEqual({
          edited: 0,
          deleted: 0,
          remaining: 1,
        });
      });

      it("el vendedor no edita ni borra permisos de roles: sin WHERE afecta cero filas y el depósito conserva los cinco", async () => {
        const edited = await as(seller, UPDATE_ALL_ROLE_PERMISSIONS);
        const deleted = await api.query(DELETE_ALL_ROLE_PERMISSIONS);
        const remaining = await countAsOwner(COUNT_DEPOSITO_PERMISSIONS);

        expect({ edited: edited.rowCount, deleted: deleted.rowCount, remaining }).toEqual({
          edited: 0,
          deleted: 0,
          remaining: 5,
        });
      });

      it("un rol que solo lee settings.user ve los permisos de un rol pero no los escribe", async () => {
        await expect(as(custom.readOnly, INSERT_ROLE_PERMISSION)).rejects.toMatchObject({
          code: "42501",
        });
      });

      it("un rol que solo lee settings.user no cambia ni quita permisos: afecta cero filas", async () => {
        const edited = await as(custom.readOnly, UPDATE_ROLE_PERMISSION);
        const deleted = await api.query(DELETE_ROLE_PERMISSION);

        expect({ edited: edited.rowCount, deleted: deleted.rowCount }).toEqual({
          edited: 0,
          deleted: 0,
        });
      });
    });

    describe("staff_user_roles", () => {
      it("el owner asigna un rol a un usuario, con RETURNING, lo cambia y lo revoca", async () => {
        const assignedUser = custom.readOnly.userId;
        const created = await as(
          owner,
          `INSERT INTO app.staff_user_roles (staff_user_id, role_id, tenant_id)
           VALUES ('${assignedUser}', '${TARGET_ROLE_ID}', '${REAL_TENANT_ID}')
           RETURNING staff_user_id`,
        );
        const edited = await api.query(
          `UPDATE app.staff_user_roles SET granted_by = '${REAL_OWNER_ID}'
            WHERE staff_user_id = '${assignedUser}' AND role_id = '${TARGET_ROLE_ID}'`,
        );
        const deleted = await api.query(
          `DELETE FROM app.staff_user_roles
            WHERE staff_user_id = '${assignedUser}' AND role_id = '${TARGET_ROLE_ID}'`,
        );

        expect({
          created: created.rowCount,
          edited: edited.rowCount,
          deleted: deleted.rowCount,
        }).toEqual({ created: 1, edited: 1, deleted: 1 });
      });

      it("el vendedor no puede asignarse el rol de dueño: el INSERT en staff_user_roles se rechaza (42501)", async () => {
        const assignOwnerToSeller = `INSERT INTO app.staff_user_roles (staff_user_id, role_id, tenant_id)
          SELECT '${seller.userId}', id, tenant_id FROM app.roles WHERE ${OWNER_ROLE}`;

        await expect(as(seller, assignOwnerToSeller)).rejects.toMatchObject({ code: "42501" });
      });

      it("el encargado no asigna un rol a un usuario", async () => {
        const assign = `INSERT INTO app.staff_user_roles (staff_user_id, role_id, tenant_id)
          VALUES ('${custom.readOnly.userId}', '${TARGET_ROLE_ID}', '${REAL_TENANT_ID}')`;

        await expect(as(manager, assign)).rejects.toMatchObject({ code: "42501" });
      });

      it("el encargado no revoca un rol: el DELETE afecta cero filas y el usuario lo conserva", async () => {
        const revoke = `DELETE FROM app.staff_user_roles WHERE role_id = '${TARGET_ROLE_ID}'`;
        const countAssignments = `SELECT count(*)::int AS n FROM app.staff_user_roles
          WHERE role_id = '${TARGET_ROLE_ID}'`;

        const { rowCount } = await as(manager, revoke);
        const remaining = await countAsOwner(countAssignments);

        expect({ revoked: rowCount, remaining }).toEqual({ revoked: 0, remaining: 1 });
      });

      it("el depósito no revoca el rol de nadie: un DELETE sin WHERE afecta cero filas y el owner conserva el suyo", async () => {
        const countOwnerAssignment = `SELECT count(*)::int AS n FROM app.staff_user_roles
          WHERE staff_user_id = '${REAL_OWNER_ID}'`;

        const { rowCount } = await as(warehouse, `DELETE FROM app.staff_user_roles`);
        const remaining = await countAsOwner(countOwnerAssignment);

        expect({ revoked: rowCount, remaining }).toEqual({ revoked: 0, remaining: 1 });
      });

      it("quien administra usuarios sin settings.user:read asigna un rol, con RETURNING", async () => {
        const { rowCount } = await as(
          custom.userAdminNoRead,
          `INSERT INTO app.staff_user_roles (staff_user_id, role_id, tenant_id)
           VALUES ('${custom.readOnly.userId}', '${TARGET_ROLE_ID}', '${REAL_TENANT_ID}')
           RETURNING staff_user_id`,
        );

        expect(rowCount).toBe(1);
      });
    });

    describe("roles", () => {
      it("el owner crea un rol, con el RETURNING que emite Prisma, lo renombra y lo borra", async () => {
        const created = await as(owner, `${INSERT_ROLE} RETURNING id`);
        const renamed = await api.query(RENAME_TARGET_ROLE);
        const deleted = await api.query(DELETE_TARGET_ROLE);

        expect({
          created: created.rowCount,
          renamed: renamed.rowCount,
          deleted: deleted.rowCount,
        }).toEqual({ created: 1, renamed: 1, deleted: 1 });
      });

      it("quien administra usuarios sin settings.user:read crea un rol y lo renombra", async () => {
        const created = await as(custom.userAdminNoRead, `${INSERT_ROLE} RETURNING id`);
        const renamed = await api.query(RENAME_TARGET_ROLE);

        expect({ created: created.rowCount, renamed: renamed.rowCount }).toEqual({
          created: 1,
          renamed: 1,
        });
      });

      it("el vendedor no puede crear un rol, aunque el INSERT no pida RETURNING", async () => {
        await expect(as(seller, INSERT_ROLE)).rejects.toMatchObject({ code: "42501" });
      });

      it("el encargado no puede crear un rol", async () => {
        await expect(as(manager, INSERT_ROLE)).rejects.toMatchObject({ code: "42501" });
      });

      it("el vendedor no renombra roles: un UPDATE sin WHERE afecta cero filas", async () => {
        const { rowCount } = await as(seller, RENAME_ALL_ROLES);

        expect(rowCount).toBe(0);
      });

      // El defecto que la revisión de B11 reprodujo: como vendedor, este DELETE
      // borró la fila y, por la cascada (que no evalúa RLS), sus permisos.
      it("el vendedor no borra el rol de depósito: afecta cero filas y el rol conserva sus cinco permisos", async () => {
        const { rowCount } = await as(seller, DELETE_DEPOSITO_ROLE);
        const roleLeft = await countAsOwner(
          COUNT_ROLE(`tenant_id = '${REAL_TENANT_ID}' AND code = 'deposito'`),
        );
        const permissionsLeft = await countAsOwner(COUNT_DEPOSITO_PERMISSIONS);

        expect({ deleted: rowCount, roleLeft, permissionsLeft }).toEqual({
          deleted: 0,
          roleLeft: 1,
          permissionsLeft: 5,
        });
      });

      it("el encargado no borra un rol personalizado: afecta cero filas y el rol sigue", async () => {
        const { rowCount } = await as(manager, DELETE_TARGET_ROLE);
        const roleLeft = await countAsOwner(COUNT_ROLE(`id = '${TARGET_ROLE_ID}'`));

        expect({ deleted: rowCount, roleLeft }).toEqual({ deleted: 0, roleLeft: 1 });
      });
    });

    // Probado con el rol que SÍ tiene el permiso, para que lo que frene sea el
    // trigger y no la falta de permiso. Los errores de un trigger de invariante
    // llegan como 23514 (check_violation), como en la guarda de 0031.
    describe("los roles de sistema no se borran ni se renombran, por nadie", () => {
      it("el owner, con settings.user:write, no puede borrar el rol de dueño: el trigger lo rechaza y el rol sigue", async () => {
        await expect(as(owner, DELETE_OWNER_ROLE)).rejects.toMatchObject({
          code: "23514",
          message: expect.stringContaining("no se puede borrar"),
        });
        expect(await countAsSuperuser(COUNT_ROLE(OWNER_ROLE))).toBe(1);
      });

      it("el owner no renombra el rol de dueño", async () => {
        await expect(as(owner, RENAME_OWNER_ROLE)).rejects.toMatchObject({
          code: "23514",
          message: expect.stringContaining("no se puede renombrar"),
        });
      });

      it("el owner no le cambia el código al rol de dueño", async () => {
        await expect(as(owner, RECODE_OWNER_ROLE)).rejects.toMatchObject({
          code: "23514",
          message: expect.stringContaining("no se puede renombrar"),
        });
      });

      it("el owner no baja la marca is_system del rol de dueño: bajarla y borrarlo serían dos pasos", async () => {
        await expect(as(owner, UNMARK_OWNER_ROLE)).rejects.toMatchObject({
          code: "23514",
          message: expect.stringContaining("no se puede cambiar"),
        });
      });

      it("el owner no crea un rol marcado is_system: la política de INSERT lo rechaza (42501)", async () => {
        await expect(as(owner, INSERT_SYSTEM_ROLE)).rejects.toMatchObject({ code: "42501" });
      });

      it("ni el superusuario, que elude RLS, borra un rol de sistema", async () => {
        await expect(db.client.query(DELETE_OWNER_ROLE)).rejects.toMatchObject({ code: "23514" });
      });

      it("un rol de sistema admite un UPDATE que no toca su nombre, su código ni su marca", async () => {
        const { rowCount } = await as(
          owner,
          `UPDATE app.roles SET created_at = created_at
            WHERE tenant_id = '${REAL_TENANT_ID}' AND code = 'deposito'`,
        );

        expect(rowCount).toBe(1);
      });
    });

    // Revisión cruzada de B11c: el dueño, con `settings.user:write`, se vaciaba
    // su propio rol con un DELETE (27 permisos en una sentencia) y quedaba tan
    // bloqueado como si lo hubiera borrado. Los permisos de un rol de sistema son
    // la matriz de security-spec §2.1 y los cambia el seed.
    describe("los permisos de un rol de sistema no se modifican en tiempo de ejecución", () => {
      it("el dueño no se vacía su propio rol: el DELETE afecta cero filas, conserva los 28 permisos y sigue administrando", async () => {
        const { rowCount } = await as(owner, DELETE_OWNER_ROLE_PERMISSIONS);
        const remaining = await countAsOwner(COUNT_OWNER_ROLE_PERMISSIONS);
        const { rows } = await api.query(CAN_ADMINISTER_USERS);

        expect({ deleted: rowCount, remaining, canAdminister: rows[0].ok }).toEqual({
          deleted: 0,
          remaining: 28,
          canAdminister: true,
        });
      });

      it("un DELETE sin WHERE del dueño solo alcanza a los roles personalizados: los de sistema conservan sus 66 permisos", async () => {
        const { rowCount } = await as(owner, DELETE_ALL_ROLE_PERMISSIONS);
        const remaining = await countAsOwner(COUNT_SYSTEM_ROLE_PERMISSIONS);

        expect(rowCount).toBeGreaterThan(0);
        expect(remaining).toBe(66);
      });

      it("el dueño no le agrega un permiso a un rol de sistema (42501)", async () => {
        await expect(as(owner, INSERT_PERMISSION_INTO_SYSTEM_ROLE)).rejects.toMatchObject({
          code: "42501",
        });
      });

      it("el dueño no cambia un permiso de un rol de sistema: el UPDATE afecta cero filas", async () => {
        const { rowCount } = await as(owner, UPDATE_SYSTEM_ROLE_PERMISSION);

        expect(rowCount).toBe(0);
      });

      it("el dueño no mueve un permiso de un rol personalizado a uno de sistema (42501)", async () => {
        await expect(as(owner, MOVE_PERMISSION_TO_SYSTEM_ROLE)).rejects.toMatchObject({
          code: "42501",
        });
      });

      it("quien administra usuarios sin ser dueño tampoco toca los permisos de un rol de sistema", async () => {
        await expect(
          as(custom.userAdmin, INSERT_PERMISSION_INTO_SYSTEM_ROLE),
        ).rejects.toMatchObject({ code: "42501" });
      });

      // El seed y el ETL son el camino para cambiarlos, y siguen funcionando:
      // corren como superusuario, que elude RLS.
      it("el seed sí los siembra: seed_roles, como superusuario, es idempotente", async () => {
        await db.client.query(`SELECT app.seed_roles('${REAL_TENANT_ID}')`);
        const remaining = await countAsSuperuser(COUNT_SYSTEM_ROLE_PERMISSIONS);

        expect(remaining).toBe(66);
      });
    });

    // Revisión cruzada de B11c: `permissions` no tiene RLS y `joda_api` conservaba
    // el GRANT general. Un vendedor del tenant A borró un código y las
    // `role_permissions` de ambos tenants que lo tenían pasaron de 3 y 3 a 0.
    describe("permissions: el catálogo global lo carga el seed, no la API", () => {
      it.each([
        ["INSERT", INSERT_PERMISSION],
        ["UPDATE", UPDATE_PERMISSION],
        ["DELETE", DELETE_PERMISSION],
      ])(
        "el dueño, que tiene todos los permisos, no puede hacer %s (42501)",
        async (_verb, sql) => {
          await expect(as(owner, sql)).rejects.toMatchObject({ code: "42501" });
        },
      );

      it("el vendedor no puede borrar un código del catálogo (42501): no vacía los roles de ningún tenant", async () => {
        await expect(as(seller, DELETE_PERMISSION)).rejects.toMatchObject({ code: "42501" });
      });

      it("el owner de otro tenant tampoco (42501)", async () => {
        await expect(as(peerOwner, DELETE_PERMISSION, PEER_TENANT_ID)).rejects.toMatchObject({
          code: "42501",
        });
      });

      it("joda_api sigue leyendo el catálogo: las 28 filas", async () => {
        const { rows } = await as(seller, `SELECT count(*)::int AS n FROM app.permissions`);

        expect(rows[0].n).toBe(28);
      });
    });

    // El SELECT sigue siendo por tenant: la API lee estas dos tablas para
    // resolver los permisos de cada sesión (`getGrantedPermissionCodes`), y el
    // vendedor no tiene `settings.user:read`.
    describe("la lectura sigue por tenant", () => {
      it("el vendedor, sin settings.user:read, lee los seis permisos de su rol", async () => {
        const { rows } = await as(
          seller,
          `SELECT count(*)::int AS n FROM app.role_permissions rp
            JOIN app.staff_user_roles sur ON sur.role_id = rp.role_id
            WHERE sur.staff_user_id = '${seller.userId}'`,
        );

        expect(rows[0].n).toBe(6);
      });
    });

    describe("tenant Y permiso: el owner de otro tenant no escribe en el tenant real", () => {
      it.each([
        ["roles", INSERT_ROLE],
        ["role_permissions", INSERT_ROLE_PERMISSION],
      ])(
        "%s: el INSERT con tenant_id del tenant real se rechaza (42501)",
        async (_table, insert) => {
          await expect(as(peerOwner, insert, PEER_TENANT_ID)).rejects.toMatchObject({
            code: "42501",
          });
        },
      );

      it("staff_user_roles: el INSERT con tenant_id del tenant real se rechaza (42501)", async () => {
        const assign = `INSERT INTO app.staff_user_roles (staff_user_id, role_id, tenant_id)
          VALUES ('${custom.readOnly.userId}', '${TARGET_ROLE_ID}', '${REAL_TENANT_ID}')`;

        await expect(as(peerOwner, assign, PEER_TENANT_ID)).rejects.toMatchObject({
          code: "42501",
        });
      });

      it.each([
        ["roles (UPDATE)", RENAME_TARGET_ROLE],
        ["roles (DELETE)", DELETE_TARGET_ROLE],
        ["role_permissions (UPDATE)", UPDATE_ROLE_PERMISSION],
        ["role_permissions (DELETE)", DELETE_ROLE_PERMISSION],
        [
          "staff_user_roles (DELETE)",
          `DELETE FROM app.staff_user_roles WHERE role_id = '${TARGET_ROLE_ID}'`,
        ],
      ])("%s de una fila del tenant real afecta cero filas", async (_what, sql) => {
        const { rowCount } = await as(peerOwner, sql, PEER_TENANT_ID);

        expect(rowCount).toBe(0);
      });
    });
  });
  // WP-B11b, la tabla hija. Nada exigía permiso: ni leer ni escribir. Un
  // vendedor leía y editaba precios de proveedor y márgenes proyectados.
  describe("sourcing_scenario_lines: leer exige market.sourcing:read; escribir, market.sourcing:write (WP-B11b)", () => {
    it("el owner agrega una línea, con el RETURNING que emite Prisma, cambia su precio y la borra", async () => {
      const created = await as(owner, `${INSERT_SCENARIO_LINE} RETURNING id`);
      const edited = await api.query(UPDATE_SCENARIO_LINE);
      const deleted = await api.query(DELETE_SCENARIO_LINE);

      expect({
        created: created.rowCount,
        edited: edited.rowCount,
        deleted: deleted.rowCount,
      }).toEqual({ created: 1, edited: 1, deleted: 1 });
    });

    it("quien lee y escribe sourcing agrega, edita y borra líneas", async () => {
      const created = await as(custom.sourcingEditor, `${INSERT_SCENARIO_LINE} RETURNING id`);
      const edited = await api.query(UPDATE_SCENARIO_LINE);
      const deleted = await api.query(DELETE_SCENARIO_LINE);

      expect({
        created: created.rowCount,
        edited: edited.rowCount,
        deleted: deleted.rowCount,
      }).toEqual({ created: 1, edited: 1, deleted: 1 });
    });

    // El defecto: como vendedor, esta consulta devolvía las líneas.
    it("el vendedor no ve las líneas: no lee precios de proveedor", async () => {
      const { rowCount } = await as(seller, SELECT_SCENARIO_LINES);

      expect(rowCount).toBe(0);
    });

    it("el depósito no ve las líneas", async () => {
      const { rowCount } = await as(warehouse, SELECT_SCENARIO_LINES);

      expect(rowCount).toBe(0);
    });

    it("el vendedor no agrega una línea, aunque el INSERT no pida RETURNING (42501)", async () => {
      await expect(as(seller, INSERT_SCENARIO_LINE)).rejects.toMatchObject({ code: "42501" });
    });

    it("el vendedor no edita ni borra líneas: sin WHERE afectan cero filas", async () => {
      const edited = await as(seller, UPDATE_ALL_SCENARIO_LINES);
      const deleted = await api.query(DELETE_ALL_SCENARIO_LINES);
      const remaining = await countScenarioLinesAsOwner();

      expect({ edited: edited.rowCount, deleted: deleted.rowCount, remaining }).toEqual({
        edited: 0,
        deleted: 0,
        remaining: 1,
      });
    });

    it("un rol que solo lee sourcing ve las líneas pero no las agrega (42501)", async () => {
      const seen = await as(custom.readOnly, SELECT_SCENARIO_LINES);
      await api.query("ROLLBACK");

      expect(seen.rowCount).toBe(1);
      await expect(as(custom.readOnly, INSERT_SCENARIO_LINE)).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("un rol que solo lee sourcing no edita ni borra líneas: afectan cero filas", async () => {
      const edited = await as(custom.readOnly, UPDATE_SCENARIO_LINE);
      const deleted = await api.query(DELETE_SCENARIO_LINE);

      expect({ edited: edited.rowCount, deleted: deleted.rowCount }).toEqual({
        edited: 0,
        deleted: 0,
      });
    });

    // La trampa de la lectura, ahora también en las líneas: la lectura está
    // gateada.
    it("quien escribe sourcing sin leerlo: el INSERT pasa, el INSERT ... RETURNING se rechaza", async () => {
      const plain = await as(custom.sourcingWriterNoRead, INSERT_SCENARIO_LINE);
      await api.query("ROLLBACK");

      expect(plain.rowCount).toBe(1);
      await expect(
        as(custom.sourcingWriterNoRead, `${INSERT_SCENARIO_LINE} RETURNING id`),
      ).rejects.toMatchObject({ code: "42501" });
    });

    // Fijado a propósito: sin WHERE ni RETURNING el UPDATE y el DELETE no leen,
    // y la capa 1 solo pide el permiso de escritura.
    it("quien escribe sourcing sin leerlo: UPDATE ... WHERE afecta cero filas, y sin WHERE sí edita", async () => {
      const withWhere = await as(custom.sourcingWriterNoRead, UPDATE_SCENARIO_LINE);
      const withoutWhere = await api.query(UPDATE_ALL_SCENARIO_LINES);

      expect({ withWhere: withWhere.rowCount, withoutWhere: withoutWhere.rowCount }).toEqual({
        withWhere: 0,
        withoutWhere: 1,
      });
    });

    it("quien escribe sourcing sin leerlo: DELETE ... WHERE afecta cero filas, y sin WHERE sí borra", async () => {
      const withWhere = await as(custom.sourcingWriterNoRead, DELETE_SCENARIO_LINE);
      const withoutWhere = await api.query(DELETE_ALL_SCENARIO_LINES);
      const remaining = await countScenarioLinesAsOwner();

      expect({
        withWhere: withWhere.rowCount,
        withoutWhere: withoutWhere.rowCount,
        remaining,
      }).toEqual({ withWhere: 0, withoutWhere: 1, remaining: 0 });
    });

    // La cascada no evalúa RLS: borrar un escenario borra sus líneas, y como
    // exige el mismo permiso que borrarlas, no abre nada.
    it("borrar un escenario borra sus líneas (la cascada no evalúa RLS)", async () => {
      await as(custom.sourcingEditor, DELETE_SCENARIO);
      const remaining = await countScenarioLinesAsOwner();

      expect(remaining).toBe(0);
    });

    it("el vendedor, que no borra el escenario, no pierde sus líneas por la cascada", async () => {
      await as(seller, DELETE_SCENARIO);
      const remaining = await countScenarioLinesAsOwner();

      expect(remaining).toBe(1);
    });

    it("el owner de otro tenant no ve ni escribe líneas del tenant real", async () => {
      const seen = await as(peerOwner, SELECT_SCENARIO_LINES, PEER_TENANT_ID);
      const edited = await api.query(UPDATE_SCENARIO_LINE);
      const deleted = await api.query(DELETE_SCENARIO_LINE);

      expect({ seen: seen.rowCount, edited: edited.rowCount, deleted: deleted.rowCount }).toEqual({
        seen: 0,
        edited: 0,
        deleted: 0,
      });
    });

    it("el owner de otro tenant no agrega una línea al escenario del tenant real (42501)", async () => {
      await expect(as(peerOwner, INSERT_SCENARIO_LINE, PEER_TENANT_ID)).rejects.toMatchObject({
        code: "42501",
      });
    });

    // Mira como el owner, dentro de la misma transacción del actor denegado,
    // que puede no ver nada (no tiene `:read`).
    async function countScenarioLinesAsOwner(): Promise<number> {
      await actAs(owner, REAL_TENANT_ID);
      const { rows } = await api.query(COUNT_SCENARIO_LINES);
      return rows[0].n;
    }
  });

  // El defecto de B10, ahora en la escritura: tener el permiso NO alcanza si
  // la fila es de otro tenant. tenant_isolation es RESTRICTIVE y se combina
  // con AND contra las políticas de permiso nuevas.
  describe("tenant Y permiso: el owner de otro tenant no escribe en el tenant real (WP-B10, WP-B11, WP-B11b)", () => {
    it.each([
      ["suppliers", INSERT_SUPPLIER],
      ["purchase_orders", INSERT_PO],
      ["inventory_lots", INSERT_LOT],
      ["chart_of_accounts", INSERT_ACCOUNT],
      ["customer_deposits", INSERT_DEPOSIT],
      ["sourcing_scenarios", INSERT_SCENARIO],
    ])("%s: el INSERT con tenant_id del tenant real se rechaza (42501)", async (_table, insert) => {
      await expect(as(peerOwner, insert, PEER_TENANT_ID)).rejects.toMatchObject({
        code: "42501",
      });
    });

    it.each([
      ["suppliers", UPDATE_SUPPLIER],
      ["purchase_orders", UPDATE_PO],
      ["inventory_lots", UPDATE_LOT],
      ["chart_of_accounts", UPDATE_ACCOUNT],
      ["customer_deposits", UPDATE_DEPOSIT],
      ["sourcing_scenarios", UPDATE_SCENARIO],
    ])("%s: el UPDATE de una fila del tenant real afecta cero filas", async (_table, update) => {
      const { rowCount } = await as(peerOwner, update, PEER_TENANT_ID);

      expect(rowCount).toBe(0);
    });

    it("sourcing_scenarios: el DELETE de una fila del tenant real afecta cero filas", async () => {
      const { rowCount } = await as(peerOwner, DELETE_SCENARIO, PEER_TENANT_ID);

      expect(rowCount).toBe(0);
    });
  });
});
