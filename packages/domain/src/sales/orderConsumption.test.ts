import { describe, expect, it } from "vitest";
import { InvalidAllocationRequestError } from "../shared/errors.js";
import { Money } from "../shared/money.js";
import { Quantity } from "../shared/quantity.js";
import {
  planSaleConsumption,
  type PlanSaleConsumptionInput,
  type SaleConsumptionLine,
  type SaleLotSnapshot,
} from "./orderConsumption.js";

const V_SEALED = "variant-a-sealed";
const V_WATCH = "variant-b-watch";
const V_CASE = "variant-c-case";

function lot(overrides: Partial<SaleLotSnapshot> & { id: string }): SaleLotSnapshot {
  return {
    variantId: V_SEALED,
    receivedAt: new Date("2026-01-01T00:00:00.000Z"),
    expiryAt: null,
    available: Quantity.units(5),
    unitCost: Money.pyg(1_000n),
    status: "available",
    variantType: "sealed",
    uom: "unit",
    ...overrides,
  };
}

function line(overrides: Partial<SaleConsumptionLine> = {}): SaleConsumptionLine {
  return {
    lineId: "line-1",
    variantId: V_SEALED,
    qty: Quantity.units(1),
    policy: "fifo",
    serialUnit: null,
    ...overrides,
  };
}

function input(overrides: Partial<PlanSaleConsumptionInput> = {}): PlanSaleConsumptionInput {
  return {
    lines: [line()],
    lots: [lot({ id: "lot-1" })],
    availability: [{ variantId: V_SEALED, available: Quantity.units(10) }],
    ...overrides,
  };
}

describe("RN-COS-04 · el consumo de una línea común va en capas por lote", () => {
  it("el ejemplo verificado: 3 unidades con L-001 (2 a 1.400.000) y L-002 (5 a 1.550.000) son 2.800.000 + 1.550.000", () => {
    const result = planSaleConsumption(
      input({
        lines: [line({ qty: Quantity.units(3) })],
        lots: [
          lot({
            id: "L-002",
            available: Quantity.units(5),
            unitCost: Money.pyg(1_550_000n),
            receivedAt: new Date("2026-02-01T00:00:00.000Z"),
          }),
          lot({ id: "L-001", available: Quantity.units(2), unitCost: Money.pyg(1_400_000n) }),
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [consumed] = result.value.lines;
    expect(
      consumed!.layers.map((layer) => [layer.lotId, layer.qty.value, layer.totalCost.minor]),
    ).toEqual([
      ["L-001", 2, 2_800_000n],
      ["L-002", 1, 1_550_000n],
    ]);
    expect(consumed!.cogs.minor).toBe(4_350_000n);
    expect(result.value.cogs.minor).toBe(4_350_000n);
  });

  it("la política fefo consume primero el que vence antes, y las capas salen por id de lote ascendente", () => {
    const result = planSaleConsumption(
      input({
        lines: [line({ qty: Quantity.units(2), policy: "fefo" })],
        lots: [
          lot({
            id: "lot-b",
            expiryAt: new Date("2027-01-01T00:00:00.000Z"),
            available: Quantity.units(1),
          }),
          lot({
            id: "lot-a",
            expiryAt: new Date("2028-01-01T00:00:00.000Z"),
            available: Quantity.units(5),
          }),
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lines[0]!.layers.map((layer) => [layer.lotId, layer.qty.value])).toEqual([
      ["lot-a", 1],
      ["lot-b", 1],
    ]);
  });

  it("no toca los lotes de otra variante", () => {
    const result = planSaleConsumption(
      input({
        lots: [
          lot({
            id: "lot-other",
            variantId: V_CASE,
            unitCost: Money.pyg(1n),
            receivedAt: new Date("2025-01-01T00:00:00.000Z"),
          }),
          lot({ id: "lot-1" }),
        ],
      }),
    );

    expect(result.ok && result.value.lines[0]!.layers.map((layer) => layer.lotId)).toEqual([
      "lot-1",
    ]);
  });
});

describe("RN-VTA-05 · varias líneas del pedido consumen una tras otra y el COGS del pedido es la suma de sus capas", () => {
  it("la segunda línea de la misma variante ve el saldo que dejó la primera", () => {
    const result = planSaleConsumption(
      input({
        lines: [
          line({ lineId: "line-1", qty: Quantity.units(2) }),
          line({ lineId: "line-2", qty: Quantity.units(2) }),
        ],
        lots: [
          lot({ id: "lot-1", available: Quantity.units(3), unitCost: Money.pyg(100n) }),
          lot({
            id: "lot-2",
            available: Quantity.units(3),
            unitCost: Money.pyg(200n),
            receivedAt: new Date("2026-03-01T00:00:00.000Z"),
          }),
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [first, second] = result.value.lines;
    expect(first!.layers.map((layer) => [layer.lotId, layer.qty.value])).toEqual([["lot-1", 2]]);
    expect(second!.layers.map((layer) => [layer.lotId, layer.qty.value])).toEqual([
      ["lot-1", 1],
      ["lot-2", 1],
    ]);
    expect([first!.cogs.minor, second!.cogs.minor]).toEqual([200n, 300n]);
    expect(result.value.cogs.minor).toBe(500n);
  });

  it("un pedido mixto: un sellado a granel de capas y un reloj serializado, cada uno con su costo", () => {
    const result = planSaleConsumption({
      lines: [
        line({ lineId: "line-sealed", qty: Quantity.units(2) }),
        line({
          lineId: "line-watch",
          variantId: V_WATCH,
          policy: "serial",
          serialUnit: { id: "unit-7", lotId: "lot-watch" },
        }),
      ],
      lots: [
        lot({ id: "lot-1", unitCost: Money.pyg(1_000n) }),
        lot({
          id: "lot-watch",
          variantId: V_WATCH,
          variantType: "unit",
          available: Quantity.units(3),
          unitCost: Money.pyg(900_000n),
        }),
      ],
      availability: [
        { variantId: V_SEALED, available: Quantity.units(5) },
        { variantId: V_WATCH, available: Quantity.units(3) },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lines.map((consumed) => consumed.cogs.minor)).toEqual([2_000n, 900_000n]);
    expect(result.value.cogs.minor).toBe(902_000n);
  });

  it("un pedido sin líneas consume nada y su COGS es cero", () => {
    const result = planSaleConsumption(input({ lines: [], availability: [] }));

    expect(result.ok && [result.value.lines.length, result.value.cogs.minor]).toEqual([0, 0n]);
  });
});

describe("RN-VTA-04 · una línea serializada mueve exactamente la unidad elegida, del lote de esa unidad", () => {
  const watchLine = line({
    lineId: "line-watch",
    variantId: V_WATCH,
    policy: "serial",
    serialUnit: { id: "unit-7", lotId: "lot-watch-2" },
  });
  const watchLots = [
    lot({
      id: "lot-watch-1",
      variantId: V_WATCH,
      unitCost: Money.pyg(800_000n),
      variantType: "unit",
    }),
    lot({
      id: "lot-watch-2",
      variantId: V_WATCH,
      unitCost: Money.pyg(950_000n),
      variantType: "unit",
      receivedAt: new Date("2026-06-01T00:00:00.000Z"),
    }),
  ];
  const watchAvailability = [{ variantId: V_WATCH, available: Quantity.units(10) }];

  it("consume del lote de la unidad aunque FIFO eligiera otro, con una capa de cantidad 1 al costo de ese lote", () => {
    const result = planSaleConsumption({
      lines: [watchLine],
      lots: watchLots,
      availability: watchAvailability,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [layer, ...rest] = result.value.lines[0]!.layers;
    expect(rest).toEqual([]);
    expect([layer!.lotId, layer!.qty.value, layer!.totalCost.minor]).toEqual([
      "lot-watch-2",
      1,
      950_000n,
    ]);
    expect(result.value.cogs.minor).toBe(950_000n);
  });

  it("la política de la variante no interviene: una variante serializada anterior a E05d con política fifo se vende igual", () => {
    const result = planSaleConsumption({
      lines: [{ ...watchLine, policy: "fifo" }],
      lots: watchLots,
      availability: watchAvailability,
    });

    expect(result.ok && result.value.lines[0]!.layers[0]!.lotId).toBe("lot-watch-2");
  });

  it("el lote de la unidad no está entre los consumibles: SERIAL_UNIT_LOT_UNAVAILABLE, sin consumir nada", () => {
    const result = planSaleConsumption({
      lines: [watchLine],
      lots: [watchLots[0]!],
      availability: watchAvailability,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "SERIAL_UNIT_LOT_UNAVAILABLE", lineId: "line-watch", serialUnitId: "unit-7" },
    });
  });

  it("el lote de la unidad es de otra variante que el de la línea: SERIAL_UNIT_LOT_UNAVAILABLE", () => {
    const result = planSaleConsumption({
      lines: [watchLine],
      lots: [lot({ id: "lot-watch-2", variantId: V_CASE })],
      availability: watchAvailability,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("SERIAL_UNIT_LOT_UNAVAILABLE");
  });

  it("dos líneas sobre unidades del mismo lote de una sola unidad: la segunda no tiene saldo", () => {
    const second = {
      ...watchLine,
      lineId: "line-watch-2",
      serialUnit: { id: "unit-8", lotId: "lot-watch-2" },
    };
    const result = planSaleConsumption({
      lines: [watchLine, second],
      lots: [{ ...watchLots[1]!, available: Quantity.units(1) }],
      availability: watchAvailability,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "SERIAL_UNIT_LOT_UNAVAILABLE",
        lineId: "line-watch-2",
        serialUnitId: "unit-8",
      },
    });
  });

  it("una línea serializada de cantidad distinta de 1 es un bug de quien arma la entrada: lanza", () => {
    expect(() =>
      planSaleConsumption({
        lines: [{ ...watchLine, qty: Quantity.units(2) }],
        lots: watchLots,
        availability: watchAvailability,
      }),
    ).toThrow(InvalidAllocationRequestError);
  });
});

describe("RN-VTA-02 · el disponible del pedido manda: una reserva ajena no se consume aunque el lote tenga saldo", () => {
  it("el disponible por variante no cubre lo pedido: INSUFFICIENT_STOCK con el faltante", () => {
    const result = planSaleConsumption(
      input({
        lines: [line({ qty: Quantity.units(3) })],
        availability: [{ variantId: V_SEALED, available: Quantity.units(2) }],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok || result.error.code !== "INSUFFICIENT_STOCK") return;
    const [shortage] = result.error.shortages;
    expect([shortage!.requested.value, shortage!.available.value]).toEqual([3, 2]);
  });

  it("suma todas las líneas de la variante: dos líneas de 3 no caben en 5 aunque cada una sí", () => {
    const result = planSaleConsumption(
      input({
        lines: [
          line({ lineId: "line-1", qty: Quantity.units(3) }),
          line({ lineId: "line-2", qty: Quantity.units(3) }),
        ],
        availability: [{ variantId: V_SEALED, available: Quantity.units(5) }],
      }),
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("INSUFFICIENT_STOCK");
  });

  it("informa juntos los faltantes de todas las variantes, en el orden del pedido", () => {
    const result = planSaleConsumption({
      lines: [
        line({ lineId: "line-1", variantId: V_CASE }),
        line({ lineId: "line-2", variantId: V_WATCH }),
        line({ lineId: "line-3", variantId: V_SEALED }),
      ],
      lots: [],
      availability: [
        { variantId: V_CASE, available: Quantity.units(0) },
        { variantId: V_WATCH, available: Quantity.units(0) },
        { variantId: V_SEALED, available: Quantity.units(0) },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.error.code !== "INSUFFICIENT_STOCK") return;
    expect(result.error.shortages.map((shortage) => shortage.variantId)).toEqual([
      V_CASE,
      V_WATCH,
      V_SEALED,
    ]);
  });

  it("el disponible alcanza pero los lotes consumibles no (el saldo está en un lote en cuarentena): INSUFFICIENT_STOCK de la línea", () => {
    const result = planSaleConsumption(
      input({
        lines: [line({ qty: Quantity.units(3) })],
        lots: [
          lot({ id: "lot-1", available: Quantity.units(2) }),
          lot({ id: "lot-q", status: "quarantine", available: Quantity.units(9) }),
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok || result.error.code !== "INSUFFICIENT_STOCK") return;
    expect(result.error.shortages).toHaveLength(1);
    expect(result.error.shortages[0]!.available.value).toBe(2);
  });

  it("una variante sin disponible informado es un bug de quien arma la entrada: lanza", () => {
    expect(() => planSaleConsumption(input({ availability: [] }))).toThrow(
      InvalidAllocationRequestError,
    );
  });
});

describe("RN-LOT-05 · una política que pide elegir el lote no se resuelve sola", () => {
  it.each(["manual", "serial"] as const)(
    "una línea común con política %s se rechaza con ALLOCATION_NEEDS_LOT_CHOICE",
    (policy) => {
      const result = planSaleConsumption(input({ lines: [line({ policy })] }));

      expect(result).toEqual({
        ok: false,
        error: { code: "ALLOCATION_NEEDS_LOT_CHOICE", lineId: "line-1", policy },
      });
    },
  );

  it("una línea sin cantidad positiva es un bug de quien arma la entrada: lanza", () => {
    expect(() => planSaleConsumption(input({ lines: [line({ qty: Quantity.units(0) })] }))).toThrow(
      InvalidAllocationRequestError,
    );
  });
});
