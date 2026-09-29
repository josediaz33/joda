import { describe, expect, it } from "vitest";
import { InvalidLotOpeningInputError } from "../shared/errors.js";
import { Money } from "../shared/money.js";
import type { Clock, IdGenerator } from "../shared/ports.js";
import { Quantity } from "../shared/quantity.js";
import { openLot, type OpenLotInput, type SealedLotSnapshot } from "./lotOpening.js";

const fixedClock: Clock = { now: () => new Date("2026-03-10T12:00:00Z") };

/** Ids en el orden en que `openLot` los pide: primero el lote separado (si hay), después el granel. */
function sequentialIds(...ids: string[]): IdGenerator {
  let index = 0;
  return { next: () => ids[index++]! };
}

/** Constructor con valores por defecto razonables; sobrescribir solo lo relevante de cada test. */
function sealedLot(overrides: Partial<SealedLotSnapshot> = {}): SealedLotSnapshot {
  return {
    id: "LOT-LAY-001",
    status: "available",
    qtyInitial: Quantity.units(1),
    onHand: Quantity.units(1),
    unitLandedCostPyg: Money.pyg(1_496_500n),
    ...overrides,
  };
}

function openLotInput(overrides: Partial<OpenLotInput> = {}): OpenLotInput {
  return {
    sealedLot: sealedLot(),
    nominalVolumeMl: 125,
    variantAvailable: Quantity.units(1),
    clock: fixedClock,
    idGenerator: sequentialIds("LOT-LAY-001-BULK"),
    ...overrides,
  };
}

describe("RN-LOT-02, ADR-009 · abrir un frasco es una conversión entre dos lotes", () => {
  it("caso Layton, lote de una unidad: se abre directo, 1.496.500 Gs. heredados íntegros, 125 ml → 11.972 Gs./ml", () => {
    const result = openLot(openLotInput());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toEqual({
      sealedLotId: "LOT-LAY-001",
      sealedLotStatusAfter: "open_for_decant",
      openedAt: new Date("2026-03-10T12:00:00Z"),
      separation: null,
      bulkLot: {
        id: "LOT-LAY-001-BULK",
        parentLotId: "LOT-LAY-001",
        qtyInitial: Quantity.ml(125),
        landedCostPyg: Money.pyg(1_496_500n),
        unitLandedCostPyg: Money.pyg(11_972n),
      },
      movements: [
        {
          lotId: "LOT-LAY-001",
          qty: Quantity.units(-1),
          movementType: "transfer_out",
          totalCost: Money.pyg(1_496_500n),
          purpose: "opening",
          costLayer: {
            lotId: "LOT-LAY-001",
            qty: Quantity.units(1),
            unitCost: Money.pyg(1_496_500n),
            totalCost: Money.pyg(1_496_500n),
          },
        },
        {
          lotId: "LOT-LAY-001-BULK",
          qty: Quantity.ml(125),
          movementType: "transfer_in",
          totalCost: Money.pyg(1_496_500n),
          purpose: "opening",
          costLayer: null,
        },
      ],
    });
  });

  it("el costo se hereda ÍNTEGRO: landedCostPyg del granel es exactamente unitLandedCostPyg del sellado, no un recálculo", () => {
    const result = openLot(
      openLotInput({ sealedLot: sealedLot({ unitLandedCostPyg: Money.pyg(2_000_000n) }) }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.bulkLot.landedCostPyg).toEqual(Money.pyg(2_000_000n));
  });

  it("las dos capas de la conversión suman cero unidades netas de dinero: lo que sale del sellado es lo que entra al granel", () => {
    const result = openLot(openLotInput());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const [transferOut, transferIn] = result.value.movements;
    expect(transferOut!.totalCost).toEqual(transferIn!.totalCost);
  });

  it("la salida del sellado registra su capa de costo con el costo de un frasco; la entrada al granel no consume ninguna (ADR-008)", () => {
    const result = openLot(openLotInput());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const [transferOut, transferIn] = result.value.movements;
    expect(transferOut!.costLayer!.totalCost).toEqual(transferOut!.totalCost);
    expect(transferIn!.costLayer).toBeNull();
  });
});

describe("RN-LOT-02, caso borde 21 · un lote de varias unidades separa primero la que se abre", () => {
  const threeBottles = { qtyInitial: Quantity.units(3), onHand: Quantity.units(3) };

  it("lote de 3 frascos: nace un lote de una unidad hijo del original y ESE es el que se abre; el original no cambia de estado", () => {
    const result = openLot(
      openLotInput({
        sealedLot: sealedLot(threeBottles),
        variantAvailable: Quantity.units(3),
        idGenerator: sequentialIds("LOT-LAY-001-U1", "LOT-LAY-001-BULK"),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.sealedLotId).toBe("LOT-LAY-001-U1");
    expect(result.value.separation).toEqual({
      sourceLotId: "LOT-LAY-001",
      unitLot: {
        id: "LOT-LAY-001-U1",
        parentLotId: "LOT-LAY-001",
        qtyInitial: Quantity.units(1),
        landedCostPyg: Money.pyg(1_496_500n),
        unitLandedCostPyg: Money.pyg(1_496_500n),
      },
    });
    expect(result.value.bulkLot.parentLotId).toBe("LOT-LAY-001-U1");
  });

  it("lote de 3 frascos: cuatro movimientos, en el orden separación → apertura, y el original solo pierde UNA unidad", () => {
    const result = openLot(
      openLotInput({
        sealedLot: sealedLot(threeBottles),
        variantAvailable: Quantity.units(3),
        idGenerator: sequentialIds("LOT-LAY-001-U1", "LOT-LAY-001-BULK"),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(
      result.value.movements.map((m) => [m.lotId, m.qty.value, m.movementType, m.purpose]),
    ).toEqual([
      ["LOT-LAY-001", -1, "transfer_out", "separation"],
      ["LOT-LAY-001-U1", 1, "transfer_in", "separation"],
      ["LOT-LAY-001-U1", -1, "transfer_out", "opening"],
      ["LOT-LAY-001-BULK", 125, "transfer_in", "opening"],
    ]);
  });

  it("lote de 3 frascos: las dos salidas registran su capa de costo, cada una sobre su propio lote", () => {
    const result = openLot(
      openLotInput({
        sealedLot: sealedLot(threeBottles),
        variantAvailable: Quantity.units(3),
        idGenerator: sequentialIds("LOT-LAY-001-U1", "LOT-LAY-001-BULK"),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.movements.map((m) => m.costLayer?.lotId ?? null)).toEqual([
      "LOT-LAY-001",
      null,
      "LOT-LAY-001-U1",
      null,
    ]);
  });

  it("lote de 3, se venden 2, se abre el tercero: el granel cuesta lo de UN frasco (11.972 Gs./ml), no el del lote entero", () => {
    // Saldo 1 pero qty_initial 3: se separa igual. Abrirlo directo le habría
    // pasado al granel el costo del lote (4.489.500) y triplicado el costo
    // por ml, sin que nada fallara.
    const result = openLot(
      openLotInput({
        sealedLot: sealedLot({ qtyInitial: Quantity.units(3), onHand: Quantity.units(1) }),
        variantAvailable: Quantity.units(1),
        idGenerator: sequentialIds("LOT-LAY-001-U1", "LOT-LAY-001-BULK"),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.separation).not.toBeNull();
    expect(result.value.bulkLot.landedCostPyg).toEqual(Money.pyg(1_496_500n));
    expect(result.value.bulkLot.unitLandedCostPyg).toEqual(Money.pyg(11_972n));
  });

  it("dos frascos: alcanza para separar, es el mínimo lote de varias unidades", () => {
    const result = openLot(
      openLotInput({
        sealedLot: sealedLot({ qtyInitial: Quantity.units(2), onHand: Quantity.units(2) }),
        variantAvailable: Quantity.units(2),
        idGenerator: sequentialIds("LOT-LAY-001-U1", "LOT-LAY-001-BULK"),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.separation!.sourceLotId).toBe("LOT-LAY-001");
  });
});

describe("RN-LOT-03 · el sellado queda en open_for_decant, listo para que la base bloquee su venta", () => {
  it("sealedLotStatusAfter es open_for_decant — RN-LOT-03 en sí la impone app.assert_sealed_lot_not_open, esta función solo produce el status que ese trigger necesita", () => {
    const result = openLot(openLotInput());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.sealedLotStatusAfter).toBe("open_for_decant");
  });
});

describe("Caso borde #5 del catálogo · abrir un frasco ya abierto se rechaza", () => {
  it("un sellado ya en open_for_decant se rechaza con SEALED_LOT_NOT_OPENABLE", () => {
    const result = openLot(openLotInput({ sealedLot: sealedLot({ status: "open_for_decant" }) }));

    expect(result).toEqual({
      ok: false,
      error: { code: "SEALED_LOT_NOT_OPENABLE", status: "open_for_decant" },
    });
  });

  it("un sellado en cualquier otro estado que no sea available también se rechaza (RN-LOT-02, precondición de estado)", () => {
    const result = openLot(openLotInput({ sealedLot: sealedLot({ status: "damaged" }) }));

    expect(result).toEqual({
      ok: false,
      error: { code: "SEALED_LOT_NOT_OPENABLE", status: "damaged" },
    });
  });
});

describe("RN-LOT-02 · no se abre lo que no hay", () => {
  it("un lote sin frascos en saldo se rechaza con SEALED_LOT_WITHOUT_STOCK, aunque nació con varios", () => {
    const result = openLot(
      openLotInput({
        sealedLot: sealedLot({ qtyInitial: Quantity.units(3), onHand: Quantity.units(0) }),
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "SEALED_LOT_WITHOUT_STOCK", onHand: Quantity.units(0) },
    });
  });

  it("con el lote en saldo pero la variante entera reservada (disponible 0), se rechaza con SEALED_VARIANT_NOT_AVAILABLE", () => {
    const result = openLot(openLotInput({ variantAvailable: Quantity.units(0) }));

    expect(result).toEqual({
      ok: false,
      error: { code: "SEALED_VARIANT_NOT_AVAILABLE", available: Quantity.units(0) },
    });
  });

  it("el estado se mira antes que el saldo: un sellado abierto sin saldo se rechaza como NOT_OPENABLE", () => {
    const result = openLot(
      openLotInput({
        sealedLot: sealedLot({ status: "open_for_decant", onHand: Quantity.units(0) }),
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "SEALED_LOT_NOT_OPENABLE", status: "open_for_decant" },
    });
  });
});

describe("openLot · argumentos fuera de rango son un bug del llamador, no un fallo de negocio", () => {
  it("nominalVolumeMl cero o negativo lanza InvalidLotOpeningInputError", () => {
    expect(() => openLot(openLotInput({ nominalVolumeMl: 0 }))).toThrow(
      InvalidLotOpeningInputError,
    );
    expect(() => openLot(openLotInput({ nominalVolumeMl: -125 }))).toThrow(
      InvalidLotOpeningInputError,
    );
  });

  it("nominalVolumeMl no finito (NaN, Infinity) lanza InvalidLotOpeningInputError", () => {
    expect(() => openLot(openLotInput({ nominalVolumeMl: Number.NaN }))).toThrow(
      InvalidLotOpeningInputError,
    );
    expect(() => openLot(openLotInput({ nominalVolumeMl: Number.POSITIVE_INFINITY }))).toThrow(
      InvalidLotOpeningInputError,
    );
  });

  it("se valida ANTES que el status del sellado: un volumen inválido lanza aunque el lote tampoco fuera abrible", () => {
    expect(() =>
      openLot(
        openLotInput({
          nominalVolumeMl: 0,
          sealedLot: sealedLot({ status: "open_for_decant" }),
        }),
      ),
    ).toThrow(InvalidLotOpeningInputError);
  });

  it("qtyInitial en ml, o menor a una unidad, lanza InvalidLotOpeningInputError", () => {
    expect(() =>
      openLot(openLotInput({ sealedLot: sealedLot({ qtyInitial: Quantity.ml(125) }) })),
    ).toThrow(InvalidLotOpeningInputError);
    expect(() =>
      openLot(openLotInput({ sealedLot: sealedLot({ qtyInitial: Quantity.units(0) }) })),
    ).toThrow(InvalidLotOpeningInputError);
  });

  it("onHand en ml, o negativo, lanza InvalidLotOpeningInputError", () => {
    expect(() =>
      openLot(openLotInput({ sealedLot: sealedLot({ onHand: Quantity.ml(1) }) })),
    ).toThrow(InvalidLotOpeningInputError);
    expect(() =>
      openLot(openLotInput({ sealedLot: sealedLot({ onHand: Quantity.units(-1) }) })),
    ).toThrow(InvalidLotOpeningInputError);
  });
});
