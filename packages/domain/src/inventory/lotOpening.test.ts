import { describe, expect, it } from "vitest";
import { InvalidLotOpeningInputError } from "../shared/errors.js";
import { Money } from "../shared/money.js";
import type { Clock, IdGenerator } from "../shared/ports.js";
import { Quantity } from "../shared/quantity.js";
import { openLot, type OpenLotInput, type SealedLotSnapshot } from "./lotOpening.js";

const fixedClock: Clock = { now: () => new Date("2026-03-10T12:00:00Z") };
const fixedIdGenerator: IdGenerator = { next: () => "LOT-LAY-001-BULK" };

/** Constructor con valores por defecto razonables; sobrescribir solo lo relevante de cada test. */
function sealedLot(overrides: Partial<SealedLotSnapshot> = {}): SealedLotSnapshot {
  return {
    id: "LOT-LAY-001",
    status: "available",
    unitLandedCostPyg: Money.pyg(1_496_500n),
    ...overrides,
  };
}

function openLotInput(overrides: Partial<OpenLotInput> = {}): OpenLotInput {
  return {
    sealedLot: sealedLot(),
    nominalVolumeMl: 125,
    clock: fixedClock,
    idGenerator: fixedIdGenerator,
    ...overrides,
  };
}

describe("RN-LOT-02, ADR-009 · abrir un frasco es una conversión entre dos lotes", () => {
  it("caso Layton: 1.496.500 Gs. heredados íntegros, 125 ml → 11.972 Gs./ml", () => {
    const result = openLot(openLotInput());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toEqual({
      sealedLotId: "LOT-LAY-001",
      sealedLotStatusAfter: "open_for_decant",
      openedAt: new Date("2026-03-10T12:00:00Z"),
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
        },
        {
          lotId: "LOT-LAY-001-BULK",
          qty: Quantity.ml(125),
          movementType: "transfer_in",
          totalCost: Money.pyg(1_496_500n),
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

  it("un sellado en cualquier otro estado que no sea available también se rechaza", () => {
    const result = openLot(openLotInput({ sealedLot: sealedLot({ status: "damaged" }) }));

    expect(result).toEqual({
      ok: false,
      error: { code: "SEALED_LOT_NOT_OPENABLE", status: "damaged" },
    });
  });
});

describe("openLot · nominalVolumeMl fuera de rango es un bug del llamador, no un fallo de negocio", () => {
  it("cero o negativo lanza InvalidLotOpeningInputError", () => {
    expect(() => openLot(openLotInput({ nominalVolumeMl: 0 }))).toThrow(
      InvalidLotOpeningInputError,
    );
    expect(() => openLot(openLotInput({ nominalVolumeMl: -125 }))).toThrow(
      InvalidLotOpeningInputError,
    );
  });

  it("no finito (NaN, Infinity) lanza InvalidLotOpeningInputError", () => {
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
});
