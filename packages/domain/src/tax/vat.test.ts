import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CurrencyMismatchError, InvalidVatDocumentError } from "../shared/errors.js";
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

describe("espejo SQL — RN-DIN-02 (app.round_pyg vs roundPyg, ver el comentario en vat.ts)", () => {
  // app.round_pyg() (Postgres, round(numeric, 0)) desempata "lejos de
  // cero"; roundPyg() (TS) documenta "hacia +infinito" (RN-DIN-02:
  // roundPyg(-0.5) = 0, no -1n). Esa diferencia nunca se activa DENTRO de
  // vatFromGross: 11 y 21 son impares, así que gross/11 y gross/21 jamás
  // dan una fracción exacta de .5 — haría falta un resto igual a
  // divisor/2, que no es entero con un divisor impar. No hay empate que
  // desempatar, así que da lo mismo qué regla de desempate use cada lado.
  //
  // Estos son los guaraníes negativos MÁS CERCANOS posibles a esa fracción
  // .5 para cada tasa (a menos de 0,05 de un empate real) — el peor caso
  // para esta duda, y ambos lados coinciden en el entero más cercano
  // porque, de nuevo, no hay empate.
  it.each([
    [-50n, "iva_10" as const, -5n], // -50/11 = -4,545454... (a 0,0454 del empate más próximo)
    [-61n, "iva_10" as const, -6n], // -61/11 = -5,545454...
    [-10n, "iva_5" as const, 0n], //   -10/21 = -0,476190... (a 0,0238 del empate más próximo)
    [-11n, "iva_5" as const, -1n], //  -11/21 = -0,523809...
  ])(
    "gross %s a tasa %s da %s de IVA, sin importar la regla de desempate",
    (minor, rate, expected) => {
      expect(vatFromGross(Money.pyg(minor), rate).minor).toBe(expected);
    },
  );
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
    expect(result.lines.map((l) => l.roundingAdjustment.minor)).toEqual([0n, 0n, 0n]);
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
    // RN-IVA-03: el ajuste "queda registrada" aparte, no solo sumado a vat.
    expect(result.lines.map((l) => l.roundingAdjustment.minor)).toEqual([0n, 0n, 1n]);
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
    // RN-IVA-03: cada tasa registra SU propio ajuste — índice 4 (última de
    // iva_10) e índice 3 (última de iva_5), no el índice 5 (última línea
    // del documento, pero exenta y sin ajuste posible).
    expect(result.lines.map((l) => l.roundingAdjustment.minor)).toEqual([0n, 0n, 0n, 1n, 1n, 0n]);
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
    expect(result.lines.map((l) => l.roundingAdjustment.minor)).toEqual([0n, 0n]);
  });
});

describe("RN-IVA-03 · el ajuste queda registrado aparte, no solo sumado dentro de vat", () => {
  it("roundingAdjustment reconstruye vat a partir del IVA de línea sin ajustar (RN-IVA-01)", () => {
    const lines = [
      { gross: Money.pyg(33_333n), rate: "iva_10" as const },
      { gross: Money.pyg(33_333n), rate: "iva_10" as const },
      { gross: Money.pyg(33_333n), rate: "iva_10" as const },
    ];

    const result = breakdownDocument(lines);

    for (const line of result.lines) {
      expect(vatFromGross(line.gross, line.rate).plus(line.roundingAdjustment).minor).toBe(
        line.vat.minor,
      );
    }
  });
});

describe("RN-IVA-03/04 · una nota de crédito (líneas de importe negativo) a nivel de documento", () => {
  it("mismo caso de tres líneas de Gs. 33.333 al 10%, en negativo — imputa igual y sostiene base + iva = bruto", () => {
    const lines = [
      { gross: Money.pyg(-33_333n), rate: "iva_10" as const },
      { gross: Money.pyg(-33_333n), rate: "iva_10" as const },
      { gross: Money.pyg(-33_333n), rate: "iva_10" as const },
    ];

    const result = breakdownDocument(lines);

    expect(result.lines.map((l) => l.vat.minor)).toEqual([-3_030n, -3_030n, -3_031n]);
    expect(result.totalGross.minor).toBe(-99_999n);
    expect(result.totalVat.minor).toBe(-9_091n);
    expect(result.totalBase.minor + result.totalVat.minor).toBe(result.totalGross.minor);
    expect(result.lines.map((l) => l.roundingAdjustment.minor)).toEqual([0n, 0n, -1n]);
  });
});

describe("breakdownDocument — entrada inválida", () => {
  it("lanza InvalidVatDocumentError con un arreglo de líneas vacío, en vez de un TypeError crudo de JS", () => {
    expect(() => breakdownDocument([])).toThrow(InvalidVatDocumentError);
  });

  it("lanza CurrencyMismatchError si las líneas de un mismo documento no comparten moneda (RN-DIN-03, vía Money.plus)", () => {
    const lines = [
      { gross: Money.pyg(100_000n), rate: "iva_10" as const },
      { gross: Money.of(100n, "USD"), rate: "iva_10" as const },
    ];

    expect(() => breakdownDocument(lines)).toThrow(CurrencyMismatchError);
  });
});

// Hallazgo de la revisión de WP-C17: la diferencia de RN-IVA-03 iba SIEMPRE a la
// última línea de la tasa, aunque no pudiera absorberla. Con una línea de
// importe cero (un regalo) quedaba con IVA ≠ 0, y el CHECK `vat_pyg >= 0` de
// `sale_order_lines` rechazaba un pedido legítimo.
describe("RN-IVA-03 · la diferencia va a la última línea de la tasa que puede absorberla", () => {
  it("una última línea de importe cero no recibe la diferencia: el IVA de un regalo es cero y la diferencia pasa a la línea anterior", () => {
    const lines = [
      { gross: Money.pyg(99_995n), rate: "iva_10" as const },
      { gross: Money.pyg(99_995n), rate: "iva_10" as const },
      { gross: Money.pyg(0n), rate: "iva_10" as const },
    ];

    const result = breakdownDocument(lines);

    // 99.995 / 11 = 9.090,45 → 9.090 por línea (18.180); el documento, 199.990 / 11 = 18.180,9 → 18.181.
    expect(result.lines.map((l) => l.vat.minor)).toEqual([9_090n, 9_091n, 0n]);
    expect(result.lines.map((l) => l.roundingAdjustment.minor)).toEqual([0n, 1n, 0n]);
    expect(result.totalVat.minor).toBe(18_181n);
  });

  it("una diferencia negativa tampoco deja una línea de importe cero con IVA negativo", () => {
    const lines = [
      { gross: Money.pyg(100_008n), rate: "iva_10" as const },
      { gross: Money.pyg(100_008n), rate: "iva_10" as const },
      { gross: Money.pyg(100_008n), rate: "iva_10" as const },
      { gross: Money.pyg(0n), rate: "iva_10" as const },
    ];

    const result = breakdownDocument(lines);

    // 100.008 / 11 = 9.091,6 → 9.092 por línea (27.276); el documento, 300.024 / 11 = 27.274,9 → 27.275.
    expect(result.lines.map((l) => l.vat.minor)).toEqual([9_092n, 9_092n, 9_091n, 0n]);
    expect(result.lines.map((l) => l.roundingAdjustment.minor)).toEqual([0n, 0n, -1n, 0n]);
    expect(result.totalVat.minor).toBe(27_275n);
  });

  it("una línea final chica que no alcanza para la diferencia deja el resto a la anterior, y el IVA nunca supera el importe", () => {
    // Cuatro líneas de Gs. 100.008 y una de Gs. 1 al 10%: 4 × 9.092 = 36.368 y la de Gs. 1 da 0.
    // El documento, 400.033 / 11 = 36.366,6 → 36.367: sobran −1, y la de Gs. 1 (IVA 0) no puede restar.
    const lines = [
      { gross: Money.pyg(100_008n), rate: "iva_10" as const },
      { gross: Money.pyg(100_008n), rate: "iva_10" as const },
      { gross: Money.pyg(100_008n), rate: "iva_10" as const },
      { gross: Money.pyg(100_008n), rate: "iva_10" as const },
      { gross: Money.pyg(1n), rate: "iva_10" as const },
    ];

    const result = breakdownDocument(lines);

    expect(result.lines.map((l) => l.vat.minor)).toEqual([9_092n, 9_092n, 9_092n, 9_091n, 0n]);
    expect(result.totalVat.minor).toBe(36_367n);
  });

  it("en una nota de crédito (importes negativos) la línea de importe cero tampoco recibe la diferencia, sea positiva o negativa", () => {
    // −99.995 / 11 = −9.090,45 → −9.090 por línea (−18.180); el documento, −199.990 / 11, es −18.181: sobra −1.
    const negativeDifference = [
      { gross: Money.pyg(-99_995n), rate: "iva_10" as const },
      { gross: Money.pyg(-99_995n), rate: "iva_10" as const },
      { gross: Money.pyg(0n), rate: "iva_10" as const },
    ];
    // −100.008 / 11 = −9.091,6 → −9.092 por línea (−27.276); el documento, −300.024 / 11, es −27.275: sobra +1.
    const positiveDifference = [
      { gross: Money.pyg(-100_008n), rate: "iva_10" as const },
      { gross: Money.pyg(-100_008n), rate: "iva_10" as const },
      { gross: Money.pyg(-100_008n), rate: "iva_10" as const },
      { gross: Money.pyg(0n), rate: "iva_10" as const },
    ];

    expect(breakdownDocument(negativeDifference).lines.map((l) => l.vat.minor)).toEqual([
      -9_090n,
      -9_091n,
      0n,
    ]);
    expect(breakdownDocument(positiveDifference).lines.map((l) => l.vat.minor)).toEqual([
      -9_092n,
      -9_092n,
      -9_091n,
      0n,
    ]);
  });

  it("una diferencia mayor que lo que una línea puede absorber se reparte hacia atrás: la última se lleva lo que le cabe y el resto, la anterior", () => {
    // Dos líneas de Gs. 3 y una de Gs. 1 al 10%: el IVA de cada una es 0 y el del documento, 7 / 11 = 0,63 → 1.
    // Sobra +1: la última (Gs. 1) absorbe hasta su importe, o sea 1.
    const small = [
      { gross: Money.pyg(3n), rate: "iva_10" as const },
      { gross: Money.pyg(3n), rate: "iva_10" as const },
      { gross: Money.pyg(1n), rate: "iva_10" as const },
    ];
    // Cuatro líneas de Gs. 6 y una de Gs. 0: 6 / 11 = 0,55 → 1 por línea (4); el documento, 24 / 11 = 2,18 → 2: sobran −2.
    // La de Gs. 0 no puede restar; la anterior resta 1 (llega a 0) y la anterior a esa, 1.
    const shrinking = [
      { gross: Money.pyg(6n), rate: "iva_10" as const },
      { gross: Money.pyg(6n), rate: "iva_10" as const },
      { gross: Money.pyg(6n), rate: "iva_10" as const },
      { gross: Money.pyg(6n), rate: "iva_10" as const },
      { gross: Money.pyg(0n), rate: "iva_10" as const },
    ];

    expect(breakdownDocument(small).lines.map((l) => l.vat.minor)).toEqual([0n, 0n, 1n]);
    expect(breakdownDocument(shrinking).lines.map((l) => l.vat.minor)).toEqual([
      1n,
      1n,
      0n,
      0n,
      0n,
    ]);
  });
});
