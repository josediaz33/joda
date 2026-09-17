import { describe, expect, it } from "vitest";
import { Money } from "../shared/money.js";
import { Quantity } from "../shared/quantity.js";
import { selectLotsByPolicy, type LotSnapshot } from "./allocation.js";

/** Constructor con valores por defecto razonables; sobrescribir solo lo relevante de cada test. */
function lot(overrides: Partial<LotSnapshot> & { id: string }): LotSnapshot {
  return {
    receivedAt: new Date("2026-01-01T00:00:00Z"),
    expiryAt: null,
    available: Quantity.units(1),
    unitCost: Money.pyg(1_000n),
    status: "available",
    variantType: "unit",
    uom: "unit",
    ...overrides,
  };
}

function idsOf(lots: readonly LotSnapshot[]): string[] {
  return lots.map((l) => l.id);
}

describe("RN-LOT-05 · fifo — menor receivedAt primero", () => {
  it("ordena L-002 (más nuevo) después de L-001 (más antiguo), sin importar el orden de entrada", () => {
    const lots = [
      lot({ id: "L-002", receivedAt: new Date("2026-02-01T00:00:00Z") }),
      lot({ id: "L-001", receivedAt: new Date("2026-01-01T00:00:00Z") }),
    ];

    expect(idsOf(selectLotsByPolicy(lots, "fifo"))).toEqual(["L-001", "L-002"]);
  });

  it("con receivedAt empatado, desempata por id ascendente", () => {
    const sameDate = new Date("2026-01-01T00:00:00Z");
    const lots = [
      lot({ id: "L-002", receivedAt: sameDate }),
      lot({ id: "L-001", receivedAt: sameDate }),
    ];

    expect(idsOf(selectLotsByPolicy(lots, "fifo"))).toEqual(["L-001", "L-002"]);
  });

  it("excluye lotes sin saldo disponible y lotes que no están en estado available", () => {
    const lots = [
      lot({ id: "L-001", available: Quantity.units(0) }),
      lot({ id: "L-002", status: "quarantine" }),
      lot({ id: "L-003", status: "damaged" }),
      lot({ id: "L-004" }),
    ];

    expect(idsOf(selectLotsByPolicy(lots, "fifo"))).toEqual(["L-004"]);
  });
});

describe("RN-LOT-05 · fefo — menor expiryAt primero; sin vencimiento va al final", () => {
  it("ordena por expiryAt ascendente", () => {
    const lots = [
      lot({ id: "L-B", expiryAt: new Date("2026-06-01T00:00:00Z") }),
      lot({ id: "L-A", expiryAt: new Date("2026-03-01T00:00:00Z") }),
    ];

    expect(idsOf(selectLotsByPolicy(lots, "fefo"))).toEqual(["L-A", "L-B"]);
  });

  it("un lote sin vencimiento (null) va al final, no al principio, aunque tenga el id más chico", () => {
    const lots = [
      lot({ id: "L-A", expiryAt: null }),
      lot({ id: "L-B", expiryAt: new Date("2026-03-01T00:00:00Z") }),
    ];

    expect(idsOf(selectLotsByPolicy(lots, "fefo"))).toEqual(["L-B", "L-A"]);
  });

  it("con expiryAt empatado, desempata por id ascendente", () => {
    const sameExpiry = new Date("2026-03-01T00:00:00Z");
    const lots = [
      lot({ id: "L-B", expiryAt: sameExpiry }),
      lot({ id: "L-A", expiryAt: sameExpiry }),
    ];

    expect(idsOf(selectLotsByPolicy(lots, "fefo"))).toEqual(["L-A", "L-B"]);
  });

  it("con dos lotes sin vencimiento, el empate entre ellos también se desempata por id ascendente", () => {
    const lots = [lot({ id: "L-B", expiryAt: null }), lot({ id: "L-A", expiryAt: null })];

    expect(idsOf(selectLotsByPolicy(lots, "fefo"))).toEqual(["L-A", "L-B"]);
  });
});

describe("RN-LOT-05 · serial — la unidad serializada ya viene elegida por fuera", () => {
  it("con un único lote candidato, lo devuelve tal cual", () => {
    const lots = [lot({ id: "L-001" })];

    expect(idsOf(selectLotsByPolicy(lots, "serial"))).toEqual(["L-001"]);
  });

  it("sin criterio temporal propio, cae al desempate universal: id ascendente", () => {
    const lots = [lot({ id: "L-002" }), lot({ id: "L-001" })];

    expect(idsOf(selectLotsByPolicy(lots, "serial"))).toEqual(["L-001", "L-002"]);
  });
});

describe("RN-LOT-05 · manual — el operador elige el lote", () => {
  it("con un único lote candidato, lo devuelve tal cual", () => {
    const lots = [lot({ id: "L-001" })];

    expect(idsOf(selectLotsByPolicy(lots, "manual"))).toEqual(["L-001"]);
  });

  it("sin criterio temporal propio, cae al desempate universal: id ascendente", () => {
    const lots = [lot({ id: "L-002" }), lot({ id: "L-001" })];

    expect(idsOf(selectLotsByPolicy(lots, "manual"))).toEqual(["L-001", "L-002"]);
  });
});

describe("RN-LOT-05 · desempate por id ascendente — caso límite del propio desempate", () => {
  it("dos lotes con el mismo id no rompen el orden: ninguno se considera menor que el otro", () => {
    const lots = [lot({ id: "L-001" }), lot({ id: "L-001" })];

    expect(idsOf(selectLotsByPolicy(lots, "serial"))).toEqual(["L-001", "L-001"]);
  });

  it("con los lotes ya en orden ascendente de id, el resultado no cambia", () => {
    const lots = [lot({ id: "L-001" }), lot({ id: "L-002" })];

    expect(idsOf(selectLotsByPolicy(lots, "serial"))).toEqual(["L-001", "L-002"]);
  });
});
