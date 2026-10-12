import { describe, expect, it } from "vitest";
import { InvalidSourcingInputError } from "../shared/errors.js";
import { Money } from "../shared/money.js";
import { Percentage } from "../shared/percentage.js";
import { Quantity } from "../shared/quantity.js";
import {
  compareScenarioLines,
  projectScenarioLines,
  type ProjectScenarioLinesInput,
  type ScenarioLineInput,
  type ScenarioLineProjection,
} from "./scenario.js";

/** RN-SRC-01/02 · reloj importado, fx 7.300, arancel 10% — docs/domain-rules.md. */
function buildLine(overrides: Partial<ScenarioLineInput> = {}): ScenarioLineInput {
  return {
    id: "line-1",
    variantId: "variant-1",
    qty: Quantity.units(1),
    unitPrice: Money.of(30_000n, "USD"), // 300,00
    fxRateToPyg: 7300,
    projectedPricePyg: Money.pyg(3_500_000n),
    vatRate: "iva_10",
    ...overrides,
  };
}

function buildInput(overrides: Partial<ProjectScenarioLinesInput> = {}): ProjectScenarioLinesInput {
  return {
    lines: [buildLine()],
    assumptions: {
      freightTotal: Money.of(2_000n, "USD"), // 20,00
      freightMethod: "by_value",
      tariffRate: Percentage.of(0.1),
    },
    marginThresholdPct: Percentage.of(0.25),
    ...overrides,
  };
}

function expectOkProjections(
  result: ReturnType<typeof projectScenarioLines>,
): readonly ScenarioLineProjection[] {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected ok");
  return result.value;
}

describe("RN-SRC-01 · costo puesto proyectado de una línea", () => {
  it("reloj importado: precio USD 300 + flete USD 20 + arancel 10% (USD 30), fx 7.300, da Gs. 2.555.000/unidad", () => {
    const projections = expectOkProjections(projectScenarioLines(buildInput()));

    expect(projections).toHaveLength(1);
    expect(projections[0]!.unitLandedPyg.minor).toBe(2_555_000n);
    expect(projections[0]!.unitLandedPyg.currency).toBe("PYG");
  });

  it("el costo puesto unitario cambia con qty porque el flete es un total FIJO que se diluye entre más unidades (el arancel ad valorem, en cambio, escala con el valor y no distorsiona)", () => {
    // qty 2 en vez de 1: valor de línea USD 200 (100 c/u), arancel 10% = USD
    // 20, flete total USD 20 entero (única línea) → componentes 240 USD ×
    // 7.300 = Gs. 1.752.000 / 2 = Gs. 876.000 por unidad.
    const projections = expectOkProjections(
      projectScenarioLines(
        buildInput({
          lines: [buildLine({ qty: Quantity.units(2), unitPrice: Money.of(10_000n, "USD") })],
        }),
      ),
    );

    expect(projections[0]!.unitLandedPyg.minor).toBe(876_000n);
  });

  it("reparte el flete entre TODAS las líneas del escenario (RN-COS-02), no una por una", () => {
    const projections = expectOkProjections(
      projectScenarioLines(
        buildInput({
          lines: [
            buildLine({
              id: "line-cheap",
              unitPrice: Money.of(10_000n, "USD"), // 100,00 → valor 100,00
              projectedPricePyg: Money.pyg(1_095_000n),
              vatRate: "exenta",
            }),
            buildLine({
              id: "line-dear",
              unitPrice: Money.of(20_000n, "USD"), // 200,00 → valor 200,00
              projectedPricePyg: Money.pyg(2_190_000n),
              vatRate: "exenta",
            }),
          ],
          assumptions: {
            freightTotal: Money.of(3_000n, "USD"), // 30,00, por_value: 10,00 / 20,00
            freightMethod: "by_value",
            tariffRate: Percentage.of(0.1),
          },
        }),
      ),
    );

    // line-cheap: (100 + 10 + 10) × 7.300 = 120 × 7.300 = 876.000
    // line-dear:  (200 + 20 + 20) × 7.300 = 240 × 7.300 = 1.752.000
    expect(projections.find((p) => p.lineId === "line-cheap")!.unitLandedPyg.minor).toBe(876_000n);
    expect(projections.find((p) => p.lineId === "line-dear")!.unitLandedPyg.minor).toBe(1_752_000n);
  });

  it("method 'manual': el flete de la línea es el que el operador fijó, no uno calculado", () => {
    const projections = expectOkProjections(
      projectScenarioLines(
        buildInput({
          lines: [buildLine({ manualFreightAmount: Money.of(2_000n, "USD") })],
          assumptions: {
            freightTotal: Money.of(2_000n, "USD"),
            freightMethod: "manual",
            tariffRate: Percentage.of(0.1),
          },
        }),
      ),
    );

    expect(projections[0]!.unitLandedPyg.minor).toBe(2_555_000n);
  });

  it("propaga el FreightError de allocateFreight (RN-COS-02) como FREIGHT_ALLOCATION_FAILED, sin líneas que prorratear", () => {
    const result = projectScenarioLines(buildInput({ lines: [] }));

    expect(result).toEqual({
      ok: false,
      error: { code: "FREIGHT_ALLOCATION_FAILED", reason: { code: "EMPTY_LINES" } },
    });
  });
});

describe("RN-SRC-02 · margen proyectado, neto de IVA", () => {
  it("costo puesto Gs. 2.555.000, precio Gs. 3.500.000 con IVA 10%: margen ≈ 19,700%", () => {
    const projections = expectOkProjections(projectScenarioLines(buildInput()));

    expect(projections[0]!.marginPct).toBe(19.7);
  });

  it("una línea exenta de IVA no descuenta nada del precio bruto antes de comparar contra el costo", () => {
    const projections = expectOkProjections(
      projectScenarioLines(
        buildInput({
          lines: [buildLine({ projectedPricePyg: Money.pyg(3_193_750n), vatRate: "exenta" })],
        }),
      ),
    );

    // (3.193.750 − 2.555.000) / 3.193.750 × 100 = 20,000%
    expect(projections[0]!.marginPct).toBe(20);
  });

  it.each([
    [0n, "cero"],
    [-100n, "negativo"],
  ])("lanza InvalidSourcingInputError con un projectedPricePyg %s (%s)", (minor) => {
    expect(() =>
      projectScenarioLines(
        buildInput({ lines: [buildLine({ projectedPricePyg: Money.pyg(minor) })] }),
      ),
    ).toThrow(InvalidSourcingInputError);
  });

  it("un costo puesto mayor al precio neto da un margen negativo — una línea en pérdida no es un bug", () => {
    const projections = expectOkProjections(
      projectScenarioLines({
        lines: [
          buildLine({
            unitPrice: Money.of(10_700n, "USD"), // 107,00 → landed 107 Gs. (fx 1, sin flete ni arancel)
            fxRateToPyg: 1,
            projectedPricePyg: Money.pyg(100n),
            vatRate: "exenta",
          }),
        ],
        assumptions: {
          freightTotal: Money.of(0n, "USD"),
          freightMethod: "by_value",
          tariffRate: Percentage.of(0),
        },
        marginThresholdPct: Percentage.of(0.25),
      }),
    );

    // (100 − 107) / 100 × 100 = −7%
    expect(projections[0]!.marginPct).toBe(-7);
    expect(projections[0]!.belowThreshold).toBe(true);
  });

  it("redondea el margen a milésimas, media unidad hacia +infinito, igual que round_pyg (borde 7,0005%)", () => {
    const projections = expectOkProjections(
      projectScenarioLines({
        lines: [
          buildLine({
            unitPrice: Money.of(18_599_900n, "USD"), // landed 185.999 Gs. (fx 1, sin flete ni arancel)
            fxRateToPyg: 1,
            projectedPricePyg: Money.pyg(200_000n),
            vatRate: "exenta",
          }),
        ],
        assumptions: {
          freightTotal: Money.of(0n, "USD"),
          freightMethod: "by_value",
          tariffRate: Percentage.of(0),
        },
        marginThresholdPct: Percentage.of(0.25),
      }),
    );

    // (200.000 − 185.999) / 200.000 × 100 = 7,0005% exacto → 7,001%
    expect(projections[0]!.marginPct).toBe(7.001);
  });
});

describe("RN-SRC-03 · alerta de margen bajo umbral configurable", () => {
  it("umbral 25%: un margen de 19,700% dispara la alerta", () => {
    const projections = expectOkProjections(
      projectScenarioLines(buildInput({ marginThresholdPct: Percentage.of(0.25) })),
    );

    expect(projections[0]!.belowThreshold).toBe(true);
  });

  it("umbral 15%: un margen de 19,700% no dispara la alerta", () => {
    const projections = expectOkProjections(
      projectScenarioLines(buildInput({ marginThresholdPct: Percentage.of(0.15) })),
    );

    expect(projections[0]!.belowThreshold).toBe(false);
  });

  it("el umbral es un parámetro, no una constante: igualar el margen exacto no cuenta como 'por debajo'", () => {
    const projections = expectOkProjections(
      projectScenarioLines(buildInput({ marginThresholdPct: Percentage.of(0.197) })),
    );

    expect(projections[0]!.belowThreshold).toBe(false);
  });

  it("umbral y margen iguales con un valor que NO es exacto en punto flotante (revisión cruzada, hallazgo 1) no cuentan como 'por debajo'", () => {
    // 0,07 × 100 = 7.000000000000001 en punto flotante — sin redondear el
    // umbral a la misma grilla de milésimas que marginPct, un margen que
    // iguala exactamente el umbral (7,000%) daba belowThreshold true. Este
    // caso está construido para dar margen EXACTAMENTE 7 (no una
    // aproximación que redondee a 7,000): costo puesto 93, precio neto 100
    // (exenta, sin IVA que redondear) → (100 − 93) / 100 × 100 = 7.
    const projections = expectOkProjections(
      projectScenarioLines({
        lines: [
          buildLine({
            unitPrice: Money.of(9_300n, "USD"),
            fxRateToPyg: 1,
            projectedPricePyg: Money.pyg(100n),
            vatRate: "exenta",
          }),
        ],
        assumptions: {
          freightTotal: Money.of(0n, "USD"),
          freightMethod: "by_value",
          tariffRate: Percentage.of(0),
        },
        marginThresholdPct: Percentage.of(0.07),
      }),
    );

    expect(projections[0]!.marginPct).toBe(7);
    expect(projections[0]!.belowThreshold).toBe(false);
  });
});

// RN-SRC-04, decisión de José (segunda revisión cruzada de WP-C16): "mejor
// opción" es la de mayor GANANCIA ABSOLUTA por unidad (profitPyg), no la de
// mayor margen porcentual — marginPct queda como dato auxiliar en la
// proyección, no decide nada acá.
describe("RN-SRC-04 · compareScenarioLines agrupa por variante y señala la de mayor ganancia absoluta", () => {
  it("proveedor A (ganancia Gs. 626.818) vs. proveedor B (ganancia Gs. 1.429.818) de la misma variante: B es la mejor", () => {
    const optionA = expectOkProjections(
      projectScenarioLines(buildInput({ lines: [buildLine({ id: "line-A", variantLabel: "A" })] })),
    );
    const optionB = expectOkProjections(
      projectScenarioLines(
        buildInput({
          lines: [
            buildLine({
              id: "line-B",
              variantLabel: "B",
              unitPrice: Money.of(20_000n, "USD"), // 200,00 — proveedor más barato
            }),
          ],
        }),
      ),
    );

    const groups = compareScenarioLines([...optionA, ...optionB]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.variantId).toBe("variant-1");
    expect(groups[0]!.bestLineId).toBe("line-B");
    expect(optionA[0]!.profitPyg.minor).toBe(626_818n);
    expect(optionB[0]!.profitPyg.minor).toBe(1_429_818n);
  });

  it("margen % y ganancia absoluta pueden apuntar a opciones distintas: gana la de mayor ganancia, aunque tenga menor margen", () => {
    // Línea de margen alto pero ganancia chica: costo 95, precio neto 100 → ganancia 5, margen 5%.
    const highMarginLowProfit = buildLine({
      id: "line-high-margin",
      variantId: "variant-conflict",
      unitPrice: Money.of(9_500n, "USD"),
      fxRateToPyg: 1,
      projectedPricePyg: Money.pyg(100n),
      vatRate: "exenta",
    });
    // Línea de margen bajo pero ganancia grande: costo 990.000, precio neto 1.000.000 → ganancia 10.000, margen 1%.
    const lowMarginHighProfit = buildLine({
      id: "line-low-margin",
      variantId: "variant-conflict",
      unitPrice: Money.of(99_000_000n, "USD"),
      fxRateToPyg: 1,
      projectedPricePyg: Money.pyg(1_000_000n),
      vatRate: "exenta",
    });
    const noFreightOrTariff = {
      freightTotal: Money.of(0n, "USD"),
      freightMethod: "by_value" as const,
      tariffRate: Percentage.of(0),
    };

    const highMargin = expectOkProjections(
      projectScenarioLines({
        lines: [highMarginLowProfit],
        assumptions: noFreightOrTariff,
        marginThresholdPct: Percentage.of(0.25),
      }),
    );
    const lowMargin = expectOkProjections(
      projectScenarioLines({
        lines: [lowMarginHighProfit],
        assumptions: noFreightOrTariff,
        marginThresholdPct: Percentage.of(0.25),
      }),
    );

    expect(highMargin[0]!.marginPct).toBe(5);
    expect(highMargin[0]!.profitPyg.minor).toBe(5n);
    expect(lowMargin[0]!.marginPct).toBe(1);
    expect(lowMargin[0]!.profitPyg.minor).toBe(10_000n);

    const groups = compareScenarioLines([...highMargin, ...lowMargin]);

    expect(groups[0]!.bestLineId).toBe("line-low-margin");
  });

  it("empate exacto de ganancia: gana la primera línea vista, no la segunda (desempate determinístico)", () => {
    const optionA = expectOkProjections(
      projectScenarioLines(buildInput({ lines: [buildLine({ id: "line-A", variantLabel: "A" })] })),
    );
    const optionB = expectOkProjections(
      projectScenarioLines(buildInput({ lines: [buildLine({ id: "line-B", variantLabel: "B" })] })),
    );

    expect(optionA[0]!.profitPyg.minor).toBe(optionB[0]!.profitPyg.minor);
    expect(compareScenarioLines([...optionA, ...optionB])[0]!.bestLineId).toBe("line-A");
    expect(compareScenarioLines([...optionB, ...optionA])[0]!.bestLineId).toBe("line-B");
  });

  it("si la primera línea ya es la mejor, una segunda con menos ganancia no la desplaza", () => {
    const optionA = expectOkProjections(
      projectScenarioLines(buildInput({ lines: [buildLine({ id: "line-A", variantLabel: "A" })] })),
    );
    const optionB = expectOkProjections(
      projectScenarioLines(
        buildInput({
          lines: [
            buildLine({
              id: "line-B",
              variantLabel: "B",
              unitPrice: Money.of(20_000n, "USD"),
            }),
          ],
        }),
      ),
    );

    // Orden invertido respecto al primer test: B (ganancia mayor) entra primero.
    const groups = compareScenarioLines([...optionB, ...optionA]);

    expect(groups[0]!.bestLineId).toBe("line-B");
  });

  it("variantes distintas quedan en grupos separados, cada uno trivialmente ganado por su única línea", () => {
    const projections = expectOkProjections(
      projectScenarioLines(
        buildInput({
          lines: [
            buildLine({ id: "line-x", variantId: "variant-x" }),
            buildLine({ id: "line-y", variantId: "variant-y" }),
          ],
          assumptions: {
            freightTotal: Money.of(4_000n, "USD"),
            freightMethod: "by_value",
            tariffRate: Percentage.of(0.1),
          },
        }),
      ),
    );

    const groups = compareScenarioLines(projections);

    expect(groups.map((g) => g.variantId)).toEqual(["variant-x", "variant-y"]);
    expect(groups.map((g) => g.bestLineId)).toEqual(["line-x", "line-y"]);
  });
});
