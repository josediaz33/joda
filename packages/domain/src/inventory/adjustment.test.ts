import { describe, expect, it } from "vitest";
import { Money } from "../shared/money.js";
import { Quantity } from "../shared/quantity.js";
import { planInventoryAdjustment } from "./adjustment.js";

describe("Caso borde #16 del catálogo · un ajuste que dejaría el saldo negativo se rechaza", () => {
  it("saldo 5, ajuste −8 → Result de error NEGATIVE_BALANCE, sin capa de costo", () => {
    const result = planInventoryAdjustment({
      lotId: "L-001",
      currentOnHand: Quantity.units(5),
      delta: Quantity.units(-8),
      unitCost: Money.pyg(10_000n),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "NEGATIVE_BALANCE", resulting: Quantity.units(-3) },
    });
  });

  it("saldo exacto 5, ajuste −5 → resulting en cero, sí se acepta (cero no es negativo)", () => {
    const result = planInventoryAdjustment({
      lotId: "L-001",
      currentOnHand: Quantity.units(5),
      delta: Quantity.units(-5),
      unitCost: Money.pyg(10_000n),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.resulting).toEqual(Quantity.units(0));
  });
});

describe("planInventoryAdjustment · ajuste negativo (salida) registra una capa de costo", () => {
  it("saldo 100 ml, ajuste −12,5 ml a 11.972/ml → una capa con esa cantidad y costo, total_cost_pyg negativo", () => {
    const result = planInventoryAdjustment({
      lotId: "L-777",
      currentOnHand: Quantity.ml(100),
      delta: Quantity.ml(-12.5),
      unitCost: Money.pyg(11_972n),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.resulting).toEqual(Quantity.ml(87.5));
    expect(result.value.costLayer).toEqual({
      lotId: "L-777",
      qty: Quantity.ml(12.5),
      unitCost: Money.pyg(11_972n),
      totalCost: Money.pyg(149_650n),
    });
    expect(result.value.totalCost).toEqual(Money.pyg(-149_650n));
  });
});

describe("planInventoryAdjustment · ajuste positivo (entrada) no consume ninguna capa (ADR-008)", () => {
  it("saldo 10, ajuste +3 → sin costLayer ni totalCost: encontrar más stock no consume nada", () => {
    const result = planInventoryAdjustment({
      lotId: "L-001",
      currentOnHand: Quantity.units(10),
      delta: Quantity.units(3),
      unitCost: Money.pyg(10_000n),
    });

    expect(result).toEqual({
      ok: true,
      value: { resulting: Quantity.units(13), costLayer: null, totalCost: null },
    });
  });
});
