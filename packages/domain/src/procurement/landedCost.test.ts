import { describe, expect, it } from "vitest";
import { CurrencyMismatchError, InvalidLandedCostInputError } from "../shared/errors.js";
import { Money } from "../shared/money.js";
import { Quantity } from "../shared/quantity.js";
import { computeLandedCost, computeUnitLandedCost } from "./landedCost.js";

describe("RN-COS-01 · costo puesto — (precio + flete + despacho + otros) × fx real de la recepción", () => {
  it("frasco de Layton 125 ml: USD 190,00 de precio + USD 15,00 de flete y despacho, dólar a 7.300, da Gs. 1.496.500", () => {
    const landed = computeLandedCost({
      components: {
        supplierPrice: Money.of(19_000n, "USD"),
        freight: Money.of(1_500n, "USD"),
      },
      fxRateToPyg: 7300,
    });

    expect(landed.currency).toBe("PYG");
    expect(landed.minor).toBe(1_496_500n);
  });

  it("suma los cuatro componentes — precio, flete, despacho y otros — antes de convertir una sola vez", () => {
    const landed = computeLandedCost({
      components: {
        supplierPrice: Money.of(19_000n, "USD"),
        freight: Money.of(1_000n, "USD"),
        customsClearance: Money.of(500n, "USD"),
        other: Money.of(300n, "USD"),
      },
      fxRateToPyg: 7300,
    });

    // (19000 + 1000 + 500 + 300) / 100 × 7300 = 208 × 7300 = 1.518.400
    expect(landed.minor).toBe(1_518_400n);
  });

  it("solo el precio del proveedor, sin flete ni despacho ni otros", () => {
    const landed = computeLandedCost({
      components: { supplierPrice: Money.of(19_000n, "USD") },
      fxRateToPyg: 7300,
    });

    expect(landed.minor).toBe(1_387_000n);
  });

  it("usa el fx REAL de la recepción, no un valor fijo: cambiarlo cambia el resultado", () => {
    const landedConFxDeLaOrden = computeLandedCost({
      components: { supplierPrice: Money.of(19_000n, "USD") },
      fxRateToPyg: 7100, // estimado de la orden, distinto del real
    });
    const landedConFxReal = computeLandedCost({
      components: { supplierPrice: Money.of(19_000n, "USD") },
      fxRateToPyg: 7300, // real de la recepción
    });

    expect(landedConFxDeLaOrden.minor).toBe(1_349_000n);
    expect(landedConFxReal.minor).toBe(1_387_000n);
  });

  it("lanza CurrencyMismatchError si un componente viene en una moneda distinta al precio del proveedor", () => {
    expect(() =>
      computeLandedCost({
        components: {
          supplierPrice: Money.of(19_000n, "USD"),
          freight: Money.of(1_500n, "BRL"),
        },
        fxRateToPyg: 7300,
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it("lanza InvalidLandedCostInputError si los componentes ya vienen en PYG — no hay nada que convertir", () => {
    expect(() =>
      computeLandedCost({
        components: { supplierPrice: Money.pyg(1_387_000n) },
        fxRateToPyg: 7300,
      }),
    ).toThrow(InvalidLandedCostInputError);
  });

  it.each([
    [0, "cero"],
    [-7300, "negativo"],
    [Number.NaN, "no finito"],
  ])("lanza InvalidLandedCostInputError con un fxRateToPyg %s (%s)", (fxRateToPyg) => {
    expect(() =>
      computeLandedCost({
        components: { supplierPrice: Money.of(19_000n, "USD") },
        fxRateToPyg,
      }),
    ).toThrow(InvalidLandedCostInputError);
  });
});

describe("RN-COS-03 · costo unitario del lote = costo puesto / cantidad inicial", () => {
  it("el frasco de Layton anterior, convertido a granel: 1.496.500 / 125 ml = Gs. 11.972/ml", () => {
    expect(computeUnitLandedCost(Money.pyg(1_496_500n), Quantity.ml(125)).minor).toBe(11_972n);
  });

  it("redondea con roundPyg cuando la división no es exacta", () => {
    // 100.000 / 3 = 33.333,33... → 33.333 (RN-DIN-02, media unidad hacia arriba).
    expect(computeUnitLandedCost(Money.pyg(100_000n), Quantity.units(3)).minor).toBe(33_333n);
  });

  it.each([
    [0, "cero"],
    [-125, "negativa"],
  ])("lanza InvalidLandedCostInputError con una cantidad inicial %s (%s)", (qty) => {
    expect(() => computeUnitLandedCost(Money.pyg(1_496_500n), Quantity.ml(qty))).toThrow(
      InvalidLandedCostInputError,
    );
  });
});
