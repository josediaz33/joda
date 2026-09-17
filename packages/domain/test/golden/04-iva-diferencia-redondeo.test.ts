// Dataset dorado · ver README.md de este directorio y
// docs/domain-contracts.md §8.1. Ejemplo YA REDACTADO en
// docs/domain-rules.md (ver "origen" en el .json hermano), no una
// operación real.
import { describe, expect, it } from "vitest";
import { breakdownDocument, type VatRate } from "../../src/tax/vat.js";
import { Money } from "../../src/shared/money.js";
import caseData from "./04-iva-diferencia-redondeo.json" with { type: "json" };

describe(`${caseData.regla} · dataset dorado (${caseData.origen}) · ${caseData.id}`, () => {
  it(caseData.nota, () => {
    const lines = caseData.input.lines.map((line) => ({
      gross: Money.of(BigInt(line.grossPygMinor), "PYG"),
      rate: line.rate as VatRate,
    }));

    const breakdown = breakdownDocument(lines);

    expect(breakdown.lines.map((line) => line.vat.minor.toString())).toEqual(
      caseData.expected.lineVatsPygMinor,
    );
    expect(breakdown.totalGross.minor).toBe(BigInt(caseData.expected.totalGrossPygMinor));
    expect(breakdown.totalVat.minor).toBe(BigInt(caseData.expected.totalVatPygMinor));
    expect(breakdown.totalBase.minor).toBe(BigInt(caseData.expected.totalBasePygMinor));
  });
});
