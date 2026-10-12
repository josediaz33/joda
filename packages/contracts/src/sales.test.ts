import { describe, expect, it } from "vitest";
import {
  createSaleOrderInput,
  saleOrderLineSchema,
  saleOrderSchema,
  saleOrderTransitionSchema,
  transitionSaleOrderInput,
} from "./sales.js";

const VARIANT = "77777777-7777-4777-a777-777777777781";
const CHANNEL = "66666666-6666-4666-a666-666666666681";
const order = { channelId: CHANNEL, lines: [{ variantId: VARIANT, qty: "2" }] };

describe("docs/api-conventions.md §3 · contrato de entrada de ventas", () => {
  it("acepta un pedido mínimo, con descuento, cliente y total esperado", () => {
    expect(createSaleOrderInput.safeParse(order).success).toBe(true);
    expect(
      createSaleOrderInput.safeParse({
        ...order,
        customerId: "55555555-5555-4555-a555-555555555581",
        discountPyg: "15000",
        totalPyg: "485000",
        notes: "Retira el viernes",
      }).success,
    ).toBe(true);
  });

  it("rechaza atributos ajenos: el precio de la línea, el estado y el costo no los fija el cliente", () => {
    expect(
      createSaleOrderInput.safeParse({
        ...order,
        lines: [{ variantId: VARIANT, qty: "2", unitPricePyg: "1" }],
      }).success,
    ).toBe(false);
    expect(createSaleOrderInput.safeParse({ ...order, status: "paid" }).success).toBe(false);
    expect(createSaleOrderInput.safeParse({ ...order, cogsPyg: "0" }).success).toBe(false);
    expect(createSaleOrderInput.safeParse({ ...order, shippingPyg: "0" }).success).toBe(false);
  });

  it("rechaza importes numéricos, negativos o con ceros a la izquierda: el dinero viaja como string de enteros", () => {
    expect(createSaleOrderInput.safeParse({ ...order, discountPyg: 15000 }).success).toBe(false);
    expect(createSaleOrderInput.safeParse({ ...order, discountPyg: "-1" }).success).toBe(false);
    expect(createSaleOrderInput.safeParse({ ...order, totalPyg: "0485000" }).success).toBe(false);
    expect(createSaleOrderInput.safeParse({ ...order, totalPyg: "1500.5" }).success).toBe(false);
  });

  it("rechaza cantidades que no son un entero positivo de hasta seis dígitos", () => {
    const withQty = (qty: string) => ({ ...order, lines: [{ variantId: VARIANT, qty }] });

    expect(createSaleOrderInput.safeParse(withQty("999999")).success).toBe(true);
    expect(createSaleOrderInput.safeParse(withQty("0")).success).toBe(false);
    expect(createSaleOrderInput.safeParse(withQty("1.5")).success).toBe(false);
    expect(createSaleOrderInput.safeParse(withQty("1000000")).success).toBe(false);
    expect(createSaleOrderInput.safeParse(withQty("-1")).success).toBe(false);
  });

  it("exige entre una y cien líneas", () => {
    const manyLines = Array.from({ length: 101 }, () => ({ variantId: VARIANT, qty: "1" }));

    expect(createSaleOrderInput.safeParse({ ...order, lines: [] }).success).toBe(false);
    expect(createSaleOrderInput.safeParse({ ...order, lines: manyLines }).success).toBe(false);
    expect(createSaleOrderInput.safeParse({ ...order, lines: manyLines.slice(1) }).success).toBe(
      true,
    );
  });

  it("la unidad serializada es opcional y se rechaza si no es un uuid", () => {
    const withSerial = (serialUnitId: string | null) => ({
      ...order,
      lines: [{ variantId: VARIANT, qty: "1", serialUnitId }],
    });

    expect(
      createSaleOrderInput.safeParse(withSerial("44444444-4444-4444-a444-444444444481")).success,
    ).toBe(true);
    expect(createSaleOrderInput.safeParse(withSerial(null)).success).toBe(true);
    expect(createSaleOrderInput.safeParse(withSerial("no-es-uuid")).success).toBe(false);
  });
});

describe("RN-EST-02 · solo se piden por la API las transiciones que no tocan inventario ni cobro", () => {
  const id = "33333333-3333-4333-a333-333333333381";

  it("acepta pasar a espera de pago y cancelar", () => {
    expect(transitionSaleOrderInput.safeParse({ id, toStatus: "awaiting_payment" }).success).toBe(
      true,
    );
    expect(
      transitionSaleOrderInput.safeParse({ id, toStatus: "cancelled", reason: "Se arrepintió" })
        .success,
    ).toBe(true);
  });

  it("rechaza cobrar, preparar o devolver: son de otros WP", () => {
    expect(transitionSaleOrderInput.safeParse({ id, toStatus: "paid" }).success).toBe(false);
    expect(transitionSaleOrderInput.safeParse({ id, toStatus: "refunded" }).success).toBe(false);
    expect(transitionSaleOrderInput.safeParse({ id, toStatus: "draft" }).success).toBe(false);
  });
});

// Claves que un vendedor no puede ver (`.claude/rules/contracts.md`; 0037, WP-B11f):
// `sales.order:read` no incluye costos y `sale_orders.cogs_pyg` es costo.
describe("docs/api-conventions.md §7 · el pedido que lee el vendedor no trae el costo de lo vendido", () => {
  const FORBIDDEN = ["cogs", "cost", "landed", "supplier", "margin", "fxrate"];
  const keysOf = (shape: Record<string, unknown>) =>
    Object.keys(shape).map((key) => key.toLowerCase().replaceAll("_", ""));

  it.each([
    ["saleOrderSchema", saleOrderSchema.shape],
    ["saleOrderLineSchema", saleOrderLineSchema.shape],
    ["saleOrderTransitionSchema", saleOrderTransitionSchema.shape],
  ])("%s no tiene ninguna clave prohibida", (_name, shape) => {
    expect(keysOf(shape).filter((key) => FORBIDDEN.some((word) => key.includes(word)))).toEqual([]);
  });
});
