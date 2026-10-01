import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "../setup/db.js";
import { runSmokeBusinessFlow } from "../../scripts/lib/smoke.mjs";

// WP-B11 (packages/db/migrations/0030_write_permissions_sensitive_tables.sql).
// Regla que verifican: docs/security-spec.md §3.1 (capa 1) y ADR-016 — en
// suppliers, purchase_orders, inventory_lots, chart_of_accounts y
// customer_deposits, escribir exige tenant Y el permiso de escritura, no solo
// tenant.
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
const LOT_ID = "b1100000-0000-0000-0000-0000000000c1";
const NEW_LOT_ID = "b1100000-0000-0000-0000-0000000000c2";
const DEPOSIT_ID = "b1100000-0000-0000-0000-0000000000e1";

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

describe("escribir en las tablas sensibles exige el permiso de escritura, no solo tenant (WP-B11, docs/security-spec.md §3.1, ADR-016)", () => {
  let db: TestDb;
  let api: Client;
  let owner: Actor;
  let seller: Actor;
  let warehouse: Actor;
  let peerOwner: Actor;
  const custom = {} as Record<keyof typeof CUSTOM_ROLES, Actor>;

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
              'USD', '${REAL_OWNER_ID}', '${REAL_OWNER_ID}', now());
      INSERT INTO app.inventory_lots
        (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
         fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
      VALUES ('${LOT_ID}', '${REAL_TENANT_ID}', '${SEALED_VARIANT_ID}', 1, 'unit', 0, 'PYG', 1, 0, 0);
      INSERT INTO app.customer_deposits (id, tenant_id, customer_id, amount_pyg)
      VALUES ('${DEPOSIT_ID}', '${REAL_TENANT_ID}', '${CUSTOMER_ID}', 100000);
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

  // El defecto de B10, ahora en la escritura: tener el permiso NO alcanza si
  // la fila es de otro tenant. tenant_isolation es RESTRICTIVE y se combina
  // con AND contra las políticas de permiso nuevas.
  describe("tenant Y permiso: el owner de otro tenant no escribe en el tenant real (WP-B10, WP-B11)", () => {
    it.each([
      ["suppliers", INSERT_SUPPLIER],
      ["purchase_orders", INSERT_PO],
      ["inventory_lots", INSERT_LOT],
      ["chart_of_accounts", INSERT_ACCOUNT],
      ["customer_deposits", INSERT_DEPOSIT],
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
    ])("%s: el UPDATE de una fila del tenant real afecta cero filas", async (_table, update) => {
      const { rowCount } = await as(peerOwner, update, PEER_TENANT_ID);

      expect(rowCount).toBe(0);
    });
  });
});
