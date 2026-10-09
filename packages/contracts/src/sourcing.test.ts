import { describe, expect, it } from "vitest";
import {
  convertSourcingScenarioInput,
  createSourcingScenarioInput,
  sourcingScenarioLineSchema,
} from "./sourcing.js";

const variantId = "77777777-7777-4777-a777-777777777781";
const line = {
  variantId,
  qty: "2",
  unitPriceMinor: "30000",
  currency: "USD",
  fxAssumed: "7300",
  vatRate: "iva_10",
  projectedPricePyg: "3500000",
};
const scenario = {
  name: "Reloj Layton — proveedor A vs. B",
  assumptions: {
    freightTotalMinor: "2000",
    freightCurrency: "USD",
    freightMethod: "by_value",
    tariffRate: 0.1,
  },
  lines: [line],
};

describe("docs/api-conventions.md §3 · contratos de sourcing", () => {
  it("rechaza atributos ajenos, importes numéricos y cantidades cero", () => {
    expect(createSourcingScenarioInput.safeParse({ ...scenario, margin: 10 }).success).toBe(false);
    expect(
      createSourcingScenarioInput.safeParse({
        ...scenario,
        lines: [{ ...line, unitPriceMinor: 30000 }],
      }).success,
    ).toBe(false);
    expect(
      createSourcingScenarioInput.safeParse({ ...scenario, lines: [{ ...line, qty: "0.000" }] })
        .success,
    ).toBe(false);
  });

  it("tariffRate es una fracción [0, 1] — RN-SRC-01, ad valorem, no un número cualquiera", () => {
    expect(
      createSourcingScenarioInput.safeParse({
        ...scenario,
        assumptions: { ...scenario.assumptions, tariffRate: 1.5 },
      }).success,
    ).toBe(false);
    expect(
      createSourcingScenarioInput.safeParse({
        ...scenario,
        assumptions: { ...scenario.assumptions, tariffRate: -0.01 },
      }).success,
    ).toBe(false);
    expect(
      createSourcingScenarioInput.safeParse({
        ...scenario,
        assumptions: { ...scenario.assumptions, tariffRate: 0 },
      }).success,
    ).toBe(true);
  });

  it("exige fxAssumed estrictamente positivo (RN-COS-01: un fx <= 0 no es un dato de negocio)", () => {
    expect(
      createSourcingScenarioInput.safeParse({ ...scenario, lines: [{ ...line, fxAssumed: "0" }] })
        .success,
    ).toBe(false);
  });

  it("acepta un escenario sin variantLabel ni supplierId — una sola alternativa, sin comparar", () => {
    expect(createSourcingScenarioInput.safeParse(scenario).success).toBe(true);
  });

  it("variantLabel admite un solo carácter ('A' | 'B'), no una etiqueta libre", () => {
    expect(
      createSourcingScenarioInput.safeParse({
        ...scenario,
        lines: [{ ...line, variantLabel: "AB" }],
      }).success,
    ).toBe(false);
    expect(
      createSourcingScenarioInput.safeParse({
        ...scenario,
        lines: [{ ...line, variantLabel: "A" }],
      }).success,
    ).toBe(true);
  });

  it("sourcingScenarioLineSchema acepta un projectedMarginPct negativo — una línea en pérdida no es un dato inválido (RN-SRC-02)", () => {
    const row = {
      id: "99999999-9999-4999-a999-999999999991",
      scenarioId: "99999999-9999-4999-a999-999999999992",
      supplierId: null,
      variantId,
      variantLabel: "A",
      qty: "1",
      unitPriceMinor: "30000",
      currency: "USD",
      fxAssumed: "7300",
      leadTimeDays: null,
      projectedLandedPyg: "2555000",
      projectedPricePyg: "3500000",
      projectedMarginPct: "-5.234",
    };

    expect(sourcingScenarioLineSchema.safeParse(row).success).toBe(true);
    expect(sourcingScenarioLineSchema.safeParse({ ...row, projectedMarginPct: null }).success).toBe(
      true,
    );
  });

  it("convertSourcingScenarioInput (RF-SRC-05, sin endpoint todavía) exige scenarioId, supplierId y code", () => {
    expect(
      convertSourcingScenarioInput.safeParse({
        scenarioId: "99999999-9999-4999-a999-999999999992",
        supplierId: "88888888-8888-4888-a888-888888888881",
        code: "PO-1",
      }).success,
    ).toBe(true);
    expect(
      convertSourcingScenarioInput.safeParse({
        scenarioId: "99999999-9999-4999-a999-999999999992",
        code: "PO-1",
      }).success,
    ).toBe(false);
  });
});
