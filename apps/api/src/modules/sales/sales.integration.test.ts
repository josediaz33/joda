import { PrismaClient } from "@joda/db";
import { fastifyTRPCPlugin, type CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jodaApiConnectionUrl, startTestDb, type TestDb } from "../../db/testDb.js";
import { router } from "../../trpc/trpc.js";
import { createSalesRouter } from "./router.js";
import * as sales from "./service.js";

// Tres tenants: A (casi todo), B (aislamiento y listados) y C (numeración, que
// no puede compartir el contador con las demás pruebas).
const TENANT = "81818181-8181-4181-a181-818181818181";
const OTHER_TENANT = "81818181-8181-4181-a181-818181818182";
const CODES_TENANT = "81818181-8181-4181-a181-818181818183";
const STAFF = "82828282-8282-4282-a282-828282828281";
const SELLER = "82828282-8282-4282-a282-828282828282";
const READER = "82828282-8282-4282-a282-828282828283";
const OTHER_STAFF = "82828282-8282-4282-a282-828282828284";
const CODES_STAFF = "82828282-8282-4282-a282-828282828285";
const SESSION = "83838383-8383-4383-a383-838383838381";
const SELLER_SESSION = "83838383-8383-4383-a383-838383838382";
const READER_SESSION = "83838383-8383-4383-a383-838383838383";
const OTHER_SESSION = "83838383-8383-4383-a383-838383838384";
const CODES_SESSION = "83838383-8383-4383-a383-838383838385";

const CHANNEL = "84848484-8484-4484-a484-848484848481";
const INACTIVE_CHANNEL = "84848484-8484-4484-a484-848484848482";
const OTHER_CHANNEL = "84848484-8484-4484-a484-848484848483";
const CODES_CHANNEL = "84848484-8484-4484-a484-848484848484";
const CUSTOMER = "85858585-8585-4585-a585-858585858581";
const INACTIVE_CUSTOMER = "85858585-8585-4585-a585-858585858582";
const OTHER_CUSTOMER = "85858585-8585-4585-a585-858585858583";

// Gs. 100.000 al 10%, Gs. 50.000 al 5%, Gs. 50.000 exenta, Gs. 33.333 al 10%,
// un decant de 10 ml a Gs. 245.000, y dos relojes serializados a Gs. 1.500.000.
const V_TEN = "86868686-8686-4686-a686-868686868601";
const V_FIVE = "86868686-8686-4686-a686-868686868602";
const V_EXEMPT = "86868686-8686-4686-a686-868686868603";
const V_THIRD = "86868686-8686-4686-a686-868686868604";
const V_DECANT = "86868686-8686-4686-a686-868686868605";
const V_WATCH = "86868686-8686-4686-a686-868686868606";
const V_WATCH_2 = "86868686-8686-4686-a686-868686868607";
const V_OTHER = "86868686-8686-4686-a686-868686868608";
const V_OTHER_WATCH = "86868686-8686-4686-a686-868686868609";
const V_CODES = "86868686-8686-4686-a686-868686868610";
const UNIT_1 = "87878787-8787-4787-a787-878787878701";
const UNIT_2 = "87878787-8787-4787-a787-878787878702";
const UNIT_SOLD = "87878787-8787-4787-a787-878787878703";
const UNIT_OF_OTHER_VARIANT = "87878787-8787-4787-a787-878787878704";
const UNIT_FOREIGN = "87878787-8787-4787-a787-878787878705";

const NOW = new Date("2026-10-12T15:00:00.000Z");
const clock = { now: () => NOW };
const deps: sales.SalesServiceDeps = { clock };
const auditMeta = { ip: "127.0.0.1", userAgent: "sales-test", requestId: "req-sales-test" };
const ctx: sales.SalesContext = {
  tenantId: TENANT,
  userId: STAFF,
  audience: "staff",
  sessionId: SESSION,
  auditMeta,
};
const otherCtx: sales.SalesContext = {
  tenantId: OTHER_TENANT,
  userId: OTHER_STAFF,
  audience: "staff",
  sessionId: OTHER_SESSION,
  auditMeta,
};
const codesCtx: sales.SalesContext = {
  tenantId: CODES_TENANT,
  userId: CODES_STAFF,
  audience: "staff",
  sessionId: CODES_SESSION,
  auditMeta,
};

describe(
  "RF-VTA-01…03 · pedidos de mostrador (RN-VTA-01, RN-IVA, RN-EST-02)",
  { timeout: 30_000 },
  () => {
    let testDb: TestDb;
    let db: PrismaClient;

    const q = <Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ) => testDb.superuserClient.query<Row>(text, values);

    async function count(text: string, values: unknown[] = []): Promise<number> {
      return (await q<{ n: number }>(text, values)).rows[0]!.n;
    }

    async function seedTenant(
      tenantId: string,
      slug: string,
      staffId: string,
      sessionId: string,
      channelId: string,
    ) {
      await q(
        "INSERT INTO app.tenants (id, slug, legal_name, trade_name) VALUES ($1, $2, 'JODA', 'JODA')",
        [tenantId, slug],
      );
      await q("SELECT app.seed_roles($1)", [tenantId]);
      await q(
        "INSERT INTO app.staff_users (id, tenant_id, auth_subject, email, full_name) VALUES ($1, $2, $3, $4, 'Owner')",
        [staffId, tenantId, `sales-${slug}`, `sales-${slug}@test.local`],
      );
      await q(
        "INSERT INTO app.staff_user_roles (tenant_id, staff_user_id, role_id) SELECT $1, $2, id FROM app.roles WHERE tenant_id = $1 AND code = 'owner'",
        [tenantId, staffId],
      );
      await q(
        "INSERT INTO app.staff_sessions (id, tenant_id, staff_user_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')",
        [sessionId, tenantId, staffId],
      );
      await q(
        "INSERT INTO app.sales_channels (id, tenant_id, code, name) VALUES ($1, $2, 'presencial', 'Mostrador')",
        [channelId, tenantId],
      );
    }

    async function seedVariant(
      tenantId: string,
      id: string,
      sku: string,
      kind: "accessory" | "perfume" | "watch",
      fields: {
        type?: "unit" | "decant";
        uom?: "unit" | "ml";
        sizeMl?: number;
        price: number;
        vat?: "iva_10" | "iva_5" | "exenta";
        serialized?: boolean;
      },
    ) {
      const product = await q<{ id: string }>(
        "INSERT INTO app.products (tenant_id, kind, slug, name) VALUES ($1, $2::app.product_kind, $3, $4) RETURNING id",
        [tenantId, kind, `sales-${sku}`, `Producto ${sku}`],
      );
      await q(
        "INSERT INTO app.product_variants (id, tenant_id, product_id, sku, variant_type, uom, size_ml, price_pyg, vat_rate, is_serialized) VALUES ($1, $2, $3, $4, $5::app.variant_type, $6::app.uom, $7, $8, $9::app.vat_rate, $10)",
        [
          id,
          tenantId,
          product.rows[0]!.id,
          sku,
          fields.type ?? "unit",
          fields.uom ?? "unit",
          fields.sizeMl ?? null,
          fields.price,
          fields.vat ?? "iva_10",
          fields.serialized ?? false,
        ],
      );
    }

    async function seedUnit(
      tenantId: string,
      id: string,
      variantId: string,
      serialNumber: string,
      status = "available",
    ) {
      await q(
        "INSERT INTO app.serialized_units (id, tenant_id, variant_id, serial_number, status) VALUES ($1, $2, $3, $4, $5::app.serial_status)",
        [id, tenantId, variantId, serialNumber, status],
      );
    }

    const oneLine = (variantId: string, qty = "1") => ({ variantId, qty });

    beforeAll(async () => {
      testDb = await startTestDb();
      await seedTenant(TENANT, "sales-a", STAFF, SESSION, CHANNEL);
      await seedTenant(OTHER_TENANT, "sales-b", OTHER_STAFF, OTHER_SESSION, OTHER_CHANNEL);
      await seedTenant(CODES_TENANT, "sales-c", CODES_STAFF, CODES_SESSION, CODES_CHANNEL);

      // El vendedor sembrado (sales.order:read y :write) y un rol que solo lee.
      await q(
        "INSERT INTO app.staff_users (id, tenant_id, auth_subject, email, full_name) VALUES ($1, $3, 'sales-seller', 'sales-seller@test.local', 'Vendedor'), ($2, $3, 'sales-reader', 'sales-reader@test.local', 'Lector')",
        [SELLER, READER, TENANT],
      );
      await q(
        "INSERT INTO app.staff_user_roles (tenant_id, staff_user_id, role_id) SELECT $1, $2, id FROM app.roles WHERE tenant_id = $1 AND code = 'vendedor'",
        [TENANT, SELLER],
      );
      const readerRole = await q<{ id: string }>(
        "INSERT INTO app.roles (tenant_id, code, name) VALUES ($1, 'sales_reader_test', 'Solo lectura de pedidos') RETURNING id",
        [TENANT],
      );
      await q(
        "INSERT INTO app.role_permissions (tenant_id, role_id, permission_code) VALUES ($1, $2, 'sales.order:read')",
        [TENANT, readerRole.rows[0]!.id],
      );
      await q(
        "INSERT INTO app.staff_user_roles (tenant_id, staff_user_id, role_id) VALUES ($1, $2, $3)",
        [TENANT, READER, readerRole.rows[0]!.id],
      );
      await q(
        "INSERT INTO app.staff_sessions (id, tenant_id, staff_user_id, expires_at) VALUES ($1, $3, $4, now() + interval '1 day'), ($2, $3, $5, now() + interval '1 day')",
        [SELLER_SESSION, READER_SESSION, TENANT, SELLER, READER],
      );

      await q(
        "INSERT INTO app.sales_channels (id, tenant_id, code, name, is_active) VALUES ($1, $2, 'whatsapp', 'WhatsApp', false)",
        [INACTIVE_CHANNEL, TENANT],
      );
      await q(
        "INSERT INTO app.customers (id, tenant_id, full_name, is_active) VALUES ($1, $4, 'Cliente', true), ($2, $4, 'Cliente baja', false), ($3, $5, 'Cliente ajeno', true)",
        [CUSTOMER, INACTIVE_CUSTOMER, OTHER_CUSTOMER, TENANT, OTHER_TENANT],
      );

      await seedVariant(TENANT, V_TEN, "S-TEN", "accessory", { price: 100_000 });
      await seedVariant(TENANT, V_FIVE, "S-FIVE", "accessory", { price: 50_000, vat: "iva_5" });
      await seedVariant(TENANT, V_EXEMPT, "S-EXEMPT", "accessory", {
        price: 50_000,
        vat: "exenta",
      });
      await seedVariant(TENANT, V_THIRD, "S-THIRD", "accessory", { price: 33_333 });
      await seedVariant(TENANT, V_DECANT, "S-DECANT", "perfume", {
        type: "decant",
        uom: "ml",
        sizeMl: 10,
        price: 245_000,
      });
      await seedVariant(TENANT, V_WATCH, "S-WATCH", "watch", {
        price: 1_500_000,
        serialized: true,
      });
      await seedVariant(TENANT, V_WATCH_2, "S-WATCH-2", "watch", {
        price: 1_500_000,
        serialized: true,
      });
      await seedVariant(OTHER_TENANT, V_OTHER, "S-OTHER", "accessory", { price: 100_000 });
      await seedVariant(OTHER_TENANT, V_OTHER_WATCH, "S-OTHER-W", "watch", {
        price: 1_500_000,
        serialized: true,
      });
      await seedVariant(CODES_TENANT, V_CODES, "S-CODES", "accessory", { price: 100_000 });
      await seedUnit(TENANT, UNIT_1, V_WATCH, "RLX-0001");
      await seedUnit(TENANT, UNIT_2, V_WATCH, "RLX-0002");
      await seedUnit(TENANT, UNIT_SOLD, V_WATCH, "RLX-0003", "sold");
      await seedUnit(TENANT, UNIT_OF_OTHER_VARIANT, V_WATCH_2, "RLX-0004");
      await seedUnit(OTHER_TENANT, UNIT_FOREIGN, V_OTHER_WATCH, "RLX-0005");

      db = new PrismaClient({ datasourceUrl: jodaApiConnectionUrl(testDb.container) });
    }, 120_000);

    afterAll(async () => {
      await db?.$disconnect();
      await testDb?.stop();
    });

    function appFor(who: { userId: string; sessionId: string; granted: string[] }) {
      const app = Fastify();
      app.register(fastifyTRPCPlugin, {
        prefix: "/trpc",
        trpcOptions: {
          router: router({ sales: createSalesRouter(db, deps) }),
          createContext: ({ req, res }: CreateFastifyContextOptions) => ({
            requestId: req.id,
            userId: who.userId,
            tenantId: TENANT,
            audience: "staff" as const,
            sessionId: who.sessionId,
            mfaStatus: "satisfied" as const,
            grantedPermissions: new Set(who.granted),
            req,
            res,
          }),
        },
      });
      return app;
    }

    it("RF-VTA-01 · crea en borrador un pedido con decant, reloj serializado y productos en las tres tasas (RN-VTA-05)", async () => {
      const order = await sales.createOrder(
        db,
        ctx,
        {
          channelId: CHANNEL,
          customerId: CUSTOMER,
          notes: "Retira en el local",
          lines: [
            oneLine(V_TEN, "2"),
            oneLine(V_DECANT, "3"),
            { variantId: V_WATCH, qty: "1", serialUnitId: UNIT_1 },
            oneLine(V_FIVE),
            oneLine(V_EXEMPT),
          ],
        },
        deps,
      );

      expect(order).toMatchObject({
        channelId: CHANNEL,
        customerId: CUSTOMER,
        code: "VTA-2026-0001",
        status: "draft",
        subtotalPyg: "2535000",
        discountPyg: "0",
        shippingPyg: "0",
        totalPyg: "2535000",
        vat10Pyg: "221364",
        vat5Pyg: "2381",
        exemptPyg: "50000",
        notes: "Retira en el local",
        createdBy: STAFF,
        placedAt: null,
        confirmedAt: null,
        cancelledAt: null,
        transitions: [],
      });
      expect(
        order.lines.map((line) => ({
          variantId: line.variantId,
          serialUnitId: line.serialUnitId,
          qty: line.qty,
          uom: line.uom,
          unitPricePyg: line.unitPricePyg,
          lineTotalPyg: line.lineTotalPyg,
          vatRate: line.vatRate,
          vatPyg: line.vatPyg,
          position: line.position,
        })),
      ).toEqual([
        {
          variantId: V_TEN,
          serialUnitId: null,
          qty: "2",
          uom: "unit",
          unitPricePyg: "100000",
          lineTotalPyg: "200000",
          vatRate: "iva_10",
          vatPyg: "18182",
          position: 0,
        },
        {
          variantId: V_DECANT,
          serialUnitId: null,
          qty: "3",
          uom: "ml",
          unitPricePyg: "245000",
          lineTotalPyg: "735000",
          vatRate: "iva_10",
          vatPyg: "66818",
          position: 1,
        },
        {
          variantId: V_WATCH,
          serialUnitId: UNIT_1,
          qty: "1",
          uom: "unit",
          unitPricePyg: "1500000",
          lineTotalPyg: "1500000",
          vatRate: "iva_10",
          vatPyg: "136364",
          position: 2,
        },
        {
          variantId: V_FIVE,
          serialUnitId: null,
          qty: "1",
          uom: "unit",
          unitPricePyg: "50000",
          lineTotalPyg: "50000",
          vatRate: "iva_5",
          vatPyg: "2381",
          position: 3,
        },
        {
          variantId: V_EXEMPT,
          serialUnitId: null,
          qty: "1",
          uom: "unit",
          unitPricePyg: "50000",
          lineTotalPyg: "50000",
          vatRate: "exenta",
          vatPyg: "0",
          position: 4,
        },
      ]);
    });

    it("RN-VTA-02 · crear el pedido no toca el libro de inventario, no reserva y no saca la unidad serializada de disponible", async () => {
      // El pedido del test anterior ya existe; este solo verifica lo que dejó.
      expect(await count("SELECT count(*)::int AS n FROM app.inventory_movements")).toBe(0);
      expect(await count("SELECT count(*)::int AS n FROM app.stock_reservations")).toBe(0);
      expect(
        (
          await q<{ status: string }>("SELECT status FROM app.serialized_units WHERE id = $1", [
            UNIT_1,
          ])
        ).rows[0]!.status,
      ).toBe("available");
    });

    it("docs/security-spec.md §7 · la creación queda en la bitácora con el contexto de la petición", async () => {
      const created = await sales.createOrder(
        db,
        ctx,
        { channelId: CHANNEL, lines: [oneLine(V_TEN)] },
        deps,
      );

      const audit = await q<{
        action: string;
        before: unknown;
        after: Record<string, unknown>;
        user_agent: string;
        request_id: string;
      }>(
        "SELECT action, before, after, user_agent, request_id FROM app.audit_log WHERE entity_id = $1",
        [created.id],
      );
      expect(audit.rows).toEqual([
        {
          action: "sales.order.create",
          before: null,
          after: {
            status: "draft",
            code: created.code,
            channelId: CHANNEL,
            customerId: null,
            totalPyg: "100000",
            lineCount: 1,
          },
          user_agent: "sales-test",
          request_id: "req-sales-test",
        },
      ]);
    });

    it("RN-VTA-01 · rechaza un total inconsistente sin escribir nada y acepta el que coincide con el cálculo", async () => {
      const before = await count(
        "SELECT count(*)::int AS n FROM app.sale_orders WHERE tenant_id = $1",
        [TENANT],
      );

      await expect(
        sales.createOrder(
          db,
          ctx,
          { channelId: CHANNEL, totalPyg: "99999", lines: [oneLine(V_TEN)] },
          deps,
        ),
      ).rejects.toThrow("El total no coincide con el que calcula el sistema");
      expect(
        await count("SELECT count(*)::int AS n FROM app.sale_orders WHERE tenant_id = $1", [
          TENANT,
        ]),
      ).toBe(before);

      const accepted = await sales.createOrder(
        db,
        ctx,
        { channelId: CHANNEL, totalPyg: "100000", lines: [oneLine(V_TEN)] },
        deps,
      );
      expect(accepted.totalPyg).toBe("100000");
    });

    it("RN-VTA-01 · la base respalda la fórmula: un total que no cumple subtotal − descuento + envío no se puede insertar", async () => {
      await expect(
        q(
          "INSERT INTO app.sale_orders (tenant_id, channel_id, code, subtotal_pyg, discount_pyg, shipping_pyg, total_pyg) VALUES ($1, $2, 'VTA-RAW-0001', 100000, 10000, 0, 100000)",
          [TENANT, CHANNEL],
        ),
      ).rejects.toThrow("order_total_consistent");
    });

    it("docs/domain-rules.md caso borde 19 · un descuento mayor al subtotal se rechaza y uno igual deja el pedido en cero", async () => {
      await expect(
        sales.createOrder(
          db,
          ctx,
          { channelId: CHANNEL, discountPyg: "100001", lines: [oneLine(V_TEN)] },
          deps,
        ),
      ).rejects.toThrow("El descuento no puede ser mayor al subtotal del pedido.");

      const free = await sales.createOrder(
        db,
        ctx,
        { channelId: CHANNEL, discountPyg: "100000", lines: [oneLine(V_TEN)] },
        deps,
      );
      expect(free).toMatchObject({
        subtotalPyg: "100000",
        discountPyg: "100000",
        totalPyg: "0",
        vat10Pyg: "0",
      });
    });

    it("RN-IVA-02 · el descuento del pedido se reparte entre las líneas y el IVA sale de lo que se paga", async () => {
      const order = await sales.createOrder(
        db,
        ctx,
        { channelId: CHANNEL, discountPyg: "15000", lines: [oneLine(V_TEN), oneLine(V_FIVE)] },
        deps,
      );

      expect(order).toMatchObject({
        subtotalPyg: "150000",
        discountPyg: "15000",
        totalPyg: "135000",
        vat10Pyg: "8182",
        vat5Pyg: "2143",
        exemptPyg: "0",
      });
      expect(order.lines.map((line) => [line.lineTotalPyg, line.vatPyg])).toEqual([
        ["100000", "8182"],
        ["50000", "2143"],
      ]);
    });

    it("RN-IVA-03 · tres líneas de Gs. 33.333 al 10%: la diferencia de redondeo queda en la tercera y el pedido declara 9.091", async () => {
      const order = await sales.createOrder(
        db,
        ctx,
        {
          channelId: CHANNEL,
          lines: [oneLine(V_THIRD), oneLine(V_THIRD), oneLine(V_THIRD)],
        },
        deps,
      );

      expect(order.totalPyg).toBe("99999");
      expect(order.vat10Pyg).toBe("9091");
      expect(order.lines.map((line) => line.vatPyg)).toEqual(["3030", "3030", "3031"]);
    });

    it("RN-VTA-04 · una variante serializada se vende de a una unidad, eligiéndola, y la unidad tiene que estar disponible", async () => {
      const attempt = (line: Record<string, unknown>) =>
        sales.createOrder(
          db,
          ctx,
          { channelId: CHANNEL, lines: [line as { variantId: string; qty: string }] },
          deps,
        );

      await expect(attempt(oneLine(V_WATCH))).rejects.toThrow(
        "Una variante serializada se vende de a una unidad, eligiendo cuál.",
      );
      await expect(attempt({ variantId: V_WATCH, qty: "2", serialUnitId: UNIT_1 })).rejects.toThrow(
        "Una variante serializada se vende de a una unidad, eligiendo cuál.",
      );
      await expect(attempt({ variantId: V_TEN, qty: "1", serialUnitId: UNIT_1 })).rejects.toThrow(
        "Solo una variante serializada lleva una unidad elegida.",
      );
      await expect(
        attempt({ variantId: V_WATCH, qty: "1", serialUnitId: UNIT_SOLD }),
      ).rejects.toThrow("Una unidad no está disponible.");
      await expect(
        attempt({ variantId: V_WATCH, qty: "1", serialUnitId: UNIT_OF_OTHER_VARIANT }),
      ).rejects.toThrow("Una unidad no está disponible.");
      await expect(
        sales.createOrder(
          db,
          ctx,
          {
            channelId: CHANNEL,
            lines: [
              { variantId: V_WATCH, qty: "1", serialUnitId: UNIT_2 },
              { variantId: V_WATCH, qty: "1", serialUnitId: UNIT_2 },
            ],
          },
          deps,
        ),
      ).rejects.toThrow("Una unidad no se puede vender dos veces.");

      const sold = await attempt({ variantId: V_WATCH, qty: "1", serialUnitId: UNIT_2 });
      expect(sold.lines[0]).toMatchObject({
        serialUnitId: UNIT_2,
        qty: "1",
        lineTotalPyg: "1500000",
      });
    });

    it("ADR-016 · no vende con el canal, el cliente, la variante ni la unidad de otro tenant, ni lee o toca sus pedidos", async () => {
      const foreign = await sales.createOrder(
        db,
        otherCtx,
        { channelId: OTHER_CHANNEL, customerId: OTHER_CUSTOMER, lines: [oneLine(V_OTHER)] },
        deps,
      );

      await expect(
        sales.createOrder(db, ctx, { channelId: OTHER_CHANNEL, lines: [oneLine(V_TEN)] }, deps),
      ).rejects.toThrow("El canal de venta no está disponible.");
      await expect(
        sales.createOrder(
          db,
          ctx,
          { channelId: CHANNEL, customerId: OTHER_CUSTOMER, lines: [oneLine(V_TEN)] },
          deps,
        ),
      ).rejects.toThrow("El cliente no está disponible.");
      await expect(
        sales.createOrder(db, ctx, { channelId: CHANNEL, lines: [oneLine(V_OTHER)] }, deps),
      ).rejects.toThrow("Una variante no está disponible.");
      await expect(
        sales.createOrder(
          db,
          ctx,
          {
            channelId: CHANNEL,
            lines: [{ variantId: V_OTHER_WATCH, qty: "1", serialUnitId: UNIT_FOREIGN }],
          },
          deps,
        ),
      ).rejects.toThrow("Una variante no está disponible.");
      await expect(
        sales.createOrder(
          db,
          ctx,
          {
            channelId: CHANNEL,
            lines: [{ variantId: V_WATCH, qty: "1", serialUnitId: UNIT_FOREIGN }],
          },
          deps,
        ),
      ).rejects.toThrow("Una unidad no está disponible.");

      expect((await sales.listOrders(db, ctx, {})).items.map((order) => order.id)).not.toContain(
        foreign.id,
      );
      await expect(sales.getOrder(db, ctx, foreign.id)).rejects.toThrow("No encontrado.");
      await expect(
        sales.transitionOrder(db, ctx, { id: foreign.id, toStatus: "awaiting_payment" }, deps),
      ).rejects.toThrow("No encontrado.");
      await expect(sales.removeOrder(db, ctx, foreign.id)).rejects.toThrow("No encontrado.");
      expect(
        (
          await q<{ status: string }>("SELECT status FROM app.sale_orders WHERE id = $1", [
            foreign.id,
          ])
        ).rows[0]!.status,
      ).toBe("draft");
    });

    it("RF-VTA-01 · no vende por un canal dado de baja ni a un cliente dado de baja", async () => {
      await expect(
        sales.createOrder(db, ctx, { channelId: INACTIVE_CHANNEL, lines: [oneLine(V_TEN)] }, deps),
      ).rejects.toThrow("El canal de venta no está disponible.");
      await expect(
        sales.createOrder(
          db,
          ctx,
          { channelId: CHANNEL, customerId: INACTIVE_CUSTOMER, lines: [oneLine(V_TEN)] },
          deps,
        ),
      ).rejects.toThrow("El cliente no está disponible.");
    });

    it("RN-EST-02 · pasa de borrador a espera de pago con su fecha, su historial y su bitácora, sin tocar inventario", async () => {
      const draft = await sales.createOrder(
        db,
        ctx,
        { channelId: CHANNEL, lines: [oneLine(V_TEN)] },
        deps,
      );

      const awaiting = await sales.transitionOrder(
        db,
        ctx,
        { id: draft.id, toStatus: "awaiting_payment", reason: "El cliente va a pagar con tarjeta" },
        deps,
      );

      expect(awaiting).toMatchObject({
        status: "awaiting_payment",
        placedAt: "2026-10-12T15:00:00.000Z",
        cancelledAt: null,
      });
      expect(awaiting.transitions).toEqual([
        {
          id: expect.any(String),
          fromStatus: "draft",
          toStatus: "awaiting_payment",
          actorId: STAFF,
          audience: "staff",
          reason: "El cliente va a pagar con tarjeta",
          occurredAt: "2026-10-12T15:00:00.000Z",
        },
      ]);
      const audit = await q<{ action: string; before: unknown; after: unknown }>(
        "SELECT action, before, after FROM app.audit_log WHERE entity_id = $1 ORDER BY id",
        [draft.id],
      );
      expect(audit.rows).toEqual([
        expect.objectContaining({ action: "sales.order.create" }),
        {
          action: "sales.order.transition",
          before: { status: "draft" },
          after: { status: "awaiting_payment" },
        },
      ]);
      expect(await count("SELECT count(*)::int AS n FROM app.inventory_movements")).toBe(0);
    });

    it("RN-EST-02 · rechaza una transición inválida con su origen y su destino", async () => {
      const draft = await sales.createOrder(
        db,
        ctx,
        { channelId: CHANNEL, lines: [oneLine(V_TEN)] },
        deps,
      );
      await sales.transitionOrder(db, ctx, { id: draft.id, toStatus: "awaiting_payment" }, deps);

      await expect(
        sales.transitionOrder(db, ctx, { id: draft.id, toStatus: "awaiting_payment" }, deps),
      ).rejects.toThrow("El pedido no puede pasar de awaiting_payment a awaiting_payment.");
      expect((await sales.getOrder(db, ctx, draft.id)).transitions).toHaveLength(1);
    });

    it("RN-EST-02 · cancela un borrador, y un pedido cobrado o ya cancelado no se cancela", async () => {
      const draft = await sales.createOrder(
        db,
        ctx,
        { channelId: CHANNEL, lines: [oneLine(V_TEN)] },
        deps,
      );

      const cancelled = await sales.transitionOrder(
        db,
        ctx,
        { id: draft.id, toStatus: "cancelled", reason: "Se arrepintió" },
        deps,
      );
      expect(cancelled).toMatchObject({
        status: "cancelled",
        cancelledAt: "2026-10-12T15:00:00.000Z",
        placedAt: null,
      });
      await expect(
        sales.transitionOrder(db, ctx, { id: draft.id, toStatus: "awaiting_payment" }, deps),
      ).rejects.toThrow("El pedido no puede pasar de cancelled a awaiting_payment.");

      // Un pedido cobrado (lo deja WP-C19; acá se arma a mano) solo sale por devolución.
      const paid = await sales.createOrder(
        db,
        ctx,
        { channelId: CHANNEL, lines: [oneLine(V_TEN)] },
        deps,
      );
      await q("UPDATE app.sale_orders SET status = 'awaiting_payment' WHERE id = $1", [paid.id]);
      await q("UPDATE app.sale_orders SET status = 'paid' WHERE id = $1", [paid.id]);
      await expect(
        sales.transitionOrder(db, ctx, { id: paid.id, toStatus: "cancelled" }, deps),
      ).rejects.toThrow("El pedido no puede pasar de paid a cancelled.");
    });

    it("RN-EST-02 · cancelar un pedido que espera el pago todavía no se puede: falta soltar la reserva (WP-C18) y las órdenes de fraccionamiento (WP-C13c)", async () => {
      const draft = await sales.createOrder(
        db,
        ctx,
        { channelId: CHANNEL, lines: [oneLine(V_TEN)] },
        deps,
      );
      await sales.transitionOrder(db, ctx, { id: draft.id, toStatus: "awaiting_payment" }, deps);

      await expect(
        sales.transitionOrder(db, ctx, { id: draft.id, toStatus: "cancelled" }, deps),
      ).rejects.toThrow("Un pedido que espera el pago todavía no se puede cancelar.");
      expect((await sales.getOrder(db, ctx, draft.id)).status).toBe("awaiting_payment");
    });

    it("hallazgo de WP-B11d · un borrador creado por la API se borra con sus líneas, y la creación y la baja quedan en la bitácora", async () => {
      const draft = await sales.createOrder(
        db,
        ctx,
        { channelId: CHANNEL, lines: [oneLine(V_TEN), oneLine(V_FIVE)] },
        deps,
      );

      await sales.removeOrder(db, ctx, draft.id);

      await expect(sales.getOrder(db, ctx, draft.id)).rejects.toThrow("No encontrado.");
      expect(
        await count(
          "SELECT count(*)::int AS n FROM app.sale_order_lines WHERE sale_order_id = $1",
          [draft.id],
        ),
      ).toBe(0);
      const audit = await q<{ action: string; before: unknown; after: unknown }>(
        "SELECT action, before, after FROM app.audit_log WHERE entity_id = $1 ORDER BY id",
        [draft.id],
      );
      expect(audit.rows.map((row) => row.action)).toEqual([
        "sales.order.create",
        "sales.order.remove",
      ]);
      expect(audit.rows[1]).toMatchObject({
        before: {
          status: "draft",
          code: draft.code,
          channelId: CHANNEL,
          customerId: null,
          totalPyg: "150000",
          lineCount: 2,
        },
        after: null,
      });
    });

    it("RN-VTA-03 · un pedido que ya salió de borrador no se borra: se cancela o se anula", async () => {
      const awaiting = await sales.createOrder(
        db,
        ctx,
        { channelId: CHANNEL, lines: [oneLine(V_TEN)] },
        deps,
      );
      await sales.transitionOrder(db, ctx, { id: awaiting.id, toStatus: "awaiting_payment" }, deps);
      const cancelled = await sales.createOrder(
        db,
        ctx,
        { channelId: CHANNEL, lines: [oneLine(V_TEN)] },
        deps,
      );
      await sales.transitionOrder(db, ctx, { id: cancelled.id, toStatus: "cancelled" }, deps);

      for (const id of [awaiting.id, cancelled.id]) {
        await expect(sales.removeOrder(db, ctx, id)).rejects.toThrow(
          "Solo se puede borrar un pedido en borrador.",
        );
        expect((await sales.getOrder(db, ctx, id)).id).toBe(id);
      }
    });

    it("hallazgo de WP-B11d · un borrador con una seña enganchada no se borra: responde 409 y la seña queda intacta", async () => {
      const draft = await sales.createOrder(
        db,
        ctx,
        { channelId: CHANNEL, customerId: CUSTOMER, lines: [oneLine(V_TEN)] },
        deps,
      );
      await q(
        "INSERT INTO app.customer_deposits (tenant_id, customer_id, sale_order_id, amount_pyg) VALUES ($1, $2, $3, 50000)",
        [TENANT, CUSTOMER, draft.id],
      );
      const app = appFor({
        userId: STAFF,
        sessionId: SESSION,
        granted: ["sales.order:write"],
      });
      try {
        const response = await app.inject({
          method: "POST",
          url: "/trpc/sales.order.remove",
          payload: { id: draft.id },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json().error.data.appCode).toBe("CONFLICT_ORDER_HAS_DEPOSIT");
        expect((await sales.getOrder(db, ctx, draft.id)).status).toBe("draft");
        expect(
          await count(
            "SELECT count(*)::int AS n FROM app.customer_deposits WHERE sale_order_id = $1",
            [draft.id],
          ),
        ).toBe(1);
      } finally {
        await app.close();
      }
    });

    it("docs/security-spec.md §3.1 · no confirma ni audita un borrado que RLS ocultó (sin sales.order:write en la base)", async () => {
      const draft = await sales.createOrder(
        db,
        ctx,
        { channelId: CHANNEL, lines: [oneLine(V_TEN)] },
        deps,
      );
      // El router cree que puede (permiso concedido a mano); la base, que no.
      const app = appFor({
        userId: READER,
        sessionId: READER_SESSION,
        granted: ["sales.order:write", "sales.order:read"],
      });
      try {
        const response = await app.inject({
          method: "POST",
          url: "/trpc/sales.order.remove",
          payload: { id: draft.id },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json().error.data.appCode).toBe("FORBIDDEN_INSUFFICIENT_PERMISSION");
        expect((await sales.getOrder(db, ctx, draft.id)).status).toBe("draft");
        const audit = await q<{ action: string }>(
          "SELECT action FROM app.audit_log WHERE entity_id = $1 ORDER BY id",
          [draft.id],
        );
        expect(audit.rows.map((row) => row.action)).toEqual(["sales.order.create"]);
      } finally {
        await app.close();
      }
    });

    it("docs/api-conventions.md §9 · crear exige sales.order:write y el vendedor sembrado puede, con el reloj inyectado", async () => {
      const denied = appFor({
        userId: READER,
        sessionId: READER_SESSION,
        granted: ["sales.order:read"],
      });
      const allowed = appFor({
        userId: SELLER,
        sessionId: SELLER_SESSION,
        granted: ["sales.order:read", "sales.order:write"],
      });
      const payload = { channelId: CHANNEL, lines: [oneLine(V_TEN)] };
      try {
        const rejected = await denied.inject({
          method: "POST",
          url: "/trpc/sales.order.create",
          payload,
        });
        expect(rejected.statusCode).toBe(403);

        const created = await allowed.inject({
          method: "POST",
          url: "/trpc/sales.order.create",
          headers: { "user-agent": "sales-http-test" },
          payload,
        });
        expect(created.statusCode).toBe(200);
        const data = created.json().result.data;
        expect(data).toMatchObject({ status: "draft", createdBy: SELLER, totalPyg: "100000" });
        expect(data.code).toMatch(/^VTA-2026-\d{4}$/);

        const read = await allowed.inject({
          method: "GET",
          url: `/trpc/sales.order.byId?input=${encodeURIComponent(JSON.stringify({ id: data.id }))}`,
        });
        expect(read.statusCode).toBe(200);
        expect(read.json().result.data.id).toBe(data.id);
      } finally {
        await denied.close();
        await allowed.close();
      }
    });

    it("migración 0037 · el costo de lo vendido no sale en el pedido que lee el vendedor", async () => {
      const order = await sales.createOrder(
        db,
        ctx,
        { channelId: CHANNEL, lines: [oneLine(V_TEN)] },
        deps,
      );
      // El costo lo escribe WP-C19 al confirmar; acá se deja a mano para ver que no viaja.
      await q("UPDATE app.sale_orders SET cogs_pyg = 123456 WHERE id = $1", [order.id]);
      await q("UPDATE app.sale_order_lines SET cogs_pyg = 123456 WHERE sale_order_id = $1", [
        order.id,
      ]);

      const read = await sales.getOrder(db, ctx, order.id);
      const listed = (await sales.listOrders(db, ctx, {})).items.find(
        (item) => item.id === order.id,
      );

      expect(JSON.stringify(read)).not.toContain("123456");
      expect(JSON.stringify(read)).not.toContain("cogs");
      expect(JSON.stringify(listed)).not.toContain("123456");
    });

    it("docs/api-conventions.md §6 · lista con cursor y filtra por estado, solo del tenant de la sesión", async () => {
      const first = await sales.createOrder(
        db,
        otherCtx,
        { channelId: OTHER_CHANNEL, lines: [oneLine(V_OTHER)] },
        deps,
      );
      const second = await sales.createOrder(
        db,
        otherCtx,
        { channelId: OTHER_CHANNEL, lines: [oneLine(V_OTHER)] },
        deps,
      );
      await sales.transitionOrder(db, otherCtx, { id: second.id, toStatus: "cancelled" }, deps);

      const page1 = await sales.listOrders(db, otherCtx, { limit: 1 });
      const page2 = await sales.listOrders(db, otherCtx, { limit: 1, cursor: page1.nextCursor! });
      const cancelled = await sales.listOrders(db, otherCtx, { status: "cancelled" });

      expect(page1.items).toHaveLength(1);
      expect(page1.nextCursor).not.toBeNull();
      // Del más nuevo al más viejo: la segunda orden, después la primera.
      expect(page1.items.map((item) => item.id)).toEqual([second.id]);
      expect(page2.items.map((item) => item.id)).toEqual([first.id]);
      expect(cancelled.items.map((item) => item.id)).toEqual([second.id]);
      await expect(sales.listOrders(db, otherCtx, { cursor: "no-es-un-cursor" })).rejects.toThrow(
        "El cursor de paginación no es válido.",
      );
    });

    it("numeración · los códigos son consecutivos por tenant y año, también con pedidos simultáneos", async () => {
      const make = (context: sales.SalesContext, now: Date) =>
        sales.createOrder(
          db,
          context,
          { channelId: CODES_CHANNEL, lines: [oneLine(V_CODES)] },
          { clock: { now: () => now } },
        );
      const codes = async (promises: Promise<{ code: string }>[]) =>
        (await Promise.all(promises)).map((order) => order.code).sort();

      expect(await codes([make(codesCtx, NOW)])).toEqual(["VTA-2026-0001"]);
      expect(await codes([make(codesCtx, NOW)])).toEqual(["VTA-2026-0002"]);
      expect(
        await codes([
          make(codesCtx, NOW),
          make(codesCtx, NOW),
          make(codesCtx, NOW),
          make(codesCtx, NOW),
          make(codesCtx, NOW),
        ]),
      ).toEqual([
        "VTA-2026-0003",
        "VTA-2026-0004",
        "VTA-2026-0005",
        "VTA-2026-0006",
        "VTA-2026-0007",
      ]);
    });

    it("numeración · el año es el de Paraguay y cada año reinicia; un código de otro formato no la altera", async () => {
      const make = (iso: string) =>
        sales.createOrder(
          db,
          codesCtx,
          { channelId: CODES_CHANNEL, lines: [oneLine(V_CODES)] },
          { clock: { now: () => new Date(iso) } },
        );
      // Los pedidos que traiga la migración de datos pueden tener otro formato.
      await q(
        "INSERT INTO app.sale_orders (tenant_id, channel_id, code) VALUES ($1, $2, 'PWA-99999999')",
        [CODES_TENANT, CODES_CHANNEL],
      );

      // 2027-01-01 02:30 UTC es el 31 de diciembre, 23:30, en Asunción (UTC−3).
      expect((await make("2027-01-01T02:30:00.000Z")).code).toBe("VTA-2026-0008");
      expect((await make("2027-01-01T03:30:00.000Z")).code).toBe("VTA-2027-0001");
    });
  },
);
