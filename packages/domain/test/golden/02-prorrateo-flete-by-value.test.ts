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

/** Proyecta el mapa id → Money del resultado a id → minor, para comparar contra literales (mismo helper que procurement/freight.test.ts). */
function minorsOf(map: ReadonlyMap<string, Money>): Record<string, bigint> {
  return Object.fromEntries([...map].map(([id, money]) => [id, money.minor]));
}

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

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(minorsOf(result.value)).toEqual({
      "linea-a": BigInt(caseData.expected.freightByLineId["linea-a"]),
      "linea-b": BigInt(caseData.expected.freightByLineId["linea-b"]),
      "linea-c": BigInt(caseData.expected.freightByLineId["linea-c"]),
    });
  });
});
