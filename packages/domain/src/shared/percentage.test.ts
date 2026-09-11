import { describe, expect, it } from "vitest";
import { InvalidPercentageError } from "./errors.js";
import { Percentage } from "./percentage.js";
import { Quantity } from "./quantity.js";

describe("Percentage.of — docs/domain-contracts.md §3.3", () => {
  it("acepta valores dentro de [0, 1], incluyendo los bordes", () => {
    expect(() => Percentage.of(0)).not.toThrow();
    expect(() => Percentage.of(1)).not.toThrow();
    expect(() => Percentage.of(0.02)).not.toThrow();
  });

  it("rechaza un valor negativo", () => {
    expect(() => Percentage.of(-0.01)).toThrow(InvalidPercentageError);
  });

  it("rechaza un valor mayor a 1", () => {
    expect(() => Percentage.of(1.01)).toThrow(InvalidPercentageError);
  });

  it("rechaza un valor no finito", () => {
    expect(() => Percentage.of(Number.NaN)).toThrow(InvalidPercentageError);
  });
});

describe("Percentage.applyTo", () => {
  it("multiplica la Quantity recibida por el valor del porcentaje", () => {
    const applied = Percentage.of(0.02).applyTo(Quantity.ml(10));

    expect(applied.value).toBeCloseTo(0.2);
    expect(applied.uom).toBe("ml");
  });
});
