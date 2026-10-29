import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "../setup/db.js";
import { runSmokeBusinessFlow } from "../../scripts/lib/smoke.mjs";

// WP-B18 (packages/db/migrations/0039_decant_plan_lots_and_cost_layer_permission.sql).
// Reglas que verifican: RN-FRA-01 (planificar es el primer momento del decant,
// al confirmar la venta), RN-FRA-07 (el granel de origen) y docs/security-spec.md
// §3.1, «Planificar un decant sin leer lotes»: el vendedor planifica sin
// `inventory.stock:read` (que incluye el costo de lote) por una función
// SECURITY DEFINER acotada, y una línea de venta tiene una sola orden de
// fraccionamiento activa.
//
// Cada prueba usa la credencial del runtime, `joda_api` (NOBYPASSRLS), con la
// forma real de las sesiones (`set_config(..., true)` dentro de una
// transacción) y no el superusuario del contenedor, que elude RLS y haría
// pasar una función que no filtra por tenant ni valida permisos.
const REAL_TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PEER_TENANT_ID = "b1880000-0000-0000-0000-000000000001";
const JODA_API_TEST_PASSWORD = "decant-plan-lots-test-only";

// Sembrados por smoke_business_flow.sql.
const SMOKE_BULK_VARIANT_ID = "55555555-0000-0000-0000-000000000002";
const SMOKE_BULK_LOT_ID = "99999999-0000-0000-0000-000000000002";
const DECANT_VARIANT_ID = "55555555-0000-0000-0000-000000000003";
const SMOKE_SALE_ORDER_ID = "cccccccc-0000-0000-0000-000000000001";
const SUPPLY_PRODUCT_ID = "44444444-0000-0000-0000-00000000aaaa";

// Sembrados por este archivo.
const OWN_PRODUCT_ID = "b1890000-0000-0000-0000-0000000000a1";
const OWN_BULK_VARIANT_ID = "b1890000-0000-0000-0000-0000000000b1";
const OWN_SUPPLY_VARIANT_ID = "b1890000-0000-0000-0000-0000000000b2";
// Lotes del granel propio. Los tres primeros son los candidatos, en el orden en
// que la función los tiene que devolver: el más antiguo abierto primero y, a
// igual apertura, el id.
const OLDEST_LOT_ID = "b1890000-0000-0000-0000-0000000000c3";
const TIED_LOT_A_ID = "b1890000-0000-0000-0000-0000000000c1";
const TIED_LOT_B_ID = "b1890000-0000-0000-0000-0000000000c2";
const EMPTY_LOT_ID = "b1890000-0000-0000-0000-0000000000c4";
const QUARANTINE_LOT_ID = "b1890000-0000-0000-0000-0000000000c5";
const UNOPENED_LOT_ID = "b1890000-0000-0000-0000-0000000000c6";
const SUPPLY_LOT_ID = "b1890000-0000-0000-0000-0000000000d1";
const SUPPLY_EMPTY_LOT_ID = "b1890000-0000-0000-0000-0000000000d2";
const SUPPLY_QUARANTINE_LOT_ID = "b1890000-0000-0000-0000-0000000000d3";
// El costo de cada lote propio es un número reconocible: si apareciera en una
// respuesta, la prueba lo vería.
const OWN_LOT_UNIT_COST = 777_001;
const OWN_SUPPLY_UNIT_COST = 424_242;
// Tenant vecino, con su propio granel.
const PEER_BULK_VARIANT_ID = "b1880000-0000-0000-0000-0000000000b1";
const PEER_BULK_LOT_ID = "b1880000-0000-0000-0000-0000000000c1";
// Dos líneas de venta del pedido del smoke, para las órdenes de fraccionamiento.
const LINE_A_ID = "b1890000-0000-0000-0000-0000000000e1";
const LINE_B_ID = "b1890000-0000-0000-0000-0000000000e2";

interface Actor {
  userId: string;
  sessionId: string;
}

const CANDIDATES_OF = (variantId: string) =>
  `SELECT * FROM app.list_decant_plan_lots('${variantId}')`;

// Una orden de fraccionamiento sobre el granel del smoke, con la forma del
// `create` de Prisma (INSERT ... RETURNING). `line` es SQL literal.
const INSERT_ORDER = (line: string, status = "pending") =>
  `INSERT INTO app.decant_work_orders
     (tenant_id, source_lot_id, target_variant_id, sale_order_id, sale_order_line_id,
      qty_units, ml_per_unit, ml_expected, waste_expected, status)
   VALUES ('${REAL_TENANT_ID}', '${SMOKE_BULK_LOT_ID}', '${DECANT_VARIANT_ID}',
           ${line === "NULL" ? "NULL" : `'${SMOKE_SALE_ORDER_ID}'`}, ${line},
           1, 10.000, 10.000, 0.200, '${status}')
   RETURNING id`;
const LINE = (lineId: string) => `'${lineId}'`;

describe("planificar un decant sin leer lotes y sin duplicar la orden (WP-B18, RN-FRA-01, RN-FRA-07, docs/security-spec.md §3.1)", () => {
  let db: TestDb;
  let api: Client;
  let owner: Actor;
  let manager: Actor;
  let seller: Actor;
  let warehouse: Actor;
  let withoutPlan: Actor;
  let peerOwner: Actor;

  // Mismo contexto que withTenantTx: tercer parámetro de set_config en true.
  async function actAs(actor: Actor, tenantId = REAL_TENANT_ID, audience = "staff") {
    await api.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.tenant_id', $2, true),
              set_config('app.audience', $4, true),
              set_config('app.session_id', $3, true)`,
      [actor.userId, tenantId, actor.sessionId, audience],
    );
  }

  // Abre la transacción, fija el contexto del actor y ejecuta. El ROLLBACK lo
  // hace el afterEach, también cuando la consulta falla.
  async function as(actor: Actor, sql: string, tenantId = REAL_TENANT_ID) {
    await api.query("BEGIN");
    await actAs(actor, tenantId);
    return api.query(sql);
  }

  async function createActor(n: string, tenantId: string, roleId: string): Promise<Actor> {
    const actor = {
      userId: `b1890000-0000-0000-0000-000000000f${n}`,
      sessionId: `b18a0000-0000-0000-0000-000000000f${n}`,
    };
    await db.client.query(
      `INSERT INTO app.staff_users (id, tenant_id, auth_subject, email, full_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [actor.userId, tenantId, `sub-b18-${n}`, `b18-${n}@joda.test`, `Actor ${n}`],
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

  async function seedRoleActor(n: string, tenantId: string, code: string): Promise<Actor> {
    const { rows } = await db.client.query(
      "SELECT id FROM app.roles WHERE tenant_id = $1 AND code = $2",
      [tenantId, code],
    );
    return createActor(n, tenantId, rows[0].id);
  }

  // Un lote del tenant real con saldo (un ajuste con la superconexión: la
  // proyección de saldos la mantiene un disparador).
  async function seedLot(
    id: string,
    variantId: string,
    uom: "ml" | "unit",
    status: string,
    openedAt: string | null,
    stock: number,
    unitCost: number,
    tenantId = REAL_TENANT_ID,
  ): Promise<void> {
    await db.client.query(
      `INSERT INTO app.inventory_lots
         (id, tenant_id, variant_id, status, qty_initial, uom, unit_cost_minor, currency,
          fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg, opened_at)
       VALUES ($1, $2, $3, $4, 100, $5, $6::bigint, 'PYG', 1, $6::bigint, $6::bigint, $7)`,
      [id, tenantId, variantId, status, uom, unitCost, openedAt],
    );
    if (stock > 0) {
      await db.client.query(
        `INSERT INTO app.inventory_movements
           (tenant_id, lot_id, variant_id, qty, uom, movement_type)
         VALUES ($1, $2, $3, $4, $5, 'adjustment')`,
        [tenantId, id, variantId, stock, uom],
      );
    }
  }

  beforeAll(async () => {
    db = await startTestDb();
    await runSmokeBusinessFlow(db.client);

    // Granel y un insumo propios del tenant real, con lotes en cada estado que
    // importa, todos con un costo reconocible.
    await db.client.query(`
      INSERT INTO app.products (id, tenant_id, kind, slug, name, status)
      VALUES ('${OWN_PRODUCT_ID}', '${REAL_TENANT_ID}', 'perfume', 'b18-perfume', 'Perfume B18',
              'active');
      INSERT INTO app.perfume_details
        (tenant_id, product_id, concentration, nominal_volume_ml, olfactory_family,
         waste_factor, unusable_residue_ml)
      VALUES ('${REAL_TENANT_ID}', '${OWN_PRODUCT_ID}', 'edp', 100, 'Cítrico', 0.02, 2.5);
      INSERT INTO app.product_variants
        (id, tenant_id, product_id, sku, variant_type, uom, price_pyg, online_visible)
      VALUES ('${OWN_BULK_VARIANT_ID}', '${REAL_TENANT_ID}', '${OWN_PRODUCT_ID}', 'B18-BULK',
              'bulk', 'ml', 0, false),
             ('${OWN_SUPPLY_VARIANT_ID}', '${REAL_TENANT_ID}', '${SUPPLY_PRODUCT_ID}', 'B18-SUPPLY',
              'supply', 'unit', 0, false);
    `);
    await seedLot(
      OLDEST_LOT_ID,
      OWN_BULK_VARIANT_ID,
      "ml",
      "open_for_decant",
      "2025-12-01T10:00:00Z",
      50,
      OWN_LOT_UNIT_COST,
    );
    await seedLot(
      TIED_LOT_B_ID,
      OWN_BULK_VARIANT_ID,
      "ml",
      "open_for_decant",
      "2026-01-01T10:00:00Z",
      40,
      OWN_LOT_UNIT_COST,
    );
    await seedLot(
      TIED_LOT_A_ID,
      OWN_BULK_VARIANT_ID,
      "ml",
      "open_for_decant",
      "2026-01-01T10:00:00Z",
      30,
      OWN_LOT_UNIT_COST,
    );
    // Abierto y sin saldo, en cuarentena y con saldo, y un granel todavía sin abrir.
    await seedLot(
      EMPTY_LOT_ID,
      OWN_BULK_VARIANT_ID,
      "ml",
      "open_for_decant",
      "2026-02-01T10:00:00Z",
      0,
      OWN_LOT_UNIT_COST,
    );
    await seedLot(
      QUARANTINE_LOT_ID,
      OWN_BULK_VARIANT_ID,
      "ml",
      "quarantine",
      "2026-01-15T10:00:00Z",
      20,
      OWN_LOT_UNIT_COST,
    );
    await seedLot(
      UNOPENED_LOT_ID,
      OWN_BULK_VARIANT_ID,
      "ml",
      "available",
      null,
      10,
      OWN_LOT_UNIT_COST,
    );
    await seedLot(
      SUPPLY_LOT_ID,
      OWN_SUPPLY_VARIANT_ID,
      "unit",
      "available",
      null,
      100,
      OWN_SUPPLY_UNIT_COST,
    );
    await seedLot(
      SUPPLY_EMPTY_LOT_ID,
      OWN_SUPPLY_VARIANT_ID,
      "unit",
      "available",
      null,
      0,
      OWN_SUPPLY_UNIT_COST,
    );
    await seedLot(
      SUPPLY_QUARANTINE_LOT_ID,
      OWN_SUPPLY_VARIANT_ID,
      "unit",
      "quarantine",
      null,
      5,
      OWN_SUPPLY_UNIT_COST,
    );

    // Tenant vecino con su propio granel abierto: la función, desde el tenant
    // real, no lo tiene que ver.
    await db.client.query(`
      INSERT INTO app.tenants (id, slug, legal_name, trade_name)
      VALUES ('${PEER_TENANT_ID}', 'tenant-vecino-b18', 'Vecino B18 SA', 'Vecino B18');
      SELECT app.seed_roles('${PEER_TENANT_ID}');
      INSERT INTO app.products (id, tenant_id, kind, slug, name, status)
      VALUES ('b1880000-0000-0000-0000-0000000000a1', '${PEER_TENANT_ID}', 'perfume',
              'vecino-perfume', 'Perfume vecino', 'active');
      INSERT INTO app.perfume_details
        (tenant_id, product_id, concentration, nominal_volume_ml, olfactory_family,
         waste_factor, unusable_residue_ml)
      VALUES ('${PEER_TENANT_ID}', 'b1880000-0000-0000-0000-0000000000a1', 'edp', 100, 'Cítrico',
              0.02, 2.5);
      INSERT INTO app.product_variants
        (id, tenant_id, product_id, sku, variant_type, uom, price_pyg, online_visible)
      VALUES ('${PEER_BULK_VARIANT_ID}', '${PEER_TENANT_ID}', 'b1880000-0000-0000-0000-0000000000a1',
              'VECINO-BULK', 'bulk', 'ml', 0, false);
    `);
    await seedLot(
      PEER_BULK_LOT_ID,
      PEER_BULK_VARIANT_ID,
      "ml",
      "open_for_decant",
      "2026-01-01T10:00:00Z",
      80,
      100,
      PEER_TENANT_ID,
    );

    // Dos líneas de venta del pedido del smoke, para las órdenes de fraccionamiento.
    await db.client.query(`
      INSERT INTO app.sale_order_lines
        (id, tenant_id, sale_order_id, variant_id, qty, uom, unit_price_pyg, line_total_pyg)
      VALUES ('${LINE_A_ID}', '${REAL_TENANT_ID}', '${SMOKE_SALE_ORDER_ID}', '${DECANT_VARIANT_ID}',
              1, 'ml', 245000, 245000),
             ('${LINE_B_ID}', '${REAL_TENANT_ID}', '${SMOKE_SALE_ORDER_ID}', '${DECANT_VARIANT_ID}',
              1, 'ml', 245000, 245000);
    `);

    // Un rol personalizado que lee lotes y ejecuta decants, y NO planifica: el
    // vecino más plausible de `inventory.decant:plan`.
    await db.client.query(`
      INSERT INTO app.roles (id, tenant_id, code, name)
      VALUES ('b1890000-0000-0000-0000-0000000000f0', '${REAL_TENANT_ID}', 'b18-sin-plan', 'Sin plan');
      INSERT INTO app.role_permissions (tenant_id, role_id, permission_code)
      VALUES ('${REAL_TENANT_ID}', 'b1890000-0000-0000-0000-0000000000f0', 'inventory.stock:read'),
             ('${REAL_TENANT_ID}', 'b1890000-0000-0000-0000-0000000000f0', 'inventory.decant:execute');
    `);

    seller = await seedRoleActor("01", REAL_TENANT_ID, "vendedor");
    warehouse = await seedRoleActor("02", REAL_TENANT_ID, "deposito");
    manager = await seedRoleActor("03", REAL_TENANT_ID, "manager");
    owner = await seedRoleActor("04", REAL_TENANT_ID, "owner");
    withoutPlan = await createActor("05", REAL_TENANT_ID, "b1890000-0000-0000-0000-0000000000f0");
    peerOwner = await seedRoleActor("06", PEER_TENANT_ID, "owner");

    await db.client.query(`ALTER ROLE joda_api PASSWORD '${JODA_API_TEST_PASSWORD}'`);
    api = new Client({
      host: db.container.getHost(),
      port: db.container.getPort(),
      database: db.container.getDatabase(),
      user: "joda_api",
      password: JODA_API_TEST_PASSWORD,
    });
    await api.connect();
  }, 90_000);

  // Un test que falla a mitad de camino no deja la transacción abortada para
  // los siguientes.
  afterEach(async () => {
    await api.query("ROLLBACK");
  });

  afterAll(async () => {
    await api.end();
    await db.stop();
  });

  describe("el permiso inventory.decant:plan, por rol", () => {
    const CAN_PLAN = "SELECT app.has_permission('inventory.decant:plan') AS ok";

    it.each([
      ["owner", () => owner],
      ["manager", () => manager],
      ["vendedor", () => seller],
      ["deposito", () => warehouse],
    ])("%s planifica (lo tiene por seed)", async (_role, actor) => {
      const { rows } = await as(actor(), CAN_PLAN);

      expect(rows).toEqual([{ ok: true }]);
    });

    it("un rol que lee lotes y ejecuta decants, pero no tiene inventory.decant:plan, no planifica", async () => {
      const { rows } = await as(withoutPlan, CAN_PLAN);

      expect(rows).toEqual([{ ok: false }]);
    });

    it("el vendedor no obtiene inventory.stock:read por planificar: sigue sin ver ni un lote", async () => {
      const lots = await as(seller, "SELECT count(*)::int AS n FROM app.inventory_lots");

      expect(lots.rows).toEqual([{ n: 0 }]);
    });
  });

  describe("list_decant_plan_lots: lo que devuelve", () => {
    it("el vendedor, sin ver ningún lote, recibe los candidatos del granel: el abierto más antiguo primero y, a igual apertura, el id", async () => {
      const { rows } = await as(seller, CANDIDATES_OF(OWN_BULK_VARIANT_ID));

      expect(rows).toEqual([
        { lot_id: OLDEST_LOT_ID, available: "50.000", opened_at: new Date("2025-12-01T10:00:00Z") },
        { lot_id: TIED_LOT_A_ID, available: "30.000", opened_at: new Date("2026-01-01T10:00:00Z") },
        { lot_id: TIED_LOT_B_ID, available: "40.000", opened_at: new Date("2026-01-01T10:00:00Z") },
      ]);
    });

    it("no devuelve el abierto sin saldo, el que está en cuarentena ni el granel todavía sin abrir", async () => {
      const { rows } = await as(seller, CANDIDATES_OF(OWN_BULK_VARIANT_ID));
      const ids = rows.map((row) => row.lot_id);

      expect(ids).not.toContain(EMPTY_LOT_ID);
      expect(ids).not.toContain(QUARANTINE_LOT_ID);
      expect(ids).not.toContain(UNOPENED_LOT_ID);
    });

    it("devuelve exactamente lot_id, available y opened_at: ningún costo, proveedor ni fecha de recepción", async () => {
      const { fields, rows } = await as(seller, CANDIDATES_OF(OWN_BULK_VARIANT_ID));

      expect({
        columns: fields.map((field) => field.name),
        costInPayload: JSON.stringify(rows).includes(String(OWN_LOT_UNIT_COST)),
      }).toEqual({ columns: ["lot_id", "available", "opened_at"], costInPayload: false });
    });

    it("para un insumo devuelve sus lotes disponibles con saldo, sin el vacío ni el de cuarentena, y sin costo", async () => {
      const { rows } = await as(seller, CANDIDATES_OF(OWN_SUPPLY_VARIANT_ID));

      expect(rows).toEqual([{ lot_id: SUPPLY_LOT_ID, available: "100.000", opened_at: null }]);
      expect(JSON.stringify(rows)).not.toContain(String(OWN_SUPPLY_UNIT_COST));
    });

    it("el estado lo decide el tipo de la variante, no quien llama: la del smoke devuelve su único granel abierto", async () => {
      const { rows } = await as(seller, CANDIDATES_OF(SMOKE_BULK_VARIANT_ID));

      expect(rows.map((row) => row.lot_id)).toEqual([SMOKE_BULK_LOT_ID]);
    });

    it.each([
      ["depósito", () => warehouse],
      ["encargado", () => manager],
      ["dueño", () => owner],
    ])("el %s también la usa", async (_role, actor) => {
      const { rows } = await as(actor(), CANDIDATES_OF(OWN_BULK_VARIANT_ID));

      expect(rows.map((row) => row.lot_id)).toEqual([OLDEST_LOT_ID, TIED_LOT_A_ID, TIED_LOT_B_ID]);
    });

    it("no escribe nada: el saldo del lote es el mismo antes y después de llamarla", async () => {
      const before = await as(
        owner,
        `SELECT on_hand FROM app.inventory_balances WHERE lot_id = '${OLDEST_LOT_ID}'`,
      );
      await api.query(CANDIDATES_OF(OWN_BULK_VARIANT_ID));
      const after = await api.query(
        `SELECT on_hand FROM app.inventory_balances WHERE lot_id = '${OLDEST_LOT_ID}'`,
      );

      expect({ before: before.rows, after: after.rows }).toEqual({
        before: [{ on_hand: "50.000" }],
        after: [{ on_hand: "50.000" }],
      });
    });
  });

  describe("list_decant_plan_lots: falla cerrado, no devuelve un vacío", () => {
    const MISSING_PERMISSION = /^Falta el permiso inventory\.decant:plan/;

    it("sin inventory.decant:plan rechaza (42501), aunque el rol lea lotes y ejecute decants", async () => {
      await expect(as(withoutPlan, CANDIDATES_OF(OWN_BULK_VARIANT_ID))).rejects.toMatchObject({
        code: "42501",
        message: expect.stringMatching(MISSING_PERMISSION),
      });
    });

    it("con una audiencia que no es staff rechaza, aunque el usuario tenga el permiso y una sesión viva", async () => {
      await api.query("BEGIN");
      await actAs(seller, REAL_TENANT_ID, "system");

      await expect(api.query(CANDIDATES_OF(OWN_BULK_VARIANT_ID))).rejects.toMatchObject({
        code: "42501",
        message: expect.stringMatching(MISSING_PERMISSION),
      });
    });

    it("con una sesión que no existe, o sin sesión, rechaza", async () => {
      await api.query("BEGIN");
      await actAs({ userId: seller.userId, sessionId: "b18a0000-0000-0000-0000-0000000000ff" });
      const missing = await api.query(CANDIDATES_OF(OWN_BULK_VARIANT_ID)).catch((e: unknown) => e);
      await api.query("ROLLBACK");

      await api.query("BEGIN");
      await actAs({ userId: seller.userId, sessionId: "" });
      const none = await api.query(CANDIDATES_OF(OWN_BULK_VARIANT_ID)).catch((e: unknown) => e);

      expect({
        missing: (missing as { code?: string }).code,
        none: (none as { code?: string }).code,
      }).toEqual({
        missing: "42501",
        none: "42501",
      });
    });

    it("con la sesión de otro usuario rechaza: el user_id equivocado no hereda el permiso", async () => {
      await api.query("BEGIN");
      await actAs({ userId: withoutPlan.userId, sessionId: seller.sessionId });

      await expect(api.query(CANDIDATES_OF(OWN_BULK_VARIANT_ID))).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("sin tenant en el contexto rechaza (42501): una SECURITY DEFINER sin tenant no filtraría nada", async () => {
      await api.query("BEGIN");
      await actAs(seller, "");

      await expect(api.query(CANDIDATES_OF(OWN_BULK_VARIANT_ID))).rejects.toMatchObject({
        code: "42501",
        message: expect.stringMatching(/^No hay tenant en el contexto/),
      });
    });

    it("sin ningún contexto de sesión (nada fijado) rechaza", async () => {
      await api.query("BEGIN");

      await expect(api.query(CANDIDATES_OF(OWN_BULK_VARIANT_ID))).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("sin variante rechaza (22004)", async () => {
      await expect(
        as(seller, "SELECT * FROM app.list_decant_plan_lots(NULL)"),
      ).rejects.toMatchObject({ code: "22004" });
    });

    it("con una variante que no existe en el tenant rechaza (P0002), no devuelve un vacío", async () => {
      await expect(
        as(seller, CANDIDATES_OF("b1890000-0000-0000-0000-0000000000ff")),
      ).rejects.toMatchObject({ code: "P0002" });
    });
  });

  describe("list_decant_plan_lots: aislamiento por tenant", () => {
    it("el dueño de otro tenant, con todos los permisos, no obtiene los lotes de una variante que no es suya (P0002)", async () => {
      await expect(
        as(peerOwner, CANDIDATES_OF(OWN_BULK_VARIANT_ID), PEER_TENANT_ID),
      ).rejects.toMatchObject({ code: "P0002" });
    });

    it("y al revés: el vendedor del tenant real no obtiene los lotes del vecino (P0002)", async () => {
      await expect(as(seller, CANDIDATES_OF(PEER_BULK_VARIANT_ID))).rejects.toMatchObject({
        code: "P0002",
      });
    });

    it("el dueño del vecino recibe solo su propio granel, no el del tenant real", async () => {
      const { rows } = await as(peerOwner, CANDIDATES_OF(PEER_BULK_VARIANT_ID), PEER_TENANT_ID);

      expect(rows.map((row) => row.lot_id)).toEqual([PEER_BULK_LOT_ID]);
    });
  });

  // En una SECURITY DEFINER sin `search_path` fijo, `pg_temp` se busca primero
  // (WP-B10, verificado como joda_api sobre has_permission). Tablas temporales
  // falsas, con `pg_temp` primero en el `search_path` de la sesión.
  describe("list_decant_plan_lots: una sombra en pg_temp no cambia nada", () => {
    const SHADOW = `
      CREATE TEMP TABLE role_permissions (LIKE app.role_permissions);
      CREATE TEMP TABLE staff_user_roles (LIKE app.staff_user_roles);
      CREATE TEMP TABLE staff_sessions (LIKE app.staff_sessions);
      CREATE TEMP TABLE inventory_lots (LIKE app.inventory_lots);
      CREATE TEMP TABLE inventory_balances (LIKE app.inventory_balances);
      CREATE TEMP TABLE product_variants (LIKE app.product_variants);
      SET LOCAL search_path = pg_temp, app, public;`;

    it("un permiso otorgado solo en una sombra de role_permissions no lo concede", async () => {
      await api.query("BEGIN");
      await api.query(SHADOW);
      await api.query(
        `INSERT INTO pg_temp.role_permissions (tenant_id, role_id, permission_code)
         SELECT tenant_id, role_id, 'inventory.decant:plan' FROM app.role_permissions
          WHERE permission_code = 'inventory.decant:execute' LIMIT 1`,
      );
      await actAs(withoutPlan);

      await expect(api.query(CANDIDATES_OF(OWN_BULK_VARIANT_ID))).rejects.toMatchObject({
        code: "42501",
        message: expect.stringMatching(/^Falta el permiso inventory\.decant:plan/),
      });
    });

    it("una sombra vacía de los lotes, los saldos y las variantes no esconde el granel real", async () => {
      await api.query("BEGIN");
      await api.query(SHADOW);
      await actAs(seller);
      const { rows } = await api.query(CANDIDATES_OF(OWN_BULK_VARIANT_ID));

      expect(rows.map((row) => row.lot_id)).toEqual([OLDEST_LOT_ID, TIED_LOT_A_ID, TIED_LOT_B_ID]);
    });
  });

  describe("quién puede ejecutar la función", () => {
    it("el storefront (joda_readonly) no la ejecuta: es de la API", async () => {
      await db.client.query("BEGIN");
      try {
        await db.client.query("SET LOCAL ROLE joda_readonly");
        // El mensaje importa: con la función ejecutable por PUBLIC, esta misma
        // llamada (sin contexto de sesión) también da 42501, pero por la falta de
        // tenant y no por el privilegio.
        await expect(db.client.query(CANDIDATES_OF(OWN_BULK_VARIANT_ID))).rejects.toMatchObject({
          code: "42501",
          message: "permission denied for function list_decant_plan_lots",
        });
      } finally {
        await db.client.query("ROLLBACK");
      }
    });
  });

  // H3: la `Idempotency-Key` es opcional y la elige el cliente, así que no puede
  // garantizar «una orden por línea»; lo garantiza un índice único parcial.
  describe("una orden de fraccionamiento activa por línea de venta (H3)", () => {
    const ACTIVE_LINE_INDEX = "decant_wo_one_active_per_line";

    it.each([["pending"], ["in_progress"]])(
      "una segunda orden para la misma línea, con la primera %s, la rechaza el índice (23505)",
      async (status) => {
        await as(seller, INSERT_ORDER(LINE(LINE_A_ID), status));

        await expect(api.query(INSERT_ORDER(LINE(LINE_A_ID)))).rejects.toMatchObject({
          code: "23505",
          constraint: ACTIVE_LINE_INDEX,
        });
      },
    );

    it("también con la primera ya ejecutada (done): una línea ejecutada no se replanifica", async () => {
      await as(seller, INSERT_ORDER(LINE(LINE_A_ID)));
      await api.query(
        `UPDATE app.decant_work_orders
            SET status = 'in_progress' WHERE sale_order_line_id = '${LINE_A_ID}'`,
      );
      await api.query(
        `UPDATE app.decant_work_orders
            SET status = 'done', waste_actual = 0.200, executed_at = now(),
                executed_by = '${seller.userId}'
          WHERE sale_order_line_id = '${LINE_A_ID}'`,
      );

      await expect(api.query(INSERT_ORDER(LINE(LINE_A_ID)))).rejects.toMatchObject({
        code: "23505",
        constraint: ACTIVE_LINE_INDEX,
      });
    });

    it("cancelar la orden permite replanificar la línea, y se puede cancelar y replanificar otra vez", async () => {
      await as(seller, INSERT_ORDER(LINE(LINE_A_ID)));
      const cancelFirst = await api.query(
        `UPDATE app.decant_work_orders SET status = 'cancelled'
          WHERE sale_order_line_id = '${LINE_A_ID}' AND status = 'pending'`,
      );
      const second = await api.query(INSERT_ORDER(LINE(LINE_A_ID)));
      const cancelSecond = await api.query(
        `UPDATE app.decant_work_orders SET status = 'cancelled'
          WHERE sale_order_line_id = '${LINE_A_ID}' AND status = 'pending'`,
      );
      const third = await api.query(INSERT_ORDER(LINE(LINE_A_ID)));

      expect({
        cancelFirst: cancelFirst.rowCount,
        second: second.rowCount,
        cancelSecond: cancelSecond.rowCount,
        third: third.rowCount,
      }).toEqual({ cancelFirst: 1, second: 1, cancelSecond: 1, third: 1 });
    });

    it("dos líneas distintas de un mismo pedido tienen cada una su orden", async () => {
      await as(seller, INSERT_ORDER(LINE(LINE_A_ID)));
      const other = await api.query(INSERT_ORDER(LINE(LINE_B_ID)));

      expect(other.rowCount).toBe(1);
    });

    it("las órdenes sin línea (decants para stock) conviven: un NULL no choca en un índice único", async () => {
      await as(seller, INSERT_ORDER("NULL"));
      const second = await api.query(INSERT_ORDER("NULL"));
      const third = await api.query(INSERT_ORDER("NULL"));

      expect([second.rowCount, third.rowCount]).toEqual([1, 1]);
    });

    it("la orden del smoke ya tiene su línea: la fila sembrada ocupa el lugar de la línea del smoke", async () => {
      await expect(
        as(seller, INSERT_ORDER(LINE("cccccccc-0000-0000-0000-00000000000a"))),
      ).rejects.toMatchObject({ code: "23505", constraint: ACTIVE_LINE_INDEX });
    });
  });
});
