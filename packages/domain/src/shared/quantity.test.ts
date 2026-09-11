import { describe, expect, it } from "vitest";
import { InvalidQuantityError, UomMismatchError } from "./errors.js";
import { Quantity } from "./quantity.js";

describe("Quantity.units — docs/domain-contracts.md §3.2", () => {
  it("acepta un entero", () => {
    const q = Quantity.units(3);

    expect(q.value).toBe(3);
    expect(q.uom).toBe("unit");
  });

  it("acepta cero y enteros negativos (ajustes)", () => {
    expect(Quantity.units(0).value).toBe(0);
    expect(Quantity.units(-2).value).toBe(-2);
  });

  it("rechaza un valor con decimales — media unidad de reloj no existe", () => {
    expect(() => Quantity.units(1.5)).toThrow(InvalidQuantityError);
  });
});

describe("Quantity.ml — hasta 3 decimales (docs/domain-contracts.md §3.2)", () => {
  it("acepta un entero y hasta 3 decimales", () => {
    expect(Quantity.ml(114.65).value).toBeCloseTo(114.65);
    expect(Quantity.ml(10.125).value).toBeCloseTo(10.125);
    expect(Quantity.ml(10).value).toBe(10);
  });

  it("rechaza más de 3 decimales", () => {
    expect(() => Quantity.ml(10.1234)).toThrow(InvalidQuantityError);
  });

  it("rechaza un valor no finito", () => {
    expect(() => Quantity.ml(Number.NaN)).toThrow(InvalidQuantityError);
    expect(() => Quantity.ml(Number.POSITIVE_INFINITY)).toThrow(InvalidQuantityError);
  });
});

describe("Quantity — aritmética entre la misma unidad (docs/domain-contracts.md §3.2)", () => {
  it("plus suma dos cantidades de la misma unidad", () => {
    const total = Quantity.ml(10).plus(Quantity.ml(0.2));

    expect(total.value).toBeCloseTo(10.2);
    expect(total.uom).toBe("ml");
  });

  it("minus resta dos cantidades de la misma unidad", () => {
    expect(Quantity.ml(10).minus(Quantity.ml(0.35)).value).toBeCloseTo(9.65);
  });

  it("times multiplica por un factor", () => {
    expect(Quantity.ml(10).times(0.02).value).toBeCloseTo(0.2);
  });

  it("times rechaza un factor no finito", () => {
    expect(() => Quantity.ml(10).times(Number.NaN)).toThrow(InvalidQuantityError);
  });

  it("isNegative refleja el signo del valor", () => {
    expect(Quantity.ml(-1).isNegative()).toBe(true);
    expect(Quantity.ml(1).isNegative()).toBe(false);
  });
});

describe("Quantity — unidades incompatibles (UomMismatchError) — docs/domain-contracts.md §3.2", () => {
  it("plus lanza si las unidades no coinciden", () => {
    expect(() => Quantity.units(1).plus(Quantity.ml(1))).toThrow(UomMismatchError);
  });

  it("minus lanza si las unidades no coinciden", () => {
    expect(() => Quantity.units(1).minus(Quantity.ml(1))).toThrow(UomMismatchError);
  });

  it("compare lanza si las unidades no coinciden", () => {
    expect(() => Quantity.units(1).compare(Quantity.ml(1))).toThrow(UomMismatchError);
  });
});

describe("Quantity.compare — docs/domain-contracts.md §3.2", () => {
  it("devuelve 0 cuando son iguales", () => {
    expect(Quantity.ml(5).compare(Quantity.ml(5))).toBe(0);
  });

  it("devuelve -1 cuando la primera es menor", () => {
    expect(Quantity.ml(5).compare(Quantity.ml(10))).toBe(-1);
  });

  it("devuelve 1 cuando la primera es mayor", () => {
    expect(Quantity.ml(10).compare(Quantity.ml(5))).toBe(1);
  });
});
