import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Money } from "../shared/money.js";
import { Quantity } from "../shared/quantity.js";
import { allocateFreight, type FreightLine } from "./freight.js";

/** Proyecta el mapa id → Money del resultado a id → minor, para comparar contra literales. */
function minorsOf(map: ReadonlyMap<string, Money>): Record<string, bigint> {
  return Object.fromEntries([...map].map(([id, money]) => [id, money.minor]));
}

describe("RN-COS-02 · by_value — reparte en proporción al valor de línea", () => {
  it("Gs. 300.000 sobre líneas de 1.000.000 / 500.000 / 200.000 da 176.471 / 88.235 / 35.294, y suma exacto", () => {
    const lines: readonly FreightLine[] = [
      { id: "A", value: Money.pyg(1_000_000n), qty: Quantity.units(1) },
      { id: "B", value: Money.pyg(500_000n), qty: Quantity.units(1) },
      { id: "C", value: Money.pyg(200_000n), qty: Quantity.units(1) },
    ];

    const result = allocateFreight({ freight: Money.pyg(300_000n), method: "by_value", lines });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(minorsOf(result.value)).toEqual({ A: 176_471n, B: 88_235n, C: 35_294n });
  });

  it("tres líneas de igual valor (proporción periódica 1/3): reparte 100 en 34 / 33 / 33, sin perder unidades", () => {
    // 100/3 = 33,333... — una proporción que no termina, resuelta con el
    // peso crudo (1, 1, 1), no con 0,3333333 (que Money.allocate rechazaría
    // por tener más de 6 decimales). Desempate por índice ascendente: la
    // primera línea recibe la unidad sobrante.
    const lines: readonly FreightLine[] = [
      { id: "A", value: Money.pyg(1n), qty: Quantity.units(1) },
      { id: "B", value: Money.pyg(1n), qty: Quantity.units(1) },
      { id: "C", value: Money.pyg(1n), qty: Quantity.units(1) },
    ];

    const result = allocateFreight({ freight: Money.pyg(100n), method: "by_value", lines });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(minorsOf(result.value)).toEqual({ A: 34n, B: 33n, C: 33n });
  });

  it("con todas las líneas en cero, falla con ZERO_TOTAL_WEIGHT en vez de repartir arbitrariamente", () => {
    const lines: readonly FreightLine[] = [
      { id: "A", value: Money.pyg(0n), qty: Quantity.units(1) },
      { id: "B", value: Money.pyg(0n), qty: Quantity.units(1) },
    ];

    const result = allocateFreight({ freight: Money.pyg(10_000n), method: "by_value", lines });

    expect(result).toEqual({ ok: false, error: { code: "ZERO_TOTAL_WEIGHT" } });
  });

  it("falla con LINE_CURRENCY_MISMATCH si las líneas no comparten moneda en value (RN-DIN-03)", () => {
    const lines: readonly FreightLine[] = [
      { id: "A", value: Money.pyg(1_000_000n), qty: Quantity.units(1) },
      { id: "B", value: Money.of(100_000n, "USD"), qty: Quantity.units(1) },
    ];

    const result = allocateFreight({ freight: Money.pyg(300_000n), method: "by_value", lines });

    expect(result).toEqual({
      ok: false,
      error: { code: "LINE_CURRENCY_MISMATCH", lineId: "B", expected: "PYG", actual: "USD" },
    });
  });
});

describe("RN-COS-02 · by_unit — reparte en proporción a la cantidad de línea, no al valor", () => {
  it("usa qty como peso: dos líneas de igual valor pero cantidades 1 y 3 reparten 40 en 10 / 30", () => {
    const lines: readonly FreightLine[] = [
      { id: "A", value: Money.pyg(500_000n), qty: Quantity.units(1) },
      { id: "B", value: Money.pyg(500_000n), qty: Quantity.units(3) },
    ];

    const result = allocateFreight({ freight: Money.pyg(40n), method: "by_unit", lines });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(minorsOf(result.value)).toEqual({ A: 10n, B: 30n });
  });

  it("falla con LINE_UOM_MISMATCH si las líneas no comparten Uom en qty (ADR-009)", () => {
    const lines: readonly FreightLine[] = [
      { id: "A", value: Money.pyg(500_000n), qty: Quantity.units(1) },
      { id: "B", value: Money.pyg(500_000n), qty: Quantity.ml(3) },
    ];

    const result = allocateFreight({ freight: Money.pyg(40n), method: "by_unit", lines });

    expect(result).toEqual({
      ok: false,
      error: { code: "LINE_UOM_MISMATCH", lineId: "B", expected: "unit", actual: "ml" },
    });
  });
});

describe("RN-COS-02 · by_volume — reparte en proporción al volumen de línea", () => {
  it("usa volume como peso: dos líneas de igual valor y cantidad pero volúmenes 25 y 15 reparten 40 en 25 / 15", () => {
    const lines: readonly FreightLine[] = [
      { id: "A", value: Money.pyg(500_000n), qty: Quantity.units(1), volume: 25 },
      { id: "B", value: Money.pyg(500_000n), qty: Quantity.units(1), volume: 15 },
    ];

    const result = allocateFreight({ freight: Money.pyg(40n), method: "by_volume", lines });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(minorsOf(result.value)).toEqual({ A: 25n, B: 15n });
  });

  it("falla con MISSING_VOLUME si a alguna línea le falta el volumen", () => {
    const lines: readonly FreightLine[] = [
      { id: "A", value: Money.pyg(500_000n), qty: Quantity.units(1), volume: 25 },
      { id: "B", value: Money.pyg(500_000n), qty: Quantity.units(1) },
    ];

    const result = allocateFreight({ freight: Money.pyg(40n), method: "by_volume", lines });

    expect(result).toEqual({ ok: false, error: { code: "MISSING_VOLUME", lineId: "B" } });
  });
});

describe("RN-COS-02 · manual — no prorratea, solo valida la suma", () => {
  it("con montos que suman el flete total, los devuelve tal cual, sin ajustar nada", () => {
    const lines: readonly FreightLine[] = [
      {
        id: "A",
        value: Money.pyg(500_000n),
        qty: Quantity.units(1),
        manualAmount: Money.pyg(120_000n),
      },
      {
        id: "B",
        value: Money.pyg(500_000n),
        qty: Quantity.units(1),
        manualAmount: Money.pyg(180_000n),
      },
    ];

    const result = allocateFreight({ freight: Money.pyg(300_000n), method: "manual", lines });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(minorsOf(result.value)).toEqual({ A: 120_000n, B: 180_000n });
  });

  it("falla con MANUAL_SUM_MISMATCH si los montos manuales no suman el flete total", () => {
    const lines: readonly FreightLine[] = [
      {
        id: "A",
        value: Money.pyg(500_000n),
        qty: Quantity.units(1),
        manualAmount: Money.pyg(120_000n),
      },
      {
        id: "B",
        value: Money.pyg(500_000n),
        qty: Quantity.units(1),
        manualAmount: Money.pyg(170_000n),
      },
    ];

    const result = allocateFreight({ freight: Money.pyg(300_000n), method: "manual", lines });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "MANUAL_SUM_MISMATCH",
        expected: Money.pyg(300_000n),
        actual: Money.pyg(290_000n),
      },
    });
  });

  it("falla con MISSING_MANUAL_AMOUNT si a alguna línea le falta manualAmount", () => {
    const lines: readonly FreightLine[] = [
      {
        id: "A",
        value: Money.pyg(500_000n),
        qty: Quantity.units(1),
        manualAmount: Money.pyg(300_000n),
      },
      { id: "B", value: Money.pyg(500_000n), qty: Quantity.units(1) },
    ];

    const result = allocateFreight({ freight: Money.pyg(300_000n), method: "manual", lines });

    expect(result).toEqual({ ok: false, error: { code: "MISSING_MANUAL_AMOUNT", lineId: "B" } });
  });

  it("no le aplica ningún desempate propio: dos líneas empatadas que no suman el total fallan igual", () => {
    const lines: readonly FreightLine[] = [
      {
        id: "A",
        value: Money.pyg(500_000n),
        qty: Quantity.units(1),
        manualAmount: Money.pyg(150_000n),
      },
      {
        id: "B",
        value: Money.pyg(500_000n),
        qty: Quantity.units(1),
        manualAmount: Money.pyg(150_000n),
      },
    ];

    const result = allocateFreight({ freight: Money.pyg(300_001n), method: "manual", lines });

    expect(result.ok).toBe(false);
  });
});

describe("allocateFreight — casos comunes a todos los métodos", () => {
  it("falla con EMPTY_LINES si no hay líneas", () => {
    const result = allocateFreight({ freight: Money.pyg(300_000n), method: "by_value", lines: [] });

    expect(result).toEqual({ ok: false, error: { code: "EMPTY_LINES" } });
  });
});

describe("docs/testing-strategy.md §2.4 · el prorrateo nunca pierde ni gana unidades", () => {
  it("by_value: la suma de las partes es siempre exactamente el flete total", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 20 }),
        (freightMinor, values) => {
          const lines: readonly FreightLine[] = values.map((value, index) => ({
            id: `line-${index}`,
            value: Money.pyg(BigInt(value)),
            qty: Quantity.units(1),
          }));

          const result = allocateFreight({
            freight: Money.pyg(freightMinor),
            method: "by_value",
            lines,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) throw new Error("expected ok");

          const sum = [...result.value.values()].reduce((a, b) => a.plus(b), Money.pyg(0n));
          expect(sum.minor).toBe(freightMinor);
        },
      ),
    );
  });
});
