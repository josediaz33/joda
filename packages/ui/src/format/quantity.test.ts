import { describe, expect, it } from "vitest";
import { formatQuantity } from "./quantity";

describe("frontend-spec.md §4 · presentación de cantidades", () => {
  it("muestra ml con coma y hasta tres decimales", () => {
    expect(formatQuantity(114.65, "ml")).toBe("114,65 ml");
    expect(formatQuantity(10.125, "ml")).toBe("10,125 ml");
    expect(formatQuantity(10, "ml")).toBe("10 ml");
  });

  it("muestra unidades enteras y su singular o plural", () => {
    expect(formatQuantity(1, "unit")).toBe("1 unidad");
    expect(formatQuantity(1200, "unit")).toBe("1.200 unidades");
  });

  it("rechaza cantidades que requerirían redondeo o no son finitas", () => {
    expect(() => formatQuantity(1.5, "unit")).toThrow(RangeError);
    expect(() => formatQuantity(1.1234, "ml")).toThrow(RangeError);
    expect(() => formatQuantity(Number.NaN, "ml")).toThrow(RangeError);
  });
});
