import { describe, expect, it } from "vitest";
import { Money } from "../shared/money.js";
import {
  canTransitionSaleOrder,
  computeSaleOrderTotals,
  transitionSaleOrder,
  type SaleOrderStatus,
} from "./order.js";

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
    ["paid", "cancelled", false],
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

  it("paid tampoco admite cancelled, solo refunded: al confirmarse el pago ya se consumió inventario (RN-VTA-02), revertirlo es la anulación de RN-VTA-03, no un no-op", () => {
    expect(canTransitionSaleOrder("paid", "cancelled")).toBe(false);
    expect(canTransitionSaleOrder("paid", "refunded")).toBe(true);
  });

  it("cancelable únicamente desde draft y awaiting_payment — los dos estados donde RN-VTA-02 garantiza que no hay movimiento de inventario", () => {
    expect(canTransitionSaleOrder("draft", "cancelled")).toBe(true);
    expect(canTransitionSaleOrder("awaiting_payment", "cancelled")).toBe(true);
    expect(canTransitionSaleOrder("paid", "cancelled")).toBe(false);
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

describe("RN-VTA-01 · total_pyg = subtotal_pyg − discount_pyg + shipping_pyg", () => {
  it("resta el descuento y suma el envío al subtotal, literal", () => {
    const result = computeSaleOrderTotals({
      subtotalPyg: Money.pyg(100_000n),
      discountPyg: Money.pyg(20_000n),
      shippingPyg: Money.pyg(15_000n),
    });

    expect(result).toEqual({
      ok: true,
      value: {
        subtotalPyg: Money.pyg(100_000n),
        discountPyg: Money.pyg(20_000n),
        shippingPyg: Money.pyg(15_000n),
        totalPyg: Money.pyg(95_000n),
      },
    });
  });

  it("sin descuento ni envío, el total es el subtotal", () => {
    const result = computeSaleOrderTotals({
      subtotalPyg: Money.pyg(50_000n),
      discountPyg: Money.pyg(0n),
      shippingPyg: Money.pyg(0n),
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.totalPyg).toEqual(Money.pyg(50_000n));
  });
});

describe("RN-VTA-01 · caso borde #19 — total_pyg negativo se rechaza, nunca se trunca a cero", () => {
  it("descuento mayor al subtotal sin envío que lo compense: err() con NEGATIVE_TOTAL", () => {
    const result = computeSaleOrderTotals({
      subtotalPyg: Money.pyg(50_000n),
      discountPyg: Money.pyg(80_000n),
      shippingPyg: Money.pyg(0n),
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "NEGATIVE_TOTAL",
        subtotalPyg: Money.pyg(50_000n),
        discountPyg: Money.pyg(80_000n),
        shippingPyg: Money.pyg(0n),
      },
    });
  });

  it("total exactamente cero (descuento = subtotal + envío) se acepta: cero no es negativo", () => {
    const result = computeSaleOrderTotals({
      subtotalPyg: Money.pyg(50_000n),
      discountPyg: Money.pyg(50_000n),
      shippingPyg: Money.pyg(0n),
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.totalPyg).toEqual(Money.pyg(0n));
  });

  it("un descuento mayor al subtotal se acepta si el envío compensa lo suficiente: la regla es total_pyg ≥ 0, no descuento ≤ subtotal", () => {
    const result = computeSaleOrderTotals({
      subtotalPyg: Money.pyg(50_000n),
      discountPyg: Money.pyg(80_000n),
      shippingPyg: Money.pyg(30_000n),
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.totalPyg).toEqual(Money.pyg(0n));
  });
});
