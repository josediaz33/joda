// Dataset dorado · ver README.md de este directorio y
// docs/domain-contracts.md §8.1. Este caso viene de un ejemplo YA
// REDACTADO en docs/domain-rules.md, no de una operación real (ver
// "origen" en el .json hermano) — confirma que un refactor no cambió el
// cálculo, no que el cálculo coincida con una compra real de JODA.
import { describe, expect, it } from "vitest";
import { computeLandedCost, computeUnitLandedCost } from "../../src/procurement/landedCost.js";
import { Money } from "../../src/shared/money.js";
import { Quantity } from "../../src/shared/quantity.js";
import caseData from "./01-compra-usd-con-flete.json" with { type: "json" };

describe(`${caseData.regla} · dataset dorado (${caseData.origen}) · ${caseData.id}`, () => {
  it(caseData.nota, () => {
    const landedCost = computeLandedCost({
      components: {
        supplierPrice: Money.of(BigInt(caseData.input.supplierPriceUsdMinor), "USD"),
        freight: Money.of(BigInt(caseData.input.freightUsdMinor), "USD"),
      },
      fxRateToPyg: caseData.input.fxRateToPyg,
    });

    expect(landedCost.minor).toBe(BigInt(caseData.expected.landedCostPygMinor));

    const unitLandedCost = computeUnitLandedCost(
      landedCost,
      Quantity.ml(caseData.input.qtyInitialMl),
    );

    expect(unitLandedCost.minor).toBe(BigInt(caseData.expected.unitLandedCostPygMinorPerMl));
  });
});
