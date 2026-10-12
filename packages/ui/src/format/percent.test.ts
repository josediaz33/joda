import { describe, expect, it } from "vitest";
import { formatPercent } from "./percent";

describe("frontend-spec.md §4 · presentación de porcentajes", () => {
  it("muestra hasta tres decimales con coma", () => {
    expect(formatPercent(19.7)).toBe("19,7%");
    expect(formatPercent(44.937)).toBe("44,937%");
    expect(formatPercent(20)).toBe("20%");
  });

  it("un margen negativo (línea en pérdida, RN-SRC-02) se muestra con signo", () => {
    expect(formatPercent(-5.234)).toBe("-5,234%");
  });

  it("rechaza valores no finitos", () => {
    expect(() => formatPercent(Number.NaN)).toThrow(RangeError);
    expect(() => formatPercent(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
