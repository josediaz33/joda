// Dataset dorado · ver README.md de este directorio y
// docs/domain-contracts.md §8.1. Ejemplo YA REDACTADO en
// docs/domain-rules.md (ver "origen" en el .json hermano), no una
// operación real. `bulkLot.receivedAt`/`status`/`variantType`/`uom` y los
// ids de lote son relleno estructural que exige `LotSnapshot`/
// `BomLotSnapshot` — domain-rules.md no nombra lotes ni fechas, solo
// "granel a 11.972 Gs./ml".
import { describe, expect, it } from "vitest";
import { executeDecant, type BomLotSnapshot } from "../../src/decant/execution.js";
import type { DecantPlan } from "../../src/decant/planning.js";
import type { LotSnapshot } from "../../src/inventory/allocation.js";
import { Money } from "../../src/shared/money.js";
import { Quantity } from "../../src/shared/quantity.js";
import caseData from "./05-fraccionamiento-decant-cogs.json" with { type: "json" };

describe(`${caseData.regla} · dataset dorado (${caseData.origen}) · ${caseData.id}`, () => {
  it(caseData.nota, () => {
    const plan: DecantPlan = {
      mlExpected: Quantity.ml(caseData.input.plan.mlExpectedMl),
      wasteExpected: Quantity.ml(caseData.input.plan.wasteExpectedMl),
      mlToReserve: Quantity.ml(caseData.input.plan.mlToReserveMl),
      bomToReserve: caseData.input.plan.bomToReserve.map((component) => ({
        componentId: component.componentId,
        qty: Quantity.units(component.qtyUnits),
      })),
    };

    const bulkLot: LotSnapshot = {
      id: caseData.input.bulkLot.id,
      receivedAt: new Date("2026-01-01T00:00:00.000Z"),
      expiryAt: null,
      available: Quantity.ml(caseData.input.bulkLot.availableMl),
      unitCost: Money.of(BigInt(caseData.input.bulkLot.unitCostPygMinor), "PYG"),
      status: "open_for_decant",
      variantType: "bulk",
      uom: "ml",
    };

    const bomLots: BomLotSnapshot[] = caseData.input.bomLots.map((lot) => ({
      componentId: lot.componentId,
      lotId: lot.lotId,
      available: Quantity.units(1),
      unitCost: Money.of(BigInt(lot.unitCostPygMinor), "PYG"),
      isOptional: false,
    }));

    const result = executeDecant({
      plan,
      wasteActual: Quantity.ml(caseData.input.wasteActualMl),
      bulkLot,
      bomLots,
    });

    if (!result.ok) throw new Error(`executeDecant falló: ${JSON.stringify(result.error)}`);

    expect(result.value.costBreakdown.liquid.minor).toBe(BigInt(caseData.expected.liquidPygMinor));
    expect(result.value.costBreakdown.waste.minor).toBe(BigInt(caseData.expected.wastePygMinor));
    expect(result.value.costBreakdown.supplies.minor).toBe(
      BigInt(caseData.expected.suppliesPygMinor),
    );
    expect(result.value.cogs.minor).toBe(BigInt(caseData.expected.cogsPygMinor));
  });
});
