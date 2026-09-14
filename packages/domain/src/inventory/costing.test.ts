import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CurrencyMismatchError, InvalidAllocationRequestError } from "../shared/errors.js";
import { Money } from "../shared/money.js";
import { Quantity } from "../shared/quantity.js";
import type { AllocationPolicy, LotSnapshot } from "./allocation.js";
import { allocateFromLots, totalCost, type CostLayer } from "./costing.js";

/** Constructor con valores por defecto razonables; sobrescribir solo lo relevante de cada test. */
function lot(overrides: Partial<LotSnapshot> & { id: string }): LotSnapshot {
  return {
    receivedAt: new Date("2026-01-01T00:00:00Z"),
    expiryAt: null,
    available: Quantity.units(1),
    unitCost: Money.pyg(1_000n),
    status: "available",
    ...overrides,
  };
}

describe("RN-COS-04 · fifo — consume por capas, nunca por promedio", () => {
  it("venta de 3 unidades con L-001 (2 a 1.400.000) y L-002 (5 a 1.550.000) da dos capas, 4.350.000 en total", () => {
    const lots = [
      lot({
        id: "L-001",
        receivedAt: new Date("2026-01-01T00:00:00Z"),
        available: Quantity.units(2),
        unitCost: Money.pyg(1_400_000n),
      }),
      lot({
        id: "L-002",
        receivedAt: new Date("2026-02-01T00:00:00Z"),
        available: Quantity.units(5),
        unitCost: Money.pyg(1_550_000n),
      }),
    ];

    const result = allocateFromLots({ lots, required: Quantity.units(3), policy: "fifo" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toEqual([
      {
        lotId: "L-001",
        qty: Quantity.units(2),
        unitCost: Money.pyg(1_400_000n),
        totalCost: Money.pyg(2_800_000n),
      },
      {
        lotId: "L-002",
        qty: Quantity.units(1),
        unitCost: Money.pyg(1_550_000n),
        totalCost: Money.pyg(1_550_000n),
      },
    ]);
    expect(totalCost(result.value).minor).toBe(4_350_000n);
  });
});

describe("RN-LOT-05, RN-COS-04 · fefo — el orden devuelto es lot id ascendente, no el orden de consumo", () => {
  it("consume primero del que vence antes (L-999), pero devuelve las capas ordenadas por id (L-001 antes que L-999)", () => {
    const lots = [
      lot({
        id: "L-999",
        expiryAt: new Date("2026-03-01T00:00:00Z"),
        available: Quantity.units(2),
        unitCost: Money.pyg(100_000n),
      }),
      lot({
        id: "L-001",
        expiryAt: new Date("2026-06-01T00:00:00Z"),
        available: Quantity.units(5),
        unitCost: Money.pyg(200_000n),
      }),
    ];

    const result = allocateFromLots({ lots, required: Quantity.units(3), policy: "fefo" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // Consumo real: 2 de L-999 (vence antes) + 1 de L-001. Orden devuelto:
    // por id ascendente — RN-LOT-05, "el orden de bloqueo siempre es
    // lot_id ascendente", independiente de qué política decidió las
    // cantidades.
    expect(result.value.map((layer) => layer.lotId)).toEqual(["L-001", "L-999"]);
    expect(result.value).toEqual([
      {
        lotId: "L-001",
        qty: Quantity.units(1),
        unitCost: Money.pyg(200_000n),
        totalCost: Money.pyg(200_000n),
      },
      {
        lotId: "L-999",
        qty: Quantity.units(2),
        unitCost: Money.pyg(100_000n),
        totalCost: Money.pyg(200_000n),
      },
    ]);
  });
});

describe("RN-LOT-05 · serial — mueve exactamente la unidad serializada", () => {
  it("un único lote candidato cubre exactamente 1 unidad, en una sola capa", () => {
    const lots = [
      lot({ id: "L-500", available: Quantity.units(1), unitCost: Money.pyg(3_200_000n) }),
    ];

    const result = allocateFromLots({ lots, required: Quantity.units(1), policy: "serial" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toEqual([
      {
        lotId: "L-500",
        qty: Quantity.units(1),
        unitCost: Money.pyg(3_200_000n),
        totalCost: Money.pyg(3_200_000n),
      },
    ]);
  });
});

describe("RN-LOT-05 · manual — consume del lote que el operador eligió", () => {
  it("consume parcialmente el único lote que el llamador pasó como elegido", () => {
    const lots = [lot({ id: "L-777", available: Quantity.ml(50), unitCost: Money.pyg(12_000n) })];

    const result = allocateFromLots({ lots, required: Quantity.ml(10), policy: "manual" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toEqual([
      {
        lotId: "L-777",
        qty: Quantity.ml(10),
        unitCost: Money.pyg(12_000n),
        totalCost: Money.pyg(120_000n),
      },
    ]);
  });
});

describe("RN-COS-04 · deja de consumir apenas cubre lo requerido", () => {
  it("no toca el lote siguiente una vez que el anterior ya cubrió la cantidad exacta", () => {
    const lots = [
      lot({
        id: "L-001",
        receivedAt: new Date("2026-01-01T00:00:00Z"),
        available: Quantity.units(2),
      }),
      lot({
        id: "L-002",
        receivedAt: new Date("2026-02-01T00:00:00Z"),
        available: Quantity.units(5),
      }),
    ];

    const result = allocateFromLots({ lots, required: Quantity.units(2), policy: "fifo" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.map((layer) => layer.lotId)).toEqual(["L-001"]);
  });
});

describe("RN-COS-04 · dos lotes con el mismo id (dato inconsistente) no rompen el ordenamiento final", () => {
  it("las capas resultantes no se pierden ni lanzan al ordenar por lotId", () => {
    const lots = [
      lot({ id: "L-001", available: Quantity.units(1) }),
      lot({ id: "L-001", available: Quantity.units(1) }),
    ];

    const result = allocateFromLots({ lots, required: Quantity.units(2), policy: "serial" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toHaveLength(2);
    expect(result.value.every((layer) => layer.lotId === "L-001")).toBe(true);
  });
});

describe("RN-COS-04 · stock insuficiente", () => {
  it("falla con INSUFFICIENT_STOCK cuando el saldo elegible no alcanza, sin consumir nada", () => {
    const lots = [lot({ id: "L-001", available: Quantity.units(2) })];

    const result = allocateFromLots({ lots, required: Quantity.units(5), policy: "fifo" });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "INSUFFICIENT_STOCK",
        required: Quantity.units(5),
        available: Quantity.units(2),
      },
    });
  });

  it("un lote en quarantine no cuenta como disponible para completar el pedido", () => {
    const lots = [
      lot({ id: "L-001", available: Quantity.units(2) }),
      lot({ id: "L-002", available: Quantity.units(10), status: "quarantine" }),
    ];

    const result = allocateFromLots({ lots, required: Quantity.units(5), policy: "fifo" });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "INSUFFICIENT_STOCK",
        required: Quantity.units(5),
        available: Quantity.units(2),
      },
    });
  });
});

describe("RN-COS-04 · required negativo es un bug del llamador, no un fallo de negocio", () => {
  it("lanza InvalidAllocationRequestError en vez de devolver un Result", () => {
    const lots = [lot({ id: "L-001" })];

    expect(() => allocateFromLots({ lots, required: Quantity.units(-1), policy: "fifo" })).toThrow(
      InvalidAllocationRequestError,
    );
  });
});

describe("RN-COS-05 · totalCost suma las capas", () => {
  it("suma el totalCost de cada capa", () => {
    const layers: CostLayer[] = [
      {
        lotId: "L-001",
        qty: Quantity.units(2),
        unitCost: Money.pyg(1_400_000n),
        totalCost: Money.pyg(2_800_000n),
      },
      {
        lotId: "L-002",
        qty: Quantity.units(1),
        unitCost: Money.pyg(1_550_000n),
        totalCost: Money.pyg(1_550_000n),
      },
    ];

    expect(totalCost(layers).minor).toBe(4_350_000n);
  });

  it("sin capas, da cero en PYG — no hay ninguna capa de la que derivar moneda", () => {
    expect(totalCost([])).toEqual(Money.pyg(0n));
  });
});

describe("RN-COS-05 · totalCost deriva la moneda de la primera capa, no un PYG fijo", () => {
  it("con capas en USD, devuelve el total en USD, no lo fuerza a PYG", () => {
    const layers: CostLayer[] = [
      {
        lotId: "L-001",
        qty: Quantity.units(2),
        unitCost: Money.of(50_00n, "USD"),
        totalCost: Money.of(100_00n, "USD"),
      },
      {
        lotId: "L-002",
        qty: Quantity.units(1),
        unitCost: Money.of(30_00n, "USD"),
        totalCost: Money.of(30_00n, "USD"),
      },
    ];

    expect(totalCost(layers)).toEqual(Money.of(130_00n, "USD"));
  });

  it("falla con CurrencyMismatchError si las capas no comparten moneda entre sí, antes de sumar nada", () => {
    const layers: CostLayer[] = [
      {
        lotId: "L-001",
        qty: Quantity.units(1),
        unitCost: Money.pyg(1_000n),
        totalCost: Money.pyg(1_000n),
      },
      {
        lotId: "L-002",
        qty: Quantity.units(1),
        unitCost: Money.of(100n, "USD"),
        totalCost: Money.of(100n, "USD"),
      },
    ];

    expect(() => totalCost(layers)).toThrow(CurrencyMismatchError);
  });
});

describe("RN-COS-05, docs/testing-strategy.md §2.4 · las capas nunca pierden ni ganan cantidad ni costo", () => {
  it("con stock suficiente, la suma de qty de las capas es exactamente required y totalCost() suma exacto el costo de cada capa, en las cuatro políticas", () => {
    const policies: readonly AllocationPolicy[] = ["fifo", "fefo", "serial", "manual"];

    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            available: fc.integer({ min: 1, max: 1_000 }),
            unitCostMinor: fc.bigInt({ min: 0n, max: 10_000_000n }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        fc.integer({ min: 0, max: 100_000 }),
        (lotSpecs, requiredRaw) => {
          const totalAvailable = lotSpecs.reduce((sum, spec) => sum + spec.available, 0);
          // Clamp adentro de la property, no en el arbitrary: así todo
          // valor generado para requiredRaw es válido, y required siempre
          // cae en stock suficiente ([0, totalAvailable]) sin descartar
          // ninguna corrida (fc.pre habría desperdiciado casos).
          const required = Math.min(requiredRaw, totalAvailable);

          const lots: LotSnapshot[] = lotSpecs.map((spec, index) =>
            lot({
              id: `L-${index}`,
              receivedAt: new Date(2026, 0, index + 1),
              available: Quantity.units(spec.available),
              unitCost: Money.pyg(spec.unitCostMinor),
            }),
          );

          for (const policy of policies) {
            const result = allocateFromLots({ lots, required: Quantity.units(required), policy });

            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error("expected ok");

            const qtySum = result.value.reduce((sum, layer) => sum + layer.qty.value, 0);
            expect(qtySum).toBe(required);

            const totalCostSum = result.value.reduce(
              (sum, layer) => sum + layer.totalCost.minor,
              0n,
            );
            expect(totalCost(result.value).minor).toBe(totalCostSum);
          }
        },
      ),
    );
  });
});
