import { describe, expect, it } from "vitest";
import type { LotSnapshot } from "../inventory/allocation.js";
import { Money } from "../shared/money.js";
import { Quantity } from "../shared/quantity.js";
import type { DecantPlan } from "./planning.js";
import { executeDecant, type BomLotSnapshot, type ExecuteDecantInput } from "./execution.js";

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

function bomLot(
  overrides: Partial<BomLotSnapshot> & { componentId: string; lotId: string },
): BomLotSnapshot {
  return {
    available: Quantity.units(100),
    unitCost: Money.pyg(0n),
    isOptional: false,
    ...overrides,
  };
}

/** El plan del caso Layton: 1 decant de 10 ml, 2% de merma esperada, 1 unidad de cada insumo. */
function laytonPlan(): DecantPlan {
  return {
    mlExpected: Quantity.ml(10),
    wasteExpected: Quantity.ml(0.2),
    mlToReserve: Quantity.ml(10.2),
    bomToReserve: [
      { componentId: "vial", qty: Quantity.units(1) },
      { componentId: "atomizador", qty: Quantity.units(1) },
      { componentId: "etiqueta", qty: Quantity.units(1) },
    ],
  };
}

function laytonBomLots(
  overrides: Partial<Record<"vial" | "atomizador" | "etiqueta", BomLotSnapshot>> = {},
) {
  return [
    overrides.vial ?? bomLot({ componentId: "vial", lotId: "L-VIAL", unitCost: Money.pyg(4_500n) }),
    overrides.atomizador ??
      bomLot({ componentId: "atomizador", lotId: "L-ATOM", unitCost: Money.pyg(2_500n) }),
    overrides.etiqueta ??
      bomLot({ componentId: "etiqueta", lotId: "L-ETIQ", unitCost: Money.pyg(300n) }),
  ];
}

function executeInput(overrides: Partial<ExecuteDecantInput> = {}): ExecuteDecantInput {
  return {
    plan: laytonPlan(),
    wasteActual: Quantity.ml(0.35),
    bulkLot: bulkLot(),
    bomLots: laytonBomLots(),
    ...overrides,
  };
}

describe("RN-FRA-03, RN-FRA-04 · executeDecant — caso Layton completo", () => {
  it("da COGS 131.210, desglosado en 119.720 de líquido, 4.190 de merma y 7.300 de insumos", () => {
    const result = executeDecant(executeInput());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.costBreakdown).toEqual({
      liquid: Money.pyg(119_720n),
      waste: Money.pyg(4_190n),
      supplies: Money.pyg(7_300n),
    });
    expect(result.value.cogs).toEqual(Money.pyg(131_210n));
  });

  it("produce los cinco movimientos: consumo, merma y los tres del BOM, todos negativos", () => {
    const result = executeDecant(executeInput());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.movements).toEqual([
      {
        lotId: "LOT-LAY-001-BULK",
        qty: Quantity.ml(-10),
        movementType: "decant_consumption",
        totalCost: Money.pyg(119_720n),
      },
      {
        lotId: "LOT-LAY-001-BULK",
        qty: Quantity.ml(-0.35),
        movementType: "waste",
        totalCost: Money.pyg(4_190n),
      },
      {
        lotId: "L-VIAL",
        qty: Quantity.units(-1),
        movementType: "bom_consumption",
        totalCost: Money.pyg(4_500n),
      },
      {
        lotId: "L-ATOM",
        qty: Quantity.units(-1),
        movementType: "bom_consumption",
        totalCost: Money.pyg(2_500n),
      },
      {
        lotId: "L-ETIQ",
        qty: Quantity.units(-1),
        movementType: "bom_consumption",
        totalCost: Money.pyg(300n),
      },
    ]);
    expect(result.value.skippedOptionalComponents).toEqual([]);
  });
});

describe("Caso borde #2 del catálogo · la merma real supera lo reservado", () => {
  it("permite y consume la merma REAL, no la esperada del plan", () => {
    // wasteExpected del plan es 0,2; acá se derramó bastante más: 0,5.
    const result = executeDecant(executeInput({ wasteActual: Quantity.ml(0.5) }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.costBreakdown.waste).toEqual(Money.pyg(5_986n));
    expect(result.value.movements[1]).toEqual({
      lotId: "LOT-LAY-001-BULK",
      qty: Quantity.ml(-0.5),
      movementType: "waste",
      totalCost: Money.pyg(5_986n),
    });
  });

  it("si el granel no alcanza para la merma real, la orden falla (queda in_progress para resolución manual)", () => {
    const result = executeDecant(
      executeInput({
        wasteActual: Quantity.ml(0.35),
        bulkLot: bulkLot({ available: Quantity.ml(10.1) }), // hacen falta 10,35
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "INSUFFICIENT_BULK_FOR_ACTUAL",
        required: Quantity.ml(10.35),
        available: Quantity.ml(10.1),
      },
    });
  });
});

describe("Caso borde #3 del catálogo · falta un insumo obligatorio del BOM", () => {
  it("rechaza la ejecución entera cuando el lote del insumo no existe en absoluto", () => {
    const result = executeDecant(
      executeInput({
        bomLots: [
          bomLot({ componentId: "vial", lotId: "L-VIAL", unitCost: Money.pyg(4_500n) }),
          bomLot({ componentId: "etiqueta", lotId: "L-ETIQ", unitCost: Money.pyg(300n) }),
          // Falta "atomizador" por completo.
        ],
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "MISSING_BOM_COMPONENT",
        componentId: "atomizador",
        required: Quantity.units(1),
        available: Quantity.units(0),
      },
    });
  });

  it("rechaza la ejecución entera cuando el lote existe pero no alcanza y NO es opcional", () => {
    const result = executeDecant(
      executeInput({
        bomLots: laytonBomLots({
          atomizador: bomLot({
            componentId: "atomizador",
            lotId: "L-ATOM",
            available: Quantity.units(0),
            isOptional: false,
          }),
        }),
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "MISSING_BOM_COMPONENT",
        componentId: "atomizador",
        required: Quantity.units(1),
        available: Quantity.units(0),
      },
    });
  });

  it("no produce ningún movimiento cuando falla por un insumo faltante", () => {
    const result = executeDecant(
      executeInput({
        bomLots: [bomLot({ componentId: "vial", lotId: "L-VIAL" })],
      }),
    );

    expect(result.ok).toBe(false);
  });
});

describe("Caso borde #4 del catálogo · un insumo opcional falta", () => {
  it("ejecuta sin él y lo registra en skippedOptionalComponents, sin su movimiento ni su costo", () => {
    const result = executeDecant(
      executeInput({
        bomLots: laytonBomLots({
          etiqueta: bomLot({
            componentId: "etiqueta",
            lotId: "L-ETIQ",
            available: Quantity.units(0),
            isOptional: true,
          }),
        }),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.skippedOptionalComponents).toEqual(["etiqueta"]);
    expect(result.value.movements.map((m) => m.lotId)).toEqual([
      "LOT-LAY-001-BULK",
      "LOT-LAY-001-BULK",
      "L-VIAL",
      "L-ATOM",
    ]);
    // Sin el costo de la etiqueta: 119.720 + 4.190 + 4.500 + 2.500 = 130.910.
    expect(result.value.cogs).toEqual(Money.pyg(130_910n));
    expect(result.value.costBreakdown.supplies).toEqual(Money.pyg(7_000n));
  });
});

describe("executeDecant · el lote de origen debe ser granel abierto para decantar", () => {
  it("un lote que no está en open_for_decant se rechaza con SOURCE_LOT_NOT_DECANTABLE", () => {
    const result = executeDecant(executeInput({ bulkLot: bulkLot({ status: "quarantine" }) }));

    expect(result).toEqual({
      ok: false,
      error: { code: "SOURCE_LOT_NOT_DECANTABLE", status: "quarantine" },
    });
  });

  it("WP-A15 · un sellado en open_for_decant (el padre recién abierto, ADR-009) también se rechaza, aunque comparta status con el granel", () => {
    const result = executeDecant(
      executeInput({ bulkLot: bulkLot({ variantType: "sealed", uom: "unit" }) }),
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "SOURCE_LOT_NOT_DECANTABLE", status: "open_for_decant" },
    });
  });
});

describe("executeDecant · un decant sin insumos en el BOM no genera movimientos de bom_consumption", () => {
  it("el COGS es solo líquido + merma, y supplies da cero", () => {
    const result = executeDecant(
      executeInput({ plan: { ...laytonPlan(), bomToReserve: [] }, bomLots: [] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.costBreakdown.supplies).toEqual(Money.pyg(0n));
    expect(result.value.movements).toHaveLength(2);
    expect(result.value.cogs).toEqual(Money.pyg(123_910n)); // 119.720 + 4.190
  });
});
