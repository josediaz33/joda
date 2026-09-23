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
// (WP-C08). Cubre RF-INV-03…05 de punta a punta (docs/backlog.md, WP-C10) —
// las validaciones de forma de createAdjustmentInput (qty en cero, motivo
// vacío, precisión decimal) ya están cubiertas sin Postgres en
// packages/contracts/src/inventory.test.ts.
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

describe("WP-C10 · módulo inventario (RF-INV-03…05)", () => {
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
      clock: createManualClock(new Date("2026-01-01T12:00:00.000Z")),
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
});
