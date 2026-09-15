import { describe, expect, it } from "vitest";
import { canTransitionSaleOrder, transitionSaleOrder, type SaleOrderStatus } from "./order.js";

// Matriz completa: los 9 estados de sale_order_status (packages/db/
// migrations/0001_foundation.sql) contra sí mismos, 9×9 = 81 pares. Cada
// fila es la regla escrita literal, tomada de docs/domain-rules.md
// RN-EST-02.
describe("RN-EST-02 · pedido de venta — matriz completa de transiciones", () => {
  it.each([
    ["draft", "draft", false],
    ["draft", "awaiting_payment", true],
    ["draft", "paid", false],
    ["draft", "preparing", false],
    ["draft", "ready", false],
    ["draft", "shipped", false],
    ["draft", "delivered", false],
    ["draft", "cancelled", true],
    ["draft", "refunded", false],
    ["awaiting_payment", "draft", false],
    ["awaiting_payment", "awaiting_payment", false],
    ["awaiting_payment", "paid", true],
    ["awaiting_payment", "preparing", false],
    ["awaiting_payment", "ready", false],
    ["awaiting_payment", "shipped", false],
    ["awaiting_payment", "delivered", false],
    ["awaiting_payment", "cancelled", true],
    ["awaiting_payment", "refunded", false],
    ["paid", "draft", false],
    ["paid", "awaiting_payment", false],
    ["paid", "paid", false],
    ["paid", "preparing", true],
    ["paid", "ready", false],
    ["paid", "shipped", false],
    ["paid", "delivered", false],
    ["paid", "cancelled", true],
    ["paid", "refunded", true],
    ["preparing", "draft", false],
    ["preparing", "awaiting_payment", false],
    ["preparing", "paid", false],
    ["preparing", "preparing", false],
    ["preparing", "ready", true],
    ["preparing", "shipped", false],
    ["preparing", "delivered", false],
    ["preparing", "cancelled", false],
    ["preparing", "refunded", true],
    ["ready", "draft", false],
    ["ready", "awaiting_payment", false],
    ["ready", "paid", false],
    ["ready", "preparing", false],
    ["ready", "ready", false],
    ["ready", "shipped", true],
    ["ready", "delivered", false],
    ["ready", "cancelled", false],
    ["ready", "refunded", true],
    ["shipped", "draft", false],
    ["shipped", "awaiting_payment", false],
    ["shipped", "paid", false],
    ["shipped", "preparing", false],
    ["shipped", "ready", false],
    ["shipped", "shipped", false],
    ["shipped", "delivered", true],
    ["shipped", "cancelled", false],
    ["shipped", "refunded", true],
    ["delivered", "draft", false],
    ["delivered", "awaiting_payment", false],
    ["delivered", "paid", false],
    ["delivered", "preparing", false],
    ["delivered", "ready", false],
    ["delivered", "shipped", false],
    ["delivered", "delivered", false],
    ["delivered", "cancelled", false],
    ["delivered", "refunded", true],
    ["cancelled", "draft", false],
    ["cancelled", "awaiting_payment", false],
    ["cancelled", "paid", false],
    ["cancelled", "preparing", false],
    ["cancelled", "ready", false],
    ["cancelled", "shipped", false],
    ["cancelled", "delivered", false],
    ["cancelled", "cancelled", false],
    ["cancelled", "refunded", false],
    ["refunded", "draft", false],
    ["refunded", "awaiting_payment", false],
    ["refunded", "paid", false],
    ["refunded", "preparing", false],
    ["refunded", "ready", false],
    ["refunded", "shipped", false],
    ["refunded", "delivered", false],
    ["refunded", "cancelled", false],
    ["refunded", "refunded", false],
  ] satisfies [SaleOrderStatus, SaleOrderStatus, boolean][])(
    "%s → %s es %s",
    (from, to, expected) => {
      expect(canTransitionSaleOrder(from, to)).toBe(expected);
    },
  );
});

describe("RN-EST-02 · pedido de venta — preparing en adelante sale por refunded, no cancelled", () => {
  it("preparing no admite cancelled: ya se consumió inventario o se fraccionó (RN-VTA-02)", () => {
    expect(canTransitionSaleOrder("preparing", "cancelled")).toBe(false);
  });

  it("preparing sí admite refunded", () => {
    expect(canTransitionSaleOrder("preparing", "refunded")).toBe(true);
  });

  it("delivered solo admite refunded, ningún otro estado", () => {
    expect(canTransitionSaleOrder("delivered", "refunded")).toBe(true);
    expect(canTransitionSaleOrder("delivered", "cancelled")).toBe(false);
  });

  it("paid admite tanto cancelled como refunded: todavía no se consumió inventario, pero ya se cobró", () => {
    expect(canTransitionSaleOrder("paid", "cancelled")).toBe(true);
    expect(canTransitionSaleOrder("paid", "refunded")).toBe(true);
  });
});

describe("RN-EST-02 · transitionSaleOrder — Result, no excepción", () => {
  it("una transición válida devuelve ok() con el estado destino", () => {
    expect(transitionSaleOrder("paid", "preparing")).toEqual({ ok: true, value: "preparing" });
  });

  it("una transición inválida devuelve err() con el código INVALID_TRANSITION, sin lanzar", () => {
    expect(transitionSaleOrder("preparing", "cancelled")).toEqual({
      ok: false,
      error: { code: "INVALID_TRANSITION", from: "preparing", to: "cancelled" },
    });
  });
});
