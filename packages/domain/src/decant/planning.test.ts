import { describe, expect, it } from "vitest";
import type { LotSnapshot } from "../inventory/allocation.js";
import { InvalidDecantInputError } from "../shared/errors.js";
import { Money } from "../shared/money.js";
import { Percentage } from "../shared/percentage.js";
import { Quantity } from "../shared/quantity.js";
import { planDecant, type BomAvailability, type PlanDecantInput } from "./planning.js";

/** Constructor con valores por defecto razonables; sobrescribir solo lo relevante de cada test. */
function bulkLot(overrides: Partial<LotSnapshot> = {}): LotSnapshot {
  return {
    id: "LOT-LAY-001-BULK",
    receivedAt: new Date("2026-01-01T00:00:00Z"),
    expiryAt: null,
    available: Quantity.ml(125),
    unitCost: Money.pyg(11_972n),
    status: "open_for_decant",
    variantType: "bulk",
    uom: "ml",
    ...overrides,
  };
}

function bomAvailability(
  overrides: Partial<BomAvailability> & { componentId: string },
): BomAvailability {
  return {
    available: Quantity.units(100),
    perUnit: Quantity.units(1),
    ...overrides,
  };
}

function planInput(overrides: Partial<PlanDecantInput> = {}): PlanDecantInput {
  return {
    unitsRequested: 1,
    mlPerUnit: 10,
    wasteFactor: Percentage.of(0.02),
    bulkLot: bulkLot(),
    bomAvailability: [
      bomAvailability({ componentId: "vial" }),
      bomAvailability({ componentId: "atomizador" }),
      bomAvailability({ componentId: "etiqueta" }),
    ],
    ...overrides,
  };
}

describe("RN-FRA-02 · planDecant calcula la reserva sin tocar inventario", () => {
  it("1 decant de 10 ml con waste_factor 2% reserva 10,200 ml y 1 unidad de cada insumo", () => {
    const result = planDecant(planInput());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toEqual({
      mlExpected: Quantity.ml(10),
      wasteExpected: Quantity.ml(0.2),
      mlToReserve: Quantity.ml(10.2),
      bomToReserve: [
        { componentId: "vial", qty: Quantity.units(1) },
        { componentId: "atomizador", qty: Quantity.units(1) },
        { componentId: "etiqueta", qty: Quantity.units(1) },
      ],
    });
  });

  it("3 unidades del mismo decant escalan tanto la reserva de líquido como la de insumos", () => {
    const result = planDecant(planInput({ unitsRequested: 3 }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.mlExpected).toEqual(Quantity.ml(30));
    expect(result.value.wasteExpected).toEqual(Quantity.ml(0.6));
    expect(result.value.mlToReserve).toEqual(Quantity.ml(30.6));
    expect(result.value.bomToReserve).toEqual([
      { componentId: "vial", qty: Quantity.units(3) },
      { componentId: "atomizador", qty: Quantity.units(3) },
      { componentId: "etiqueta", qty: Quantity.units(3) },
    ]);
  });

  it("sin insumos en el BOM, reserva solo el líquido", () => {
    const result = planDecant(planInput({ bomAvailability: [] }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.bomToReserve).toEqual([]);
  });
});

describe("Caso borde #1 del catálogo · el granel no alcanza para el decant completo", () => {
  it("rechaza la venta ANTES de reservar nada — no fracciona parcialmente", () => {
    const result = planDecant(planInput({ bulkLot: bulkLot({ available: Quantity.ml(5) }) }));

    expect(result).toEqual({
      ok: false,
      error: {
        code: "INSUFFICIENT_BULK",
        required: Quantity.ml(10.2),
        available: Quantity.ml(5),
      },
    });
  });
});

describe("RN-FRA-02 · un insumo del BOM insuficiente también rechaza la reserva completa", () => {
  it("falla con INSUFFICIENT_BOM_COMPONENT identificando el insumo que no alcanza", () => {
    const result = planDecant(
      planInput({
        bomAvailability: [
          bomAvailability({ componentId: "vial" }),
          bomAvailability({ componentId: "atomizador", available: Quantity.units(0) }),
          bomAvailability({ componentId: "etiqueta" }),
        ],
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "INSUFFICIENT_BOM_COMPONENT",
        componentId: "atomizador",
        required: Quantity.units(1),
        available: Quantity.units(0),
      },
    });
  });
});

describe("planDecant · el lote de origen debe ser granel abierto para decantar", () => {
  it("un lote sellado sin convertir (status 'available') se rechaza con SOURCE_LOT_NOT_DECANTABLE", () => {
    const result = planDecant(planInput({ bulkLot: bulkLot({ status: "available" }) }));

    expect(result).toEqual({
      ok: false,
      error: { code: "SOURCE_LOT_NOT_DECANTABLE", status: "available" },
    });
  });

  it("un lote agotado también se rechaza", () => {
    const result = planDecant(planInput({ bulkLot: bulkLot({ status: "depleted" }) }));

    expect(result).toEqual({
      ok: false,
      error: { code: "SOURCE_LOT_NOT_DECANTABLE", status: "depleted" },
    });
  });
});

describe("WP-A15 · el sellado padre recién abierto no pasa como fuente de decant, aunque comparta status con el granel", () => {
  it("un sellado en open_for_decant (el padre recién abierto, ADR-009) se rechaza aunque su status sea el mismo que el del granel", () => {
    const result = planDecant(
      planInput({ bulkLot: bulkLot({ variantType: "sealed", uom: "unit" }) }),
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "SOURCE_LOT_NOT_DECANTABLE", status: "open_for_decant" },
    });
  });

  it("variantType 'bulk' con uom 'unit' (dato inconsistente) también se rechaza — un decant siempre se sirve de ml", () => {
    const result = planDecant(planInput({ bulkLot: bulkLot({ uom: "unit" }) }));

    expect(result).toEqual({
      ok: false,
      error: { code: "SOURCE_LOT_NOT_DECANTABLE", status: "open_for_decant" },
    });
  });

  it("un granel en open_for_decant se acepta — es el caso que ya validaba antes de A15", () => {
    const result = planDecant(planInput({ bulkLot: bulkLot() }));

    expect(result.ok).toBe(true);
  });
});

describe("planDecant · argumentos fuera de rango son un bug del llamador, no un fallo de negocio", () => {
  it("unitsRequested no entero lanza InvalidDecantInputError", () => {
    expect(() => planDecant(planInput({ unitsRequested: 1.5 }))).toThrow(InvalidDecantInputError);
  });

  it("unitsRequested cero o negativo lanza InvalidDecantInputError", () => {
    expect(() => planDecant(planInput({ unitsRequested: 0 }))).toThrow(InvalidDecantInputError);
  });

  it("mlPerUnit no positivo lanza InvalidDecantInputError", () => {
    expect(() => planDecant(planInput({ mlPerUnit: 0 }))).toThrow(InvalidDecantInputError);
  });
});
