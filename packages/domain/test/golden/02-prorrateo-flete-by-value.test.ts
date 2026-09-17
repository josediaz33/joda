// Dataset dorado · ver README.md de este directorio y
// docs/domain-contracts.md §8.1. Ejemplo YA REDACTADO en
// docs/domain-rules.md (ver "origen" en el .json hermano), no una
// operación real. `qty` es obligatorio en `FreightLine` pero `by_value`
// no lo usa como peso — Quantity.units(1) es relleno estructural, no un
// dato citado por la nota.
import { describe, expect, it } from "vitest";
import { allocateFreight, type FreightLine } from "../../src/procurement/freight.js";
import { Money } from "../../src/shared/money.js";
import { Quantity } from "../../src/shared/quantity.js";
import caseData from "./02-prorrateo-flete-by-value.json" with { type: "json" };

describe(`${caseData.regla} · dataset dorado (${caseData.origen}) · ${caseData.id}`, () => {
  it(caseData.nota, () => {
    const lines: FreightLine[] = caseData.input.lines.map((line) => ({
      id: line.id,
      value: Money.of(BigInt(line.valuePygMinor), "PYG"),
      qty: Quantity.units(1),
    }));

    const result = allocateFreight({
      freight: Money.of(BigInt(caseData.input.freightPygMinor), "PYG"),
      method: "by_value",
      lines,
    });

    if (!result.ok) throw new Error(`allocateFreight falló: ${JSON.stringify(result.error)}`);

    for (const [lineId, expectedMinor] of Object.entries(caseData.expected.freightByLineId)) {
      expect(result.value.get(lineId)?.minor).toBe(BigInt(expectedMinor));
    }
  });
});
