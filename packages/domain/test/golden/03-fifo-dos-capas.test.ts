// Dataset dorado · ver README.md de este directorio y
// docs/domain-contracts.md §8.1. Ejemplo YA REDACTADO en
// docs/domain-rules.md (ver "origen" en el .json hermano), no una
// operación real. `receivedAtIso`/`status`/`variantType`/`uom` son
// relleno estructural que exige `LotSnapshot` — el ejemplo de
// domain-rules.md no fecha los lotes, solo dice "L-001 (más antiguo)":
// alcanza con que L-001 sea anterior a L-002.
import { describe, expect, it } from "vitest";
import { allocateFromLots, totalCost } from "../../src/inventory/costing.js";
import type { AllocationPolicy, LotSnapshot } from "../../src/inventory/allocation.js";
import { Money } from "../../src/shared/money.js";
import { Quantity } from "../../src/shared/quantity.js";
import caseData from "./03-fifo-dos-capas.json" with { type: "json" };

describe(`${caseData.regla} · dataset dorado (${caseData.origen}) · ${caseData.id}`, () => {
  it(caseData.nota, () => {
    const lots: LotSnapshot[] = caseData.input.lots.map((lot) => ({
      id: lot.id,
      receivedAt: new Date(lot.receivedAtIso),
      expiryAt: null,
      available: Quantity.units(lot.availableUnits),
      unitCost: Money.of(BigInt(lot.unitCostPygMinor), "PYG"),
      status: "available",
      variantType: "sealed",
      uom: "unit",
    }));

    const result = allocateFromLots({
      lots,
      required: Quantity.units(caseData.input.requiredUnits),
      policy: caseData.input.policy as AllocationPolicy,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(
      result.value.map((layer) => ({
        lotId: layer.lotId,
        qtyUnits: layer.qty.value,
        totalCostPygMinor: layer.totalCost.minor.toString(),
      })),
    ).toEqual(caseData.expected.layers);

    expect(totalCost(result.value).minor.toString()).toBe(caseData.expected.totalCostPygMinor);
  });
});
