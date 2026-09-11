import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Money } from "../shared/money.js";
import { breakdownDocument, taxBase, vatFromGross } from "./vat.js";

describe("RN-IVA-01 · precio con impuesto incluido — el IVA se extrae, nunca se agrega", () => {
  // Gs. 245.000 (docs/domain-rules.md § RN-IVA-01).
  it.each([
    ["iva_10" as const, 22_273n],
    ["iva_5" as const, 11_667n],
    ["exenta" as const, 0n],
  ])("sobre Gs. 245.000 con tasa %s da %s de IVA", (rate, expected) => {
    expect(vatFromGross(Money.pyg(245_000n), rate).minor).toBe(expected);
  });

  it("10% es total/11, no total × 0.10 — Gs. 110.000 daría 11.000 con la fórmula prohibida", () => {
    // Si vatFromGross multiplicara por 0.10 en vez de dividir por 11, esto
    // daría 11_000n en lugar de 10_000n.
    expect(vatFromGross(Money.pyg(110_000n), "iva_10").minor).toBe(10_000n);
  });

  it("5% es total/21, no total × 0.05", () => {
    expect(vatFromGross(Money.pyg(210_000n), "iva_5").minor).toBe(10_000n);
  });
});

describe("RN-IVA-04 · base gravada = bruto − IVA", () => {
  it.each([
    ["iva_10" as const, 222_727n],
    ["iva_5" as const, 233_333n],
    ["exenta" as const, 245_000n],
  ])("sobre Gs. 245.000 con tasa %s la base es %s", (rate, expectedBase) => {
    expect(taxBase(Money.pyg(245_000n), rate).minor).toBe(expectedBase);
  });

  it("base + iva = bruto, exacto, para cualquier tasa", () => {
    const gross = Money.pyg(245_000n);
    for (const rate of ["iva_10", "iva_5", "exenta"] as const) {
      expect(taxBase(gross, rate).plus(vatFromGross(gross, rate)).minor).toBe(gross.minor);
    }
  });

  it("nunca es un cálculo independiente: base + iva = bruto para cualquier bruto y tasa (property)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n }),
        fc.constantFrom("iva_10" as const, "iva_5" as const, "exenta" as const),
        (minor, rate) => {
          const gross = Money.pyg(minor);
          const vat = vatFromGross(gross, rate);
          const base = taxBase(gross, rate);

          expect(base.plus(vat).minor).toBe(gross.minor);
        },
      ),
    );
  });
});

describe("RN-IVA-02 · el redondeo se resuelve a nivel de documento, no de línea", () => {
  it("tres líneas de Gs. 100.000 al 10% no generan diferencia — el IVA de documento ya coincide con la suma de línea", () => {
    const lines = [
      { gross: Money.pyg(100_000n), rate: "iva_10" as const },
      { gross: Money.pyg(100_000n), rate: "iva_10" as const },
      { gross: Money.pyg(100_000n), rate: "iva_10" as const },
    ];

    const result = breakdownDocument(lines);

    expect(result.lines.map((l) => l.vat.minor)).toEqual([9_091n, 9_091n, 9_091n]);
    expect(result.totalVat.minor).toBe(27_273n);
  });
});

describe("RN-IVA-03 · la diferencia de redondeo se imputa a la última línea de la tasa", () => {
  it("tres líneas de Gs. 33.333 al 10% dan [3030, 3030, 3031] por línea y 9091 de total (docs/domain-contracts.md §8)", () => {
    const lines = [
      { gross: Money.pyg(33_333n), rate: "iva_10" as const },
      { gross: Money.pyg(33_333n), rate: "iva_10" as const },
      { gross: Money.pyg(33_333n), rate: "iva_10" as const },
    ];

    const result = breakdownDocument(lines);

    expect(result.lines.map((l) => l.vat.minor)).toEqual([3_030n, 3_030n, 3_031n]);
    expect(result.totalVat.minor).toBe(9_091n);
  });

  it("cada tasa se ajusta de forma independiente: la diferencia de una tasa no toca las líneas de otra ni las exentas", () => {
    const lines = [
      { gross: Money.pyg(33_333n), rate: "iva_10" as const }, // 0
      { gross: Money.pyg(7_000n), rate: "iva_5" as const }, //   1
      { gross: Money.pyg(33_333n), rate: "iva_10" as const }, // 2
      { gross: Money.pyg(7_000n), rate: "iva_5" as const }, //   3 — última de iva_5, no la última línea del documento
      { gross: Money.pyg(33_333n), rate: "iva_10" as const }, // 4 — última de iva_10
      { gross: Money.pyg(50_000n), rate: "exenta" as const }, // 5
    ];

    const result = breakdownDocument(lines);

    expect(result.lines.map((l) => l.vat.minor)).toEqual([
      3_030n, // iva_10
      333n, // iva_5
      3_030n, // iva_10
      334n, // iva_5 — se lleva la diferencia de SU tasa, no la de iva_10
      3_031n, // iva_10 — se lleva la diferencia de SU tasa
      0n, // exenta — sin IVA que ajustar
    ]);
    expect(result.lines.map((l) => l.base.minor)).toEqual([
      30_303n,
      6_667n,
      30_303n,
      6_666n,
      30_302n,
      50_000n,
    ]);
    expect(result.totalGross.minor).toBe(163_999n);
    expect(result.totalVat.minor).toBe(9_758n);
    expect(result.totalBase.minor).toBe(154_241n);
    // RN-IVA-04 a nivel de documento: base + iva = bruto, exacto.
    expect(result.totalBase.minor + result.totalVat.minor).toBe(result.totalGross.minor);
  });

  it("un documento enteramente exento no tiene IVA que imputar", () => {
    const lines = [
      { gross: Money.pyg(20_000n), rate: "exenta" as const },
      { gross: Money.pyg(30_000n), rate: "exenta" as const },
    ];

    const result = breakdownDocument(lines);

    expect(result.lines.map((l) => l.vat.minor)).toEqual([0n, 0n]);
    expect(result.totalVat.minor).toBe(0n);
    expect(result.totalBase.minor).toBe(50_000n);
  });
});
