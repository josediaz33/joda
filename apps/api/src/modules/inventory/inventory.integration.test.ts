import { PrismaClient } from "@joda/db";
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
// simulacros de Prisma"), mismo arnés que catalog.integration.test.ts
// (WP-C08). Cubre de punta a punta RF-INV-03…05 (WP-C10), RF-INV-08 (apertura
// de frasco, WP-C11) y RF-INV-10 (unidades serializadas, WP-C12), en
// docs/backlog.md — las validaciones de forma de los inputs (qty en cero,
// motivo vacío, precisión decimal, serial vacío) ya están cubiertas sin
// Postgres en packages/contracts/src/inventory.test.ts.
const TENANT_ID = "77777777-7777-4777-a777-777777777777";
const STAFF_OWNER_ID = "99999999-9999-4999-a999-999999999992";
const STAFF_OWNER_EMAIL = "owner@jodaparfums-c10.com";
const STAFF_PASSWORD = "correcta";
const MFA_ENCRYPTION_KEY = Buffer.from("2".repeat(64), "hex");
const PLACEHOLDER_MFA_SECRET = "placeholder-nunca-se-descifra-en-este-test";

function createManualClock(initial: Date): Clock {
  return { now: () => initial };
}

function toRequestCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("se esperaba un header Set-Cookie en la respuesta");
  const separator = raw.indexOf(";");
  return separator === -1 ? raw : raw.slice(0, separator);
}

describe("módulo inventario · WP-C10 (RF-INV-03…05), WP-C11 (RF-INV-08) y WP-C12 (RF-INV-10)", () => {
  let testDb: TestDb;
  let redisContainer: StartedRedisContainer;
  let db: PrismaClient;
  let redis: Redis;
  let app: FastifyInstance;
  let cookie: string;

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

  async function mutate(procedure: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/trpc/${procedure}`,
      headers: { cookie },
      payload,
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
       VALUES ($1, 'joda-c10', 'JODA Parfums SRL', 'JODA Parfums')`,
      [TENANT_ID],
    );
    await testDb.superuserClient.query(`SELECT app.seed_roles($1)`, [TENANT_ID]);
    await testDb.superuserClient.query(
      `INSERT INTO app.staff_users
         (id, tenant_id, auth_subject, email, full_name, is_active, mfa_enrolled, mfa_secret_encrypted)
       VALUES ($1, $2, 'auth|owner-c10', $3, 'Test Owner', true, true, $4)`,
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
        new Map([[STAFF_OWNER_EMAIL, { password: STAFF_PASSWORD, authSubject: "auth|owner-c10" }]]),
      ),
      // Fijo y FUTURO a propósito (WP-B13). La sesión nace con
      // `expires_at` = este reloj + 8 h, y `app.has_permission()` la compara
      // contra el `now()` real de Postgres, que no se inyecta. Con un reloj
      // en el pasado la sesión nace vencida para la base, y `inventory_lots`
      // (política `inventory.stock:read`) se vuelve invisible: 404.
      clock: createManualClock(new Date("2099-01-01T12:00:00.000Z")),
      mfaEncryptionKey: MFA_ENCRYPTION_KEY,
    };
    app = buildServer(authDeps, "0".repeat(32));

    const loginResponse = await app.inject({
      method: "POST",
      url: "/trpc/auth.session.login",
      payload: { email: STAFF_OWNER_EMAIL, password: STAFF_PASSWORD },
    });
    cookie = toRequestCookie(loginResponse.headers["set-cookie"]);

    await testDb.superuserClient.query(
      `UPDATE app.staff_sessions SET mfa_verified_at = now()
       WHERE id = (
         SELECT s.id FROM app.staff_sessions s
         JOIN app.staff_users u ON u.id = s.staff_user_id
         WHERE u.email = $1 AND s.revoked_at IS NULL
         ORDER BY s.created_at DESC LIMIT 1
       )`,
      [STAFF_OWNER_EMAIL],
    );
    await redis.flushall();
  });

  afterEach(async () => {
    await app.close();
    await redis.flushall();
    redis.disconnect();
  });

  // Ni goods_receipt (WP-C15) ni lot.open (WP-C11) existen todavía — el lote
  // y su recepción inicial se insertan directo por SQL, como hace
  // catalog.integration.test.ts con staff_users. El producto/variante sí
  // salen de la API real de catálogo (WP-C08), ya montada en el mismo router.
  async function seedSealedLot(
    variantId: string,
    { qtyInitial, unitCostPyg }: { qtyInitial: number; unitCostPyg: number },
  ): Promise<string> {
    // $4 y $6 llevan el mismo valor JS pero NO pueden ser el mismo parámetro:
    // unit_cost_minor es dominio `minor_amount` y unit_landed_cost_pyg es
    // dominio `pyg` (packages/db/migrations/0004_inventory.sql) — dos
    // dominios distintos sobre bigint. `pg` intenta unificar el tipo de un
    // mismo `$n` reusado en columnas de tipos distintos y falla con
    // "inconsistent types deduced for parameter $4" si se reusa acá.
    const lot = await testDb.superuserClient.query(
      `INSERT INTO app.inventory_lots
         (tenant_id, variant_id, status, qty_initial, uom,
          unit_cost_minor, currency, fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
       VALUES ($1, $2, 'available', $3, 'unit', $4, 'PYG', 1, $5, $6)
       RETURNING id`,
      [TENANT_ID, variantId, qtyInitial, unitCostPyg, qtyInitial * unitCostPyg, unitCostPyg],
    );
    const lotId = lot.rows[0].id;
    await testDb.superuserClient.query(
      `INSERT INTO app.inventory_movements
         (tenant_id, lot_id, variant_id, qty, uom, movement_type, total_cost_pyg, created_by)
       VALUES ($1, $2, $3, $4, 'unit', 'purchase_receipt', $5, $6)`,
      [TENANT_ID, lotId, variantId, qtyInitial, qtyInitial * unitCostPyg, STAFF_OWNER_ID],
    );
    return lotId;
  }

  async function seedBulkLot(
    variantId: string,
    { qtyInitial, unitCostPyg }: { qtyInitial: number; unitCostPyg: number },
  ): Promise<string> {
    const lot = await testDb.superuserClient.query(
      `INSERT INTO app.inventory_lots
         (tenant_id, variant_id, status, qty_initial, uom,
          unit_cost_minor, currency, fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
       VALUES ($1, $2, 'available', $3, 'ml', $4, 'PYG', 1, $5, $6)
       RETURNING id`,
      [
        TENANT_ID,
        variantId,
        qtyInitial,
        unitCostPyg,
        Math.round(qtyInitial * unitCostPyg),
        unitCostPyg,
      ],
    );
    const lotId = lot.rows[0].id;
    await testDb.superuserClient.query(
      `INSERT INTO app.inventory_movements
         (tenant_id, lot_id, variant_id, qty, uom, movement_type, total_cost_pyg, created_by)
       VALUES ($1, $2, $3, $4, 'ml', 'purchase_receipt', $5, $6)`,
      [
        TENANT_ID,
        lotId,
        variantId,
        qtyInitial,
        Math.round(qtyInitial * unitCostPyg),
        STAFF_OWNER_ID,
      ],
    );
    return lotId;
  }

  async function createSealedVariant(): Promise<string> {
    const category = await mutateOk<{ id: string }>("catalog.category.create", {
      slug: `perfumeria-${Date.now()}`,
      name: "Perfumería",
    });
    const product = await mutateOk<{ id: string }>("catalog.product.create", {
      kind: "perfume",
      slug: `layton-${Date.now()}`,
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
    const variant = await mutateOk<{ id: string }>("catalog.variant.create", {
      productId: product.id,
      sku: `SKU-SEALED-${Date.now()}`,
      variantType: "sealed",
      uom: "unit",
      sizeMl: 100,
      pricePyg: "500000",
    });
    return variant.id;
  }

  async function createBulkVariant(): Promise<string> {
    const category = await mutateOk<{ id: string }>("catalog.category.create", {
      slug: `granel-${Date.now()}`,
      name: "Granel",
    });
    const product = await mutateOk<{ id: string }>("catalog.product.create", {
      kind: "perfume",
      slug: `layton-granel-${Date.now()}`,
      name: "Layton granel",
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
    const variant = await mutateOk<{ id: string }>("catalog.variant.create", {
      productId: product.id,
      sku: `SKU-BULK-${Date.now()}`,
      variantType: "bulk",
      uom: "ml",
      sizeMl: null,
      pricePyg: "0",
    });
    return variant.id;
  }

  it("RF-INV-03 · una variante sin ningún lote todavía da saldo cero, no un error", async () => {
    const variantId = await createSealedVariant();

    const availability = await call<{
      variantId: string;
      onHand: number;
      reserved: number;
      available: number;
    }>("inventory.stock.available", { variantId });

    expect(availability).toEqual({ variantId, onHand: 0, reserved: 0, available: 0 });
  });

  it("RF-INV-03 · una variante inexistente (o de otro tenant) da 404, no un saldo cero (revisión cruzada)", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/trpc/inventory.stock.available?input=${encodeURIComponent(
        JSON.stringify({ variantId: "00000000-0000-4000-a000-000000000000" }),
      )}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it("RF-INV-03 · el saldo disponible refleja la recepción inicial del lote", async () => {
    const variantId = await createSealedVariant();
    await seedSealedLot(variantId, { qtyInitial: 100, unitCostPyg: 50_000 });

    const availability = await call<{
      variantId: string;
      onHand: number;
      reserved: number;
      available: number;
    }>("inventory.stock.available", { variantId });

    expect(availability).toEqual({ variantId, onHand: 100, reserved: 0, available: 100 });
  });

  it("RF-INV-04 · un ajuste positivo (recuento halló más stock) no registra ninguna capa de costo", async () => {
    const variantId = await createSealedVariant();
    const lotId = await seedSealedLot(variantId, { qtyInitial: 100, unitCostPyg: 50_000 });

    const movement = await mutateOk<{ qty: number; totalCostPyg: string | null; note: string }>(
      "inventory.adjustment.create",
      { lotId, qty: 5, reason: "conteo físico halló 5 unidades más" },
    );

    expect(movement.qty).toBe(5);
    expect(movement.totalCostPyg).toBeNull();
    expect(movement.note).toBe("conteo físico halló 5 unidades más");

    const availability = await call<{ onHand: number }>("inventory.stock.available", { variantId });
    expect(availability.onHand).toBe(105);
  });

  it("RF-INV-04 · un ajuste negativo (salida) registra su capa de costo con el costo puesto del lote", async () => {
    const variantId = await createSealedVariant();
    const lotId = await seedSealedLot(variantId, { qtyInitial: 100, unitCostPyg: 50_000 });

    const movement = await mutateOk<{ qty: number; totalCostPyg: string | null; note: string }>(
      "inventory.adjustment.create",
      { lotId, qty: -10, reason: "rotura en depósito" },
    );

    expect(movement.qty).toBe(-10);
    expect(movement.totalCostPyg).toBe("-500000");
    expect(movement.note).toBe("rotura en depósito");

    const availability = await call<{ onHand: number }>("inventory.stock.available", { variantId });
    expect(availability.onHand).toBe(90);
  });

  it("Caso borde #16 · un ajuste que dejaría el saldo negativo se rechaza y no cambia el saldo", async () => {
    const variantId = await createSealedVariant();
    const lotId = await seedSealedLot(variantId, { qtyInitial: 100, unitCostPyg: 50_000 });

    const response = await mutate("inventory.adjustment.create", {
      lotId,
      qty: -150,
      reason: "recuento erróneo",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.data.appCode).toBe("CONFLICT_INSUFFICIENT_STOCK");

    const availability = await call<{ onHand: number }>("inventory.stock.available", { variantId });
    expect(availability.onHand).toBe(100);
  });

  it("un ajuste con decimales sobre un lote en unit se rechaza (RN-LOT-01: unit es siempre entero)", async () => {
    const variantId = await createSealedVariant();
    const lotId = await seedSealedLot(variantId, { qtyInitial: 100, unitCostPyg: 50_000 });

    const response = await mutate("inventory.adjustment.create", {
      lotId,
      qty: 2.5,
      reason: "no debería aceptarse",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.data.appCode).toBe("VALIDATION_QTY_MUST_BE_INTEGER");
  });

  it("RF-INV-04 · un ajuste negativo con decimales sobre un lote en ml se acepta y valoriza a prorrata", async () => {
    const variantId = await createBulkVariant();
    const lotId = await seedBulkLot(variantId, { qtyInitial: 1000, unitCostPyg: 12_000 });

    const movement = await mutateOk<{ qty: number; totalCostPyg: string | null }>(
      "inventory.adjustment.create",
      { lotId, qty: -12.5, reason: "merma de trasvase" },
    );

    expect(movement.qty).toBe(-12.5);
    expect(movement.totalCostPyg).toBe("-150000");
  });

  it("RF-INV-05 · el historial del lote trae la recepción inicial y el ajuste posterior, con costo y motivo", async () => {
    const variantId = await createSealedVariant();
    const lotId = await seedSealedLot(variantId, { qtyInitial: 100, unitCostPyg: 50_000 });
    await mutateOk("inventory.adjustment.create", {
      lotId,
      qty: -10,
      reason: "rotura en depósito",
    });

    const history = await call<{
      lot: { id: string; onHand: number; uom: string };
      movements: {
        movementType: string;
        qty: number;
        totalCostPyg: string | null;
        note: string | null;
      }[];
    }>("inventory.lot.history", { lotId });

    expect(history.lot.id).toBe(lotId);
    expect(history.lot.uom).toBe("unit");
    expect(history.lot.onHand).toBe(90);
    expect(history.movements).toHaveLength(2);
    expect(history.movements[0]).toMatchObject({
      movementType: "purchase_receipt",
      qty: 100,
      totalCostPyg: "5000000",
    });
    expect(history.movements[1]).toMatchObject({
      movementType: "adjustment",
      qty: -10,
      totalCostPyg: "-500000",
      note: "rotura en depósito",
    });
  });

  it("RF-INV-05 · un lote inexistente (o de otro tenant) da 404, no un error genérico", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/trpc/inventory.lot.history?input=${encodeURIComponent(
        JSON.stringify({ lotId: "00000000-0000-4000-a000-000000000000" }),
      )}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
  });

  // -------------------------------------------------------------------
  // WP-C11 — apertura de frasco (RF-INV-08, RN-LOT-02/03, ADR-009).
  // -------------------------------------------------------------------
  // Un producto con su variante sellada Y su granel — la apertura necesita
  // las dos en el MISMO producto (índice único parcial de 0028). El volumen
  // nominal es 100 ml (`createSealedVariant` de arriba usa el mismo).
  let productCounter = 0;
  async function createSealedAndBulkVariants(): Promise<{
    sealedVariantId: string;
    bulkVariantId: string;
    productId: string;
  }> {
    const suffix = `${Date.now()}-${++productCounter}`;
    const category = await mutateOk<{ id: string }>("catalog.category.create", {
      slug: `apertura-${suffix}`,
      name: "Apertura",
    });
    const product = await mutateOk<{ id: string }>("catalog.product.create", {
      kind: "perfume",
      slug: `layton-apertura-${suffix}`,
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
    const sealed = await mutateOk<{ id: string }>("catalog.variant.create", {
      productId: product.id,
      sku: `SKU-APERTURA-SEALED-${suffix}`,
      variantType: "sealed",
      uom: "unit",
      sizeMl: 100,
      pricePyg: "500000",
    });
    const bulk = await mutateOk<{ id: string }>("catalog.variant.create", {
      productId: product.id,
      sku: `SKU-APERTURA-BULK-${suffix}`,
      variantType: "bulk",
      uom: "ml",
      sizeMl: null,
      pricePyg: "0",
    });
    return { sealedVariantId: sealed.id, bulkVariantId: bulk.id, productId: product.id };
  }

  /** Una venta de `qty` frascos del lote, escrita como superusuario: la API de ventas (WP-C19) todavía no existe. */
  async function sellSealed(lotId: string, variantId: string, qty: number, unitCostPyg: number) {
    await testDb.superuserClient.query(
      `INSERT INTO app.inventory_movements
         (tenant_id, lot_id, variant_id, qty, uom, movement_type, total_cost_pyg, created_by)
       VALUES ($1, $2, $3, $4, 'unit', 'sale', $5, $6)`,
      [TENANT_ID, lotId, variantId, -qty, qty * unitCostPyg, STAFF_OWNER_ID],
    );
  }

  type OpenedLot = import("@joda/contracts").OpenLotOutput;

  it("RN-LOT-02 · un lote de una unidad se abre directo: el sellado queda abierto y nace el granel con el costo de un frasco, sin separar nada", async () => {
    const { sealedVariantId, bulkVariantId } = await createSealedAndBulkVariants();
    const lotId = await seedSealedLot(sealedVariantId, { qtyInitial: 1, unitCostPyg: 1_496_500 });

    const opened = await mutateOk<OpenedLot>("inventory.lot.open", { lotId });

    expect(opened.sourceLot).toBeNull();
    expect(opened.openedSealedLot).toMatchObject({
      id: lotId,
      status: "open_for_decant",
      qtyInitial: 1,
      onHand: 0,
    });
    expect(opened.bulkLot).toMatchObject({
      variantId: bulkVariantId,
      parentLotId: lotId,
      status: "open_for_decant",
      uom: "ml",
      qtyInitial: 100,
      onHand: 100,
      landedCostPyg: "1496500",
      unitLandedCostPyg: "14965",
      // Por ml: 1.496.500 Gs. por frasco sobre 100 ml.
      unitCost: { minor: "14965", currency: "PYG" },
    });
    expect(opened.movements.map((m) => [m.movementType, m.qty, m.referenceType])).toEqual([
      ["transfer_out", -1, "lot_opening"],
      ["transfer_in", 100, "lot_opening"],
    ]);
  });

  it("RN-LOT-02 paso 3 · una compra en USD: el granel lleva el costo de compra por ml en USD, y el costo en guaraníes sigue saliendo de los campos en guaraníes", async () => {
    const { sealedVariantId } = await createSealedAndBulkVariants();
    const lotId = await seedSealedLot(sealedVariantId, { qtyInitial: 1, unitCostPyg: 1_496_500 });
    // USD 190,00 el frasco (19.000 centavos), tipo de cambio 7.300.
    await testDb.superuserClient.query(
      `UPDATE app.inventory_lots
          SET currency = 'USD', unit_cost_minor = 19000, fx_rate_to_pyg = 7300
        WHERE id = $1`,
      [lotId],
    );

    const opened = await mutateOk<OpenedLot>("inventory.lot.open", { lotId });

    // 19.000 centavos sobre 100 ml: 190 centavos por ml, y por 100 vuelven a dar el frasco.
    expect(opened.bulkLot.unitCost).toEqual({ minor: "190", currency: "USD" });
    expect(opened.bulkLot.fxRateToPyg).toBe(7300);
    // El costo en guaraníes no depende de unit_cost_minor: es el del frasco sobre el volumen.
    expect(opened.bulkLot.landedCostPyg).toBe("1496500");
    expect(opened.bulkLot.unitLandedCostPyg).toBe("14965");
    expect(opened.openedSealedLot.unitCost).toEqual({ minor: "19000", currency: "USD" });
  });

  it("RN-LOT-02, caso borde 21 · un lote de tres frascos separa la unidad que se abre: el original sigue available con DOS frascos vendibles como sellados", async () => {
    const { sealedVariantId, bulkVariantId } = await createSealedAndBulkVariants();
    const lotId = await seedSealedLot(sealedVariantId, { qtyInitial: 3, unitCostPyg: 1_496_500 });

    const opened = await mutateOk<OpenedLot>("inventory.lot.open", { lotId });

    expect(opened.sourceLot).toMatchObject({
      id: lotId,
      status: "available",
      qtyInitial: 3,
      onHand: 2,
    });
    expect(opened.openedSealedLot).toMatchObject({
      status: "open_for_decant",
      qtyInitial: 1,
      onHand: 0,
      parentLotId: lotId,
      variantId: sealedVariantId,
      landedCostPyg: "1496500",
      unitCost: { minor: "1496500", currency: "PYG" },
    });
    expect(opened.sourceLot).toMatchObject({ unitCost: { minor: "1496500", currency: "PYG" } });
    expect(opened.bulkLot).toMatchObject({
      variantId: bulkVariantId,
      parentLotId: opened.openedSealedLot.id,
      qtyInitial: 100,
      landedCostPyg: "1496500",
      unitLandedCostPyg: "14965",
      unitCost: { minor: "14965", currency: "PYG" },
    });
    expect(opened.movements.map((m) => [m.movementType, m.qty, m.referenceType])).toEqual([
      ["transfer_out", -1, "lot_separation"],
      ["transfer_in", 1, "lot_separation"],
      ["transfer_out", -1, "lot_opening"],
      ["transfer_in", 100, "lot_opening"],
    ]);

    // Los dos frascos que quedan se siguen vendiendo como sellados: la base
    // no rechaza la venta (RN-LOT-03 solo alcanza al lote abierto).
    await expect(sellSealed(lotId, sealedVariantId, 2, 1_496_500)).resolves.toBeUndefined();
  });

  it("RN-LOT-02 · lote de 3, se venden 2, se abre el tercero: el granel cuesta lo de UN frasco (14.965 Gs./ml), no el del lote entero", async () => {
    const { sealedVariantId } = await createSealedAndBulkVariants();
    const lotId = await seedSealedLot(sealedVariantId, { qtyInitial: 3, unitCostPyg: 1_496_500 });
    await sellSealed(lotId, sealedVariantId, 2, 1_496_500);

    const opened = await mutateOk<OpenedLot>("inventory.lot.open", { lotId });

    // Sin la separación, el granel habría heredado los 4.489.500 del lote de
    // tres y costado 44.895 Gs./ml: el triple, sin que nada fallara.
    expect(opened.sourceLot).toMatchObject({ qtyInitial: 3, onHand: 0 });
    expect(opened.bulkLot.landedCostPyg).toBe("1496500");
    expect(opened.bulkLot.unitLandedCostPyg).toBe("14965");
  });

  it("ADR-008 · cada salida de la apertura registra su capa de costo, que cuadra con el movimiento, y el ledger no deriva de la proyección", async () => {
    const { sealedVariantId } = await createSealedAndBulkVariants();
    const lotId = await seedSealedLot(sealedVariantId, { qtyInitial: 3, unitCostPyg: 1_496_500 });
    await mutateOk<OpenedLot>("inventory.lot.open", { lotId });

    const layers = await testDb.superuserClient.query(
      `SELECT m.total_cost_pyg::text AS declared,
              COALESCE(sum(a.total_cost_pyg), 0)::text AS allocated
         FROM app.inventory_movements m
         LEFT JOIN app.movement_cost_allocations a ON a.movement_id = m.id
        WHERE m.movement_type = 'transfer_out'
          AND m.reference_type IN ('lot_separation', 'lot_opening')
          AND m.lot_id IN (SELECT id FROM app.inventory_lots
                            WHERE id = $1 OR parent_lot_id = $1)
        GROUP BY m.id ORDER BY m.id`,
      [lotId],
    );
    expect(layers.rows).toEqual([
      { declared: "1496500", allocated: "1496500" },
      { declared: "1496500", allocated: "1496500" },
    ]);

    const drift = await testDb.superuserClient.query(`SELECT * FROM app.v_balance_drift`);
    expect(drift.rows).toEqual([]);
  });

  it("caso borde 5 · abrir dos veces el mismo lote se rechaza, y no nace un segundo granel", async () => {
    const { sealedVariantId } = await createSealedAndBulkVariants();
    const lotId = await seedSealedLot(sealedVariantId, { qtyInitial: 1, unitCostPyg: 1_496_500 });
    await mutateOk<OpenedLot>("inventory.lot.open", { lotId });

    const second = await mutate("inventory.lot.open", { lotId });

    expect(second.statusCode).toBe(409);
    expect(second.json().error.data.appCode).toBe("CONFLICT_LOT_NOT_OPENABLE");
    const bulkLots = await testDb.superuserClient.query(
      `SELECT count(*)::int AS n FROM app.inventory_lots WHERE parent_lot_id = $1`,
      [lotId],
    );
    expect(bulkLots.rows[0].n).toBe(1);
  });

  it("caso borde 5 · dos aperturas simultáneas del mismo lote: una gana, la otra se rechaza, y hay un solo granel", async () => {
    const { sealedVariantId } = await createSealedAndBulkVariants();
    const lotId = await seedSealedLot(sealedVariantId, { qtyInitial: 1, unitCostPyg: 1_496_500 });

    const responses = await Promise.all([
      mutate("inventory.lot.open", { lotId }),
      mutate("inventory.lot.open", { lotId }),
    ]);

    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const bulkLots = await testDb.superuserClient.query(
      `SELECT count(*)::int AS n FROM app.inventory_lots WHERE parent_lot_id = $1`,
      [lotId],
    );
    expect(bulkLots.rows[0].n).toBe(1);
  });

  it("caso borde 5 · la apertura decide sobre el lote ya bloqueado: si otra transacción lo deja en cuarentena mientras espera, se rechaza", async () => {
    // Actualización perdida: otra transacción, sin confirmar todavía, deja el
    // lote en cuarentena. Sin el FOR UPDATE, la apertura leería el estado
    // viejo (`available`), abriría un lote en cuarentena y respondería 200
    // (verificado sacándolo). Con él, espera, relee y lo rechaza.
    const { sealedVariantId } = await createSealedAndBulkVariants();
    const lotId = await seedSealedLot(sealedVariantId, { qtyInitial: 1, unitCostPyg: 1_496_500 });

    await testDb.superuserClient.query("BEGIN");
    let released = false;
    try {
      await testDb.superuserClient.query(
        "UPDATE app.inventory_lots SET status = 'quarantine' WHERE id = $1",
        [lotId],
      );
      let settled = false;
      const pending = mutate("inventory.lot.open", { lotId }).then((response) => {
        settled = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);
      await testDb.superuserClient.query("COMMIT");
      released = true;

      const response = await pending;
      expect(response.statusCode).toBe(409);
      expect(response.json().error.data.appCode).toBe("CONFLICT_LOT_NOT_OPENABLE");
    } finally {
      if (!released) await testDb.superuserClient.query("ROLLBACK");
    }
    const children = await testDb.superuserClient.query(
      `SELECT count(*)::int AS n FROM app.inventory_lots WHERE parent_lot_id = $1`,
      [lotId],
    );
    expect(children.rows[0].n).toBe(0);
  });

  it("RN-LOT-02 · un lote sin frascos en saldo no se abre", async () => {
    const { sealedVariantId } = await createSealedAndBulkVariants();
    const lotId = await seedSealedLot(sealedVariantId, { qtyInitial: 1, unitCostPyg: 1_496_500 });
    await sellSealed(lotId, sealedVariantId, 1, 1_496_500);

    const response = await mutate("inventory.lot.open", { lotId });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.data.appCode).toBe("CONFLICT_INSUFFICIENT_STOCK");
  });

  it("RN-LOT-02 · el último frasco disponible de la variante, si está reservado, no se abre", async () => {
    const { sealedVariantId } = await createSealedAndBulkVariants();
    const lotId = await seedSealedLot(sealedVariantId, { qtyInitial: 1, unitCostPyg: 1_496_500 });
    await testDb.superuserClient.query(
      `INSERT INTO app.stock_reservations
         (tenant_id, variant_id, qty, reason, expires_at, created_by)
       VALUES ($1, $2, 1, 'checkout', now() + interval '1 hour', $3)`,
      [TENANT_ID, sealedVariantId, STAFF_OWNER_ID],
    );

    const response = await mutate("inventory.lot.open", { lotId });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.data.appCode).toBe("CONFLICT_INSUFFICIENT_STOCK");
    const lot = await call<{ lot: { status: string } }>("inventory.lot.history", { lotId });
    expect(lot.lot.status).toBe("available");
  });

  it("RN-LOT-02 · solo se abre un lote de una variante sellada: el granel se rechaza", async () => {
    const { bulkVariantId } = await createSealedAndBulkVariants();
    const bulkLotId = await seedBulkLot(bulkVariantId, { qtyInitial: 100, unitCostPyg: 14_965 });

    const response = await mutate("inventory.lot.open", { lotId: bulkLotId });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.data.appCode).toBe("CONFLICT_LOT_NOT_SEALED");
  });

  it("ADR-009 · un producto sin variante de granel no se abre, y el error manda a crearla en el catálogo", async () => {
    const sealedVariantId = await createSealedVariant();
    const lotId = await seedSealedLot(sealedVariantId, { qtyInitial: 1, unitCostPyg: 1_496_500 });

    const response = await mutate("inventory.lot.open", { lotId });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.data.appCode).toBe("CONFLICT_BULK_VARIANT_MISSING");
    expect(response.json().error.message).toContain("catálogo");
    const lot = await call<{ lot: { status: string } }>("inventory.lot.history", { lotId });
    expect(lot.lot.status).toBe("available");
  });

  it("RN-LOT-02 · un producto sin volumen nominal (no es un perfume) no se abre: no hay cuántos ml tiene el granel", async () => {
    // Sellado y granel del mismo producto, pero un accesorio: sin
    // `perfume_details.nominal_volume_ml` no se puede calcular el granel.
    const suffix = `${Date.now()}-${++productCounter}`;
    const category = await mutateOk<{ id: string }>("catalog.category.create", {
      slug: `sin-volumen-${suffix}`,
      name: "Sin volumen",
    });
    const product = await mutateOk<{ id: string }>("catalog.product.create", {
      kind: "accessory",
      slug: `accesorio-${suffix}`,
      name: "Accesorio",
      categoryIds: [category.id],
      primaryCategoryId: category.id,
      accessoryDetails: { material: null, color: null, sizeLabel: null },
    });
    const sealed = await mutateOk<{ id: string }>("catalog.variant.create", {
      productId: product.id,
      sku: `SKU-SIN-VOLUMEN-SEALED-${suffix}`,
      variantType: "sealed",
      uom: "unit",
      sizeMl: 100,
      pricePyg: "500000",
    });
    await mutateOk("catalog.variant.create", {
      productId: product.id,
      sku: `SKU-SIN-VOLUMEN-BULK-${suffix}`,
      variantType: "bulk",
      uom: "ml",
      sizeMl: null,
      pricePyg: "0",
    });
    const lotId = await seedSealedLot(sealed.id, { qtyInitial: 1, unitCostPyg: 1_496_500 });

    const response = await mutate("inventory.lot.open", { lotId });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.data.appCode).toBe("CONFLICT_NOMINAL_VOLUME_MISSING");
    const lot = await call<{ lot: { status: string } }>("inventory.lot.history", { lotId });
    expect(lot.lot.status).toBe("available");
  });

  it("ADR-009 · un producto tiene una sola variante de granel: una segunda se rechaza (índice de 0028)", async () => {
    const { productId } = await createSealedAndBulkVariants();

    const response = await mutate("catalog.variant.create", {
      productId,
      sku: `SKU-SEGUNDO-GRANEL-${Date.now()}`,
      variantType: "bulk",
      uom: "ml",
      sizeMl: null,
      pricePyg: "0",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.data.appCode).toBe("CONFLICT_BULK_VARIANT_EXISTS");
  });

  it("RN-LOT-02 · un lote inexistente (o de otro tenant) da 404", async () => {
    const response = await mutate("inventory.lot.open", {
      lotId: "00000000-0000-4000-a000-000000000000",
    });

    expect(response.statusCode).toBe(404);
  });

  it("docs/api-conventions.md §5 · repetir la apertura con la misma Idempotency-Key devuelve la respuesta original y no abre otro frasco", async () => {
    const { sealedVariantId } = await createSealedAndBulkVariants();
    const lotId = await seedSealedLot(sealedVariantId, { qtyInitial: 3, unitCostPyg: 1_496_500 });
    const send = () =>
      app.inject({
        method: "POST",
        url: "/trpc/inventory.lot.open",
        headers: { cookie, "idempotency-key": `apertura-${lotId}` },
        payload: { lotId },
      });

    const first = await send();
    const second = await send();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().result.data.bulkLot.id).toBe(first.json().result.data.bulkLot.id);
    const children = await testDb.superuserClient.query(
      `SELECT count(*)::int AS n FROM app.inventory_lots WHERE parent_lot_id = $1`,
      [lotId],
    );
    expect(children.rows[0].n).toBe(1);
  });

  // -------------------------------------------------------------------
  // WP-C12 — unidades serializadas (RF-INV-10, RN-SER-01…04).
  // -------------------------------------------------------------------
  // Un reloj: producto `watch` con una variante `unit` serializada.
  let watchCounter = 0;
  async function createSerializedVariant(): Promise<string> {
    const suffix = `${Date.now()}-${++watchCounter}`;
    const category = await mutateOk<{ id: string }>("catalog.category.create", {
      slug: `relojes-${suffix}`,
      name: "Relojes",
    });
    const product = await mutateOk<{ id: string }>("catalog.product.create", {
      kind: "watch",
      slug: `reloj-${suffix}`,
      name: "Reloj automático",
      categoryIds: [category.id],
      primaryCategoryId: category.id,
      watchDetails: {
        movement: "automatic",
        caseMaterial: "acero",
        caseDiameterMm: 40,
        waterResistanceM: 100,
        strapMaterial: null,
        crystal: "zafiro",
        warrantyMonths: 24,
        requiresSerial: true,
      },
    });
    const variant = await mutateOk<{ id: string }>("catalog.variant.create", {
      productId: product.id,
      sku: `SKU-RELOJ-${suffix}`,
      variantType: "unit",
      uom: "unit",
      sizeMl: null,
      pricePyg: "3000000",
      isSerialized: true,
    });
    return variant.id;
  }

  /**
   * Prueba que `request` toma el bloqueo del lote ANTES de leer. Otra
   * transacción tiene el lote con `FOR NO KEY UPDATE`: la petición tiene que
   * quedarse esperando mientras dure, y completarse recién al soltarlo.
   *
   * Es `NO KEY UPDATE` y no `UPDATE` a propósito: el `INSERT` de una unidad
   * toma `FOR KEY SHARE` sobre el lote por la FK, y `FOR UPDATE` lo haría
   * esperar ahí aunque la petición no hubiera tomado su propio bloqueo (lo
   * verifiqué sacándolo). Con `NO KEY UPDATE` la FK no espera, así que solo
   * una petición que bloquea el lote antes de contar queda detenida. Dos
   * peticiones simultáneas no alcanzan como prueba: se ordenan solas.
   * Devuelve el status HTTP con el que terminó.
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

  /** Espera a que una petición quede detenida en un bloqueo de fila: sin esto, sondear «todavía no terminó» daría falso verde. */
  async function waitUntilABackendIsBlockedOnALock(): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt++) {
      // Dentro de una transacción, pg_stat_activity devuelve la foto del primer
      // acceso: sin descartarla nunca se ve el cambio.
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

  type SerialUnit = import("@joda/contracts").AdminSerializedUnit;

  function createSerial(lotId: string, serialNumber: string, extra: Record<string, unknown> = {}) {
    return mutate("inventory.serial.create", { lotId, serialNumber, ...extra });
  }

  it("RF-INV-10 · el alta registra la unidad con la variante de su lote, la garantía y sin venta todavía", async () => {
    const variantId = await createSerializedVariant();
    const lotId = await seedSealedLot(variantId, { qtyInitial: 3, unitCostPyg: 1_500_000 });

    const response = await createSerial(lotId, "  SN-ALTA-001  ", { warrantyUntil: "2028-03-10" });

    expect(response.statusCode).toBe(200);
    expect(response.json().result.data).toMatchObject({
      variantId,
      lotId,
      serialNumber: "SN-ALTA-001",
      status: "available",
      warrantyUntil: "2028-03-10",
      soldOrderLineId: null,
      notes: null,
    });
  });

  it("RN-SER-01 · el número de serie es único por tenant: repetirlo en el mismo tenant se rechaza, aunque sea en otro lote", async () => {
    const variantId = await createSerializedVariant();
    const lotA = await seedSealedLot(variantId, { qtyInitial: 2, unitCostPyg: 1_500_000 });
    const lotB = await seedSealedLot(variantId, { qtyInitial: 2, unitCostPyg: 1_500_000 });
    expect((await createSerial(lotA, "SN-UNICO-001")).statusCode).toBe(200);

    const duplicate = await createSerial(lotB, "SN-UNICO-001");

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.data.appCode).toBe("CONFLICT_SERIAL_DUPLICATE");
    const stored = await testDb.superuserClient.query(
      `SELECT count(*)::int AS n FROM app.serialized_units
        WHERE tenant_id = $1 AND serial_number = 'SN-UNICO-001'`,
      [TENANT_ID],
    );
    expect(stored.rows[0].n).toBe(1);
  });

  it("RN-SER-01 · el número de serie NO es único global: otro tenant con el mismo serial no choca con este", async () => {
    const variantId = await createSerializedVariant();
    const lotId = await seedSealedLot(variantId, { qtyInitial: 1, unitCostPyg: 1_500_000 });
    const otherTenant = "88888888-8888-4888-a888-888888888812";
    await testDb.superuserClient.query(
      `INSERT INTO app.tenants (id, slug, legal_name, trade_name)
       VALUES ($1, 'otro-tenant-c12', 'Otro SA', 'Otro') ON CONFLICT DO NOTHING`,
      [otherTenant],
    );
    await testDb.superuserClient.query(
      `INSERT INTO app.products (id, tenant_id, kind, slug, name, status)
       VALUES ('88888888-8888-4888-a888-8888888888a1', $1, 'accessory', 'otro-c12', 'Otro', 'draft')
       ON CONFLICT DO NOTHING`,
      [otherTenant],
    );
    await testDb.superuserClient.query(
      `INSERT INTO app.product_variants (id, tenant_id, product_id, sku, variant_type, uom, price_pyg)
       VALUES ('88888888-8888-4888-a888-8888888888b1', $1, '88888888-8888-4888-a888-8888888888a1',
               'OTRO-C12', 'unit', 'unit', 0) ON CONFLICT DO NOTHING`,
      [otherTenant],
    );
    await testDb.superuserClient.query(
      `INSERT INTO app.serialized_units (tenant_id, variant_id, serial_number)
       VALUES ($1, '88888888-8888-4888-a888-8888888888b1', 'SN-COMPARTIDO-001')`,
      [otherTenant],
    );

    const response = await createSerial(lotId, "SN-COMPARTIDO-001");

    expect(response.statusCode).toBe(200);
  });

  it("RN-SER-02 · un lote de una variante que no es serializada se rechaza", async () => {
    const sealedVariantId = await createSealedVariant();
    const lotId = await seedSealedLot(sealedVariantId, { qtyInitial: 3, unitCostPyg: 500_000 });

    const response = await createSerial(lotId, "SN-NO-SERIALIZADA");

    expect(response.statusCode).toBe(409);
    expect(response.json().error.data.appCode).toBe("CONFLICT_VARIANT_NOT_SERIALIZED");
  });

  it("RN-SER-02 · un lote de granel en ml también se rechaza como no serializado, sin error interno", async () => {
    const { bulkVariantId } = await createSealedAndBulkVariants();
    const bulkLotId = await seedBulkLot(bulkVariantId, { qtyInitial: 100.5, unitCostPyg: 14_965 });

    const response = await createSerial(bulkLotId, "SN-GRANEL");

    expect(response.statusCode).toBe(409);
    expect(response.json().error.data.appCode).toBe("CONFLICT_VARIANT_NOT_SERIALIZED");
  });

  it("RN-SER-03 · un lote de tres acepta tres unidades y rechaza la cuarta", async () => {
    const variantId = await createSerializedVariant();
    const lotId = await seedSealedLot(variantId, { qtyInitial: 3, unitCostPyg: 1_500_000 });
    for (const serial of ["SN-CAP-1", "SN-CAP-2", "SN-CAP-3"]) {
      expect((await createSerial(lotId, serial)).statusCode).toBe(200);
    }

    const fourth = await createSerial(lotId, "SN-CAP-4");

    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().error.data.appCode).toBe("CONFLICT_LOT_SERIAL_CAPACITY");
    expect(fourth.json().error.data.details).toEqual({ capacity: 3, registered: 3 });
  });

  it("RN-SER-03 · cuentan TODAS las unidades del lote, las vendidas también: con una vendida, el cupo sigue lleno", async () => {
    const variantId = await createSerializedVariant();
    const lotId = await seedSealedLot(variantId, { qtyInitial: 2, unitCostPyg: 1_500_000 });
    const first = await createSerial(lotId, "SN-VEND-1");
    await createSerial(lotId, "SN-VEND-2");
    await testDb.superuserClient.query(
      `UPDATE app.serialized_units SET status = 'sold' WHERE id = $1`,
      [first.json().result.data.id],
    );

    const third = await createSerial(lotId, "SN-VEND-3");

    expect(third.statusCode).toBe(409);
    expect(third.json().error.data.appCode).toBe("CONFLICT_LOT_SERIAL_CAPACITY");
  });

  it("RN-SER-03 · dos altas simultáneas sobre el último cupo: una gana, la otra se rechaza, y el lote no pasa de tres", async () => {
    // El resultado de punta a punta con dos altas a la vez. Ojo: por sí solo
    // NO prueba el bloqueo, porque las dos peticiones se ordenan solas y este
    // test pasa igual sin el FOR UPDATE (verificado sacándolo). Lo prueba el
    // test de abajo, que retiene el lote desde otra transacción.
    const variantId = await createSerializedVariant();
    const lotId = await seedSealedLot(variantId, { qtyInitial: 3, unitCostPyg: 1_500_000 });
    await createSerial(lotId, "SN-RACE-1");
    await createSerial(lotId, "SN-RACE-2");

    const responses = await Promise.all([
      createSerial(lotId, "SN-RACE-3"),
      createSerial(lotId, "SN-RACE-4"),
    ]);

    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const stored = await testDb.superuserClient.query(
      `SELECT count(*)::int AS n FROM app.serialized_units WHERE lot_id = $1`,
      [lotId],
    );
    expect(stored.rows[0].n).toBe(3);
  });

  it("RN-SER-03 · el alta toma el bloqueo del lote ANTES de contar: con el lote tomado por otra transacción, espera", async () => {
    const variantId = await createSerializedVariant();
    const lotId = await seedSealedLot(variantId, { qtyInitial: 3, unitCostPyg: 1_500_000 });
    await createSerial(lotId, "SN-LOCK-1");
    await createSerial(lotId, "SN-LOCK-2");

    const statusCode = await requestWaitsForLotLock(lotId, () => createSerial(lotId, "SN-LOCK-3"));

    expect(statusCode).toBe(200);
  });

  it("RF-INV-10 · un lote inexistente (o de otro tenant) da 404", async () => {
    const response = await createSerial("00000000-0000-4000-a000-000000000000", "SN-FANTASMA");

    expect(response.statusCode).toBe(404);
  });

  it("RF-INV-10 · el alta rechaza que el cliente declare la variante (.strict()): la deriva el lote", async () => {
    const variantId = await createSerializedVariant();
    const lotId = await seedSealedLot(variantId, { qtyInitial: 1, unitCostPyg: 1_500_000 });

    const response = await createSerial(lotId, "SN-VARIANTE", { variantId });

    expect(response.statusCode).toBe(400);
  });

  it("RF-INV-10 · se consulta por número de serie exacto y por lote", async () => {
    const variantId = await createSerializedVariant();
    const lotId = await seedSealedLot(variantId, { qtyInitial: 3, unitCostPyg: 1_500_000 });
    await createSerial(lotId, "SN-QRY-1");
    await createSerial(lotId, "SN-QRY-2");

    const bySerial = await call<{ items: SerialUnit[] }>("inventory.serial.list", {
      serialNumber: "SN-QRY-2",
    });
    const byLot = await call<{ items: SerialUnit[]; nextCursor: string | null }>(
      "inventory.serial.list",
      { lotId },
    );

    expect(bySerial.items.map((u) => u.serialNumber)).toEqual(["SN-QRY-2"]);
    expect(byLot.items.map((u) => u.serialNumber).sort()).toEqual(["SN-QRY-1", "SN-QRY-2"]);
    expect(byLot.nextCursor).toBeNull();
  });

  it("RF-INV-10 · se consulta por variante con paginación por cursor, sin repetir ni saltear unidades", async () => {
    const variantId = await createSerializedVariant();
    const lotId = await seedSealedLot(variantId, { qtyInitial: 3, unitCostPyg: 1_500_000 });
    for (const serial of ["SN-PAG-1", "SN-PAG-2", "SN-PAG-3"]) await createSerial(lotId, serial);

    const first = await call<{ items: SerialUnit[]; nextCursor: string | null }>(
      "inventory.serial.list",
      { variantId, limit: 2 },
    );
    const second = await call<{ items: SerialUnit[]; nextCursor: string | null }>(
      "inventory.serial.list",
      { variantId, limit: 2, cursor: first.nextCursor },
    );

    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map((u) => u.serialNumber).sort()).toEqual([
      "SN-PAG-1",
      "SN-PAG-2",
      "SN-PAG-3",
    ]);
  });

  it("RF-INV-10 · la consulta sin ningún criterio, o con un cursor corrupto, se rechaza con 400", async () => {
    const sinCriterio = await app.inject({
      method: "GET",
      url: `/trpc/inventory.serial.list?input=${encodeURIComponent(JSON.stringify({}))}`,
      headers: { cookie },
    });
    const cursorRoto = await app.inject({
      method: "GET",
      url: `/trpc/inventory.serial.list?input=${encodeURIComponent(
        JSON.stringify({ serialNumber: "X", cursor: "no-es-un-cursor" }),
      )}`,
      headers: { cookie },
    });

    expect(sinCriterio.statusCode).toBe(400);
    expect(cursorRoto.statusCode).toBe(400);
    expect(cursorRoto.json().error.data.appCode).toBe("VALIDATION_INVALID_CURSOR");
  });

  it("RF-INV-10 · la trazabilidad trae la unidad y los movimientos que la mencionan, con su costo", async () => {
    const variantId = await createSerializedVariant();
    const lotId = await seedSealedLot(variantId, { qtyInitial: 1, unitCostPyg: 1_500_000 });
    const created = await createSerial(lotId, "SN-TRAZA-1");
    const unitId = created.json().result.data.id as string;
    // La venta (WP-C19) todavía no existe: el movimiento se escribe directo.
    await testDb.superuserClient.query(
      `INSERT INTO app.inventory_movements
         (tenant_id, lot_id, variant_id, serial_unit_id, qty, uom, movement_type,
          total_cost_pyg, created_by)
       VALUES ($1, $2, $3, $4, -1, 'unit', 'sale', 1500000, $5)`,
      [TENANT_ID, lotId, variantId, unitId, STAFF_OWNER_ID],
    );

    const history = await call<{
      unit: SerialUnit;
      movements: {
        movementType: string;
        qty: number;
        serialUnitId: string;
        totalCostPyg: string;
      }[];
    }>("inventory.serial.history", { serialUnitId: unitId });

    expect(history.unit.serialNumber).toBe("SN-TRAZA-1");
    expect(history.movements).toEqual([
      expect.objectContaining({
        movementType: "sale",
        qty: -1,
        serialUnitId: unitId,
        totalCostPyg: "1500000",
      }),
    ]);
  });

  it("RF-INV-10 · una unidad inexistente (o de otro tenant) da 404 en la trazabilidad", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/trpc/inventory.serial.history?input=${encodeURIComponent(
        JSON.stringify({ serialUnitId: "00000000-0000-4000-a000-000000000000" }),
      )}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
  });

  // -------------------------------------------------------------------
  // WP-C08d · RN-SER-02. Apagar `is_serialized` de una variante con unidades
  // registradas dejaría unidades colgando de una variante que ya no las admite.
  // `catalog.variant.update` lo rechaza. Los relojes con `requiresSerial` no
  // llegan a la guarda (WP-C08f ya rechaza apagarlo, porque contradice al
  // producto): se prueba con un accesorio, que no hereda nada, y con un reloj
  // anterior a E05c cuya variante quedó serializada sin que el producto lo pida.
  // -------------------------------------------------------------------
  let accessoryCounter = 0;
  async function createSerializedAccessoryVariant(): Promise<{ productId: string; id: string }> {
    const suffix = `${Date.now()}-${++accessoryCounter}`;
    const category = await mutateOk<{ id: string }>("catalog.category.create", {
      slug: `accesorios-c08d-${suffix}`,
      name: "Accesorios",
    });
    const product = await mutateOk<{ id: string }>("catalog.product.create", {
      kind: "accessory",
      slug: `estuche-c08d-${suffix}`,
      name: "Estuche numerado",
      categoryIds: [category.id],
      primaryCategoryId: category.id,
      accessoryDetails: { material: null, color: null, sizeLabel: null },
    });
    const variant = await mutateOk<{ id: string }>("catalog.variant.create", {
      productId: product.id,
      sku: `SKU-ESTUCHE-C08D-${suffix}`,
      variantType: "unit",
      uom: "unit",
      sizeMl: null,
      pricePyg: "150000",
      isSerialized: true,
    });
    return { productId: product.id, id: variant.id };
  }

  async function variantIsSerialized(variantId: string): Promise<boolean> {
    const row = await testDb.superuserClient.query(
      `SELECT is_serialized FROM app.product_variants WHERE id = $1`,
      [variantId],
    );
    return row.rows[0].is_serialized;
  }

  it("RN-SER-02 · apagar is_serialized con unidades registradas se rechaza con un error en español y la variante sigue serializada", async () => {
    const variant = await createSerializedAccessoryVariant();
    const lotId = await seedSealedLot(variant.id, { qtyInitial: 3, unitCostPyg: 100_000 });
    expect((await createSerial(lotId, "SN-C08D-1")).statusCode).toBe(200);

    const response = await mutate("catalog.variant.update", {
      id: variant.id,
      isSerialized: false,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.data.appCode).toBe("CONFLICT_VARIANT_HAS_SERIAL_UNITS");
    expect(response.json().error.message).toBe(
      "Esta variante ya tiene unidades con número de serie registradas: no se puede dejar de serializar.",
    );
    expect(response.json().error.data.details).toEqual({ registered: 1 });
    expect(await variantIsSerialized(variant.id)).toBe(true);
  });

  it("RN-SER-02 · una unidad vendida también cuenta: el lote la trajo igual", async () => {
    const variant = await createSerializedAccessoryVariant();
    const lotId = await seedSealedLot(variant.id, { qtyInitial: 3, unitCostPyg: 100_000 });
    const created = await createSerial(lotId, "SN-C08D-VENDIDA");
    await testDb.superuserClient.query(
      `UPDATE app.serialized_units SET status = 'sold' WHERE id = $1`,
      [created.json().result.data.id],
    );

    const response = await mutate("catalog.variant.update", {
      id: variant.id,
      isSerialized: false,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.data.appCode).toBe("CONFLICT_VARIANT_HAS_SERIAL_UNITS");
  });

  it("RN-SER-02 · sin unidades registradas se puede apagar y volver a encender", async () => {
    const variant = await createSerializedAccessoryVariant();
    await seedSealedLot(variant.id, { qtyInitial: 3, unitCostPyg: 100_000 });

    const off = await mutateOk<{ isSerialized: boolean }>("catalog.variant.update", {
      id: variant.id,
      isSerialized: false,
    });
    const on = await mutateOk<{ isSerialized: boolean }>("catalog.variant.update", {
      id: variant.id,
      isSerialized: true,
    });

    expect(off.isSerialized).toBe(false);
    expect(on.isSerialized).toBe(true);
  });

  it("RN-SER-02 · con unidades registradas se sigue editando todo lo demás, y mandar isSerialized: true no cambia nada", async () => {
    const variant = await createSerializedAccessoryVariant();
    const lotId = await seedSealedLot(variant.id, { qtyInitial: 3, unitCostPyg: 100_000 });
    await createSerial(lotId, "SN-C08D-EDITA");

    const edited = await mutateOk<{ pricePyg: string; isSerialized: boolean }>(
      "catalog.variant.update",
      { id: variant.id, pricePyg: "175000", isSerialized: true },
    );

    expect(edited.pricePyg).toBe("175000");
    expect(edited.isSerialized).toBe(true);
  });

  it("RN-SER-02 · la guarda rige también cuando WP-C08f no interviene: una variante de reloj que no hereda serie pero tiene unidades", async () => {
    const suffix = `${Date.now()}-${++accessoryCounter}`;
    const category = await mutateOk<{ id: string }>("catalog.category.create", {
      slug: `relojes-c08d-${suffix}`,
      name: "Relojes",
    });
    const product = await mutateOk<{ id: string }>("catalog.product.create", {
      kind: "watch",
      slug: `reloj-sin-serie-c08d-${suffix}`,
      name: "Reloj de cuarzo",
      categoryIds: [category.id],
      primaryCategoryId: category.id,
      watchDetails: {
        movement: "quartz",
        caseMaterial: "acero",
        caseDiameterMm: 38,
        waterResistanceM: 50,
        strapMaterial: null,
        crystal: "mineral",
        warrantyMonths: 12,
        requiresSerial: false,
      },
    });
    const variant = await mutateOk<{ id: string; isSerialized: boolean }>(
      "catalog.variant.create",
      {
        productId: product.id,
        sku: `SKU-CUARZO-C08D-${suffix}`,
        variantType: "unit",
        uom: "unit",
        sizeMl: null,
        pricePyg: "900000",
      },
    );
    expect(variant.isSerialized).toBe(false);
    // Una variante anterior a E05c: serializada aunque el producto no lo pida.
    await testDb.superuserClient.query(
      `UPDATE app.product_variants SET is_serialized = true WHERE id = $1`,
      [variant.id],
    );
    const lotId = await seedSealedLot(variant.id, { qtyInitial: 2, unitCostPyg: 600_000 });
    await createSerial(lotId, "SN-C08D-CUARZO");

    // Coincide con `requires_serial = false`: C08f lo acepta; lo frena la guarda de las unidades.
    const response = await mutate("catalog.variant.update", {
      id: variant.id,
      isSerialized: false,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.data.appCode).toBe("CONFLICT_VARIANT_HAS_SERIAL_UNITS");
  });

  it("RN-SER-02 · apagar espera a un alta de unidad en curso, la ve al terminar y se rechaza", async () => {
    const variant = await createSerializedAccessoryVariant();
    const lotId = await seedSealedLot(variant.id, { qtyInitial: 3, unitCostPyg: 100_000 });

    // Un alta de unidad en vuelo: tiene el lote tomado y la unidad insertada, sin confirmar.
    // Una petición que contara las unidades antes de tomar los lotes vería cero, apagaría la
    // variante, y al confirmarse el alta quedaría una unidad en una variante no serializada.
    await testDb.superuserClient.query("BEGIN");
    let released = false;
    let pending: ReturnType<typeof mutate> | undefined;
    try {
      await testDb.superuserClient.query(
        "SELECT id FROM app.inventory_lots WHERE id = $1 FOR UPDATE",
        [lotId],
      );
      await testDb.superuserClient.query(
        `INSERT INTO app.serialized_units (tenant_id, variant_id, lot_id, serial_number)
         VALUES ($1, $2, $3, 'SN-C08D-EN-VUELO')`,
        [TENANT_ID, variant.id, lotId],
      );
      pending = mutate("catalog.variant.update", { id: variant.id, isSerialized: false });
      await waitUntilABackendIsBlockedOnALock();
      await testDb.superuserClient.query("COMMIT");
      released = true;
      const response = await pending;

      expect(response.statusCode).toBe(409);
      expect(response.json().error.data.appCode).toBe("CONFLICT_VARIANT_HAS_SERIAL_UNITS");
    } finally {
      if (!released) {
        await testDb.superuserClient.query("ROLLBACK");
        await pending?.catch(() => undefined);
      }
    }
    expect(await variantIsSerialized(variant.id)).toBe(true);
  });

  it("RN-SER-02 · pasar el reloj a «no» espera a un alta de unidad en curso, la ve al terminar y se rechaza (WP-C08h)", async () => {
    const variantId = await createSerializedVariant();
    const product = await testDb.superuserClient.query(
      `SELECT product_id FROM app.product_variants WHERE id = $1`,
      [variantId],
    );
    const productId: string = product.rows[0].product_id;
    const lotId = await seedSealedLot(variantId, { qtyInitial: 3, unitCostPyg: 100_000 });

    // Un alta de unidad en vuelo, como en la prueba de C08d: tiene el lote tomado y la unidad
    // insertada, sin confirmar. Si la propagación contara las unidades antes de tomar los lotes
    // vería cero, apagaría la variante, y al confirmarse el alta quedaría una unidad en una
    // variante que ya no las admite.
    await testDb.superuserClient.query("BEGIN");
    let released = false;
    let pending: ReturnType<typeof mutate> | undefined;
    try {
      await testDb.superuserClient.query(
        "SELECT id FROM app.inventory_lots WHERE id = $1 FOR UPDATE",
        [lotId],
      );
      await testDb.superuserClient.query(
        `INSERT INTO app.serialized_units (tenant_id, variant_id, lot_id, serial_number)
         VALUES ($1, $2, $3, 'SN-C08H-EN-VUELO')`,
        [TENANT_ID, variantId, lotId],
      );
      pending = mutate("catalog.product.update", {
        id: productId,
        watchDetails: { requiresSerial: false },
      });
      await waitUntilABackendIsBlockedOnALock();
      await testDb.superuserClient.query("COMMIT");
      released = true;
      const response = await pending;

      expect(response.statusCode).toBe(409);
      expect(response.json().error.data.appCode).toBe("CONFLICT_REQUIRES_SERIAL_UNITS_REGISTERED");
    } finally {
      if (!released) {
        await testDb.superuserClient.query("ROLLBACK");
        await pending?.catch(() => undefined);
      }
    }
    expect(await variantIsSerialized(variantId)).toBe(true);
    const details = await testDb.superuserClient.query(
      `SELECT requires_serial FROM app.watch_details WHERE product_id = $1`,
      [productId],
    );
    expect(details.rows[0].requires_serial).toBe(true);
  });
});
