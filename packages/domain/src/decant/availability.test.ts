import { describe, expect, it } from "vitest";
import { InvalidDecantInputError } from "../shared/errors.js";
import { Percentage } from "../shared/percentage.js";
import { Quantity } from "../shared/quantity.js";
import { decantAvailability, type DecantAvailabilityBomComponent } from "./availability.js";

/** Constructor con valores por defecto razonables; sobrescribir solo lo relevante de cada test. */
function bomComponent(
  overrides: Partial<DecantAvailabilityBomComponent> = {},
): DecantAvailabilityBomComponent {
  return {
    available: Quantity.units(100),
    perUnit: Quantity.units(1),
    ...overrides,
  };
}

describe("RN-FRA-06 · disponibilidad de una variante bajo pedido", () => {
  it("granel 114,65 ml, decant de 10 ml al 2%, 99 viales/atomizadores y 199 etiquetas da 11", () => {
    const result = decantAvailability({
      bulkAvailable: Quantity.ml(114.65),
      mlPerUnit: 10,
      wasteFactor: Percentage.of(0.02),
      bom: [
        bomComponent({ available: Quantity.units(99) }),
        bomComponent({ available: Quantity.units(99) }),
        bomComponent({ available: Quantity.units(199) }),
      ],
    });

    expect(result).toBe(11);
  });

  it("sin insumos que limiten (BOM vacío), la disponibilidad es solo la del líquido", () => {
    const result = decantAvailability({
      bulkAvailable: Quantity.ml(114.65),
      mlPerUnit: 10,
      wasteFactor: Percentage.of(0.02),
      bom: [],
    });

    expect(result).toBe(11);
  });

  it("cuando un insumo escasea más que el líquido, ese insumo es el que manda", () => {
    const result = decantAvailability({
      bulkAvailable: Quantity.ml(1_000),
      mlPerUnit: 10,
      wasteFactor: Percentage.of(0.02),
      bom: [bomComponent({ available: Quantity.units(3) })],
    });

    expect(result).toBe(3);
  });

  it("un decant que consume más de una unidad por componente divide la disponibilidad del insumo", () => {
    const result = decantAvailability({
      bulkAvailable: Quantity.ml(1_000),
      mlPerUnit: 10,
      wasteFactor: Percentage.of(0.02),
      bom: [bomComponent({ available: Quantity.units(10), perUnit: Quantity.units(4) })],
    });

    expect(result).toBe(2);
  });
});

describe("RN-FRA-06 · argumentos fuera de rango son un bug del llamador", () => {
  it("mlPerUnit no positivo lanza InvalidDecantInputError", () => {
    expect(() =>
      decantAvailability({
        bulkAvailable: Quantity.ml(100),
        mlPerUnit: 0,
        wasteFactor: Percentage.of(0.02),
        bom: [],
      }),
    ).toThrow(InvalidDecantInputError);
  });

  it("mlPerUnit no finito lanza InvalidDecantInputError", () => {
    expect(() =>
      decantAvailability({
        bulkAvailable: Quantity.ml(100),
        mlPerUnit: Number.POSITIVE_INFINITY,
        wasteFactor: Percentage.of(0.02),
        bom: [],
      }),
    ).toThrow(InvalidDecantInputError);
  });

  it("un componente del BOM con perUnit no positivo lanza InvalidDecantInputError", () => {
    expect(() =>
      decantAvailability({
        bulkAvailable: Quantity.ml(100),
        mlPerUnit: 10,
        wasteFactor: Percentage.of(0.02),
        bom: [bomComponent({ perUnit: Quantity.units(0) })],
      }),
    ).toThrow(InvalidDecantInputError);
  });
});
