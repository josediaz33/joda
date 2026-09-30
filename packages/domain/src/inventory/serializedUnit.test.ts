import { describe, expect, it } from "vitest";
import { InvalidSerializedUnitInputError } from "../shared/errors.js";
import { Quantity } from "../shared/quantity.js";
import {
  planSerializedUnitRegistration,
  type RegisterSerializedUnitInput,
} from "./serializedUnit.js";

/** Constructor con valores por defecto razonables; sobrescribir solo lo relevante de cada test. */
function registration(
  overrides: Partial<RegisterSerializedUnitInput> = {},
): RegisterSerializedUnitInput {
  return {
    variantIsSerialized: true,
    lotQtyInitial: Quantity.units(3),
    registeredCount: 0,
    ...overrides,
  };
}

describe("RN-SER-02 · solo una variante serializada lleva unidades con número de serie", () => {
  it("una variante que no es is_serialized se rechaza con VARIANT_NOT_SERIALIZED", () => {
    const result = planSerializedUnitRegistration(registration({ variantIsSerialized: false }));

    expect(result).toEqual({ ok: false, error: { code: "VARIANT_NOT_SERIALIZED" } });
  });

  it("un lote de granel (en ml) sobre una variante no serializada se rechaza como VARIANT_NOT_SERIALIZED, no lanza: un usuario puede pedirlo", () => {
    const result = planSerializedUnitRegistration(
      registration({ variantIsSerialized: false, lotQtyInitial: Quantity.ml(125.5) }),
    );

    expect(result).toEqual({ ok: false, error: { code: "VARIANT_NOT_SERIALIZED" } });
  });

  it("se mira antes que la capacidad: una variante no serializada con el lote lleno se rechaza como VARIANT_NOT_SERIALIZED", () => {
    const result = planSerializedUnitRegistration(
      registration({ variantIsSerialized: false, registeredCount: 3 }),
    );

    expect(result).toEqual({ ok: false, error: { code: "VARIANT_NOT_SERIALIZED" } });
  });
});

describe("RN-SER-03 · las unidades registradas de un lote no superan su qty_initial", () => {
  it("la primera unidad de un lote de 3 se acepta y quedan 2 sin registrar", () => {
    const result = planSerializedUnitRegistration(registration());

    expect(result).toEqual({ ok: true, value: { remainingAfter: Quantity.units(2) } });
  });

  it("la tercera unidad de un lote de 3 con 2 registradas se acepta y deja 0", () => {
    const result = planSerializedUnitRegistration(registration({ registeredCount: 2 }));

    expect(result).toEqual({ ok: true, value: { remainingAfter: Quantity.units(0) } });
  });

  it("la cuarta unidad de un lote de 3 con 3 registradas se rechaza con LOT_SERIAL_CAPACITY_EXCEEDED", () => {
    const result = planSerializedUnitRegistration(registration({ registeredCount: 3 }));

    expect(result).toEqual({
      ok: false,
      error: {
        code: "LOT_SERIAL_CAPACITY_EXCEEDED",
        capacity: Quantity.units(3),
        registered: 3,
      },
    });
  });

  it("un lote de una sola unidad acepta su única unidad y rechaza una segunda", () => {
    const one = Quantity.units(1);

    expect(
      planSerializedUnitRegistration(registration({ lotQtyInitial: one, registeredCount: 0 })),
    ).toEqual({ ok: true, value: { remainingAfter: Quantity.units(0) } });
    expect(
      planSerializedUnitRegistration(registration({ lotQtyInitial: one, registeredCount: 1 })),
    ).toMatchObject({ ok: false, error: { code: "LOT_SERIAL_CAPACITY_EXCEEDED" } });
  });
});

describe("planSerializedUnitRegistration · argumentos fuera de rango son un bug del llamador, no un fallo de negocio", () => {
  it("lotQtyInitial en ml o menor a una unidad lanza InvalidSerializedUnitInputError", () => {
    expect(() =>
      planSerializedUnitRegistration(registration({ lotQtyInitial: Quantity.ml(100) })),
    ).toThrow(InvalidSerializedUnitInputError);
    expect(() =>
      planSerializedUnitRegistration(registration({ lotQtyInitial: Quantity.units(0) })),
    ).toThrow(InvalidSerializedUnitInputError);
  });

  it("registeredCount negativo o no entero lanza InvalidSerializedUnitInputError", () => {
    expect(() => planSerializedUnitRegistration(registration({ registeredCount: -1 }))).toThrow(
      InvalidSerializedUnitInputError,
    );
    expect(() => planSerializedUnitRegistration(registration({ registeredCount: 1.5 }))).toThrow(
      InvalidSerializedUnitInputError,
    );
  });
});
