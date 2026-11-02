import { describe, expect, it } from "vitest";
import { InvalidReservationInputError } from "../shared/errors.js";
import { Quantity } from "../shared/quantity.js";
import {
  planOrderReservations,
  type OrderReservationLine,
  type PlanOrderReservationsInput,
  type SerialUnitSnapshot,
  type VariantAvailability,
} from "./orderReservation.js";

// 2026-01-01T00:00:00.000Z; +24 h = 1_767_312_000_000 (literal, como en reservation.test.ts).
const STARTED_AT = new Date("2026-01-01T00:00:00.000Z");
const EXPIRES_24H = 1_767_312_000_000;

const V_SEALED = "variant-a-sealed";
const V_WATCH = "variant-b-watch";
const V_CASE = "variant-c-case";

function line(overrides: Partial<OrderReservationLine> = {}): OrderReservationLine {
  return {
    lineId: "line-1",
    variantId: V_SEALED,
    qty: Quantity.units(1),
    serialUnitId: null,
    ...overrides,
  };
}

function stock(variantId: string, available: number): VariantAvailability {
  return { variantId, available: Quantity.units(available) };
}

function unit(overrides: Partial<SerialUnitSnapshot> = {}): SerialUnitSnapshot {
  return {
    id: "unit-1",
    variantId: V_WATCH,
    status: "available",
    reservedByOther: false,
    ...overrides,
  };
}

function input(overrides: Partial<PlanOrderReservationsInput> = {}): PlanOrderReservationsInput {
  return {
    lines: [line()],
    availability: [stock(V_SEALED, 5)],
    serialUnits: [],
    startedAt: STARTED_AT,
    ttlHours: 24,
    ...overrides,
  };
}

describe("RN-RES-03, RN-RES-06 · reservar un pedido contra el disponible de cada variante", () => {
  it("una línea común reserva por variante, sin lote ni unidad, con el TTL del tenant", () => {
    const result = planOrderReservations(input({ lines: [line({ qty: Quantity.units(2) })] }));

    expect(result).toEqual({
      ok: true,
      value: [
        {
          lineId: "line-1",
          variantId: V_SEALED,
          serialUnitId: null,
          qty: Quantity.units(2),
          reason: "order_pending_payment",
          expiresAtMs: EXPIRES_24H,
        },
      ],
    });
  });

  it("pedir exactamente el disponible se acepta: el último frasco también se reserva", () => {
    const result = planOrderReservations(
      input({ lines: [line({ qty: Quantity.units(5) })], availability: [stock(V_SEALED, 5)] }),
    );

    expect(result.ok).toBe(true);
  });

  it("pedir más que el disponible se rechaza con INSUFFICIENT_STOCK y dice cuánto pidió y cuánto hay", () => {
    const result = planOrderReservations(
      input({ lines: [line({ qty: Quantity.units(6) })], availability: [stock(V_SEALED, 5)] }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "INSUFFICIENT_STOCK",
        shortages: [
          { variantId: V_SEALED, requested: Quantity.units(6), available: Quantity.units(5) },
        ],
      },
    });
  });

  it("varias líneas de la misma variante se SUMAN: dos de 3 no caben en 5 aunque cada una sola sí", () => {
    const result = planOrderReservations(
      input({
        lines: [
          line({ lineId: "line-1", qty: Quantity.units(3) }),
          line({ lineId: "line-2", qty: Quantity.units(3) }),
        ],
        availability: [stock(V_SEALED, 5)],
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "INSUFFICIENT_STOCK",
        shortages: [
          { variantId: V_SEALED, requested: Quantity.units(6), available: Quantity.units(5) },
        ],
      },
    });
  });

  it("una variante sin disponible (cero) rechaza, y los faltantes de todas las variantes salen juntos y ordenados por id", () => {
    const result = planOrderReservations(
      input({
        lines: [
          line({ lineId: "line-1", variantId: V_CASE, qty: Quantity.units(1) }),
          line({ lineId: "line-2", variantId: V_SEALED, qty: Quantity.units(2) }),
          line({ lineId: "line-3", variantId: V_SEALED, qty: Quantity.units(1) }),
        ],
        availability: [stock(V_SEALED, 2), stock(V_CASE, 0)],
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "INSUFFICIENT_STOCK",
        shortages: [
          { variantId: V_SEALED, requested: Quantity.units(3), available: Quantity.units(2) },
          { variantId: V_CASE, requested: Quantity.units(1), available: Quantity.units(0) },
        ],
      },
    });
  });

  it("todo o nada: si una línea no cabe, el resultado no trae ninguna reserva de las que sí cabían", () => {
    const result = planOrderReservations(
      input({
        lines: [
          line({ lineId: "line-1", variantId: V_SEALED, qty: Quantity.units(1) }),
          line({ lineId: "line-2", variantId: V_CASE, qty: Quantity.units(9) }),
        ],
        availability: [stock(V_SEALED, 5), stock(V_CASE, 1)],
      }),
    );

    expect(result.ok).toBe(false);
  });

  it("cada línea es una reserva propia: dos líneas de la misma variante dan dos filas", () => {
    const result = planOrderReservations(
      input({
        lines: [
          line({ lineId: "line-1", qty: Quantity.units(1) }),
          line({ lineId: "line-2", qty: Quantity.units(2) }),
        ],
      }),
    );

    expect(result.ok && result.value.map((draft) => [draft.lineId, draft.qty.value])).toEqual([
      ["line-1", 1],
      ["line-2", 2],
    ]);
  });

  it("el vencimiento sale del TTL del tenant, no de una constante: 48 horas vencen a las 48 h", () => {
    const result = planOrderReservations(input({ ttlHours: 48 }));

    expect(result.ok && result.value[0]?.expiresAtMs).toBe(1_767_398_400_000);
  });
});

describe("RN-RES-06, RN-VTA-04 · un reloj serializado reserva su unidad", () => {
  const watchLine = line({
    lineId: "line-w",
    variantId: V_WATCH,
    serialUnitId: "unit-1",
    qty: Quantity.units(1),
  });

  it("reserva la unidad elegida, de a una, y la variante cuenta contra su disponible", () => {
    const result = planOrderReservations(
      input({
        lines: [watchLine],
        availability: [stock(V_WATCH, 1)],
        serialUnits: [unit()],
      }),
    );

    expect(result).toEqual({
      ok: true,
      value: [
        {
          lineId: "line-w",
          variantId: V_WATCH,
          serialUnitId: "unit-1",
          qty: Quantity.units(1),
          reason: "order_pending_payment",
          expiresAtMs: EXPIRES_24H,
        },
      ],
    });
  });

  it("una unidad vendida, en cuarentena o devuelta no se reserva: SERIAL_UNIT_UNAVAILABLE con su estado", () => {
    const result = planOrderReservations(
      input({
        lines: [watchLine],
        availability: [stock(V_WATCH, 1)],
        serialUnits: [unit({ status: "sold" })],
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "SERIAL_UNIT_UNAVAILABLE", serialUnitId: "unit-1", status: "sold" },
    });
  });

  it("una unidad con la reserva sin liberar de otro pedido se rechaza: dos borradores pueden elegir el mismo reloj", () => {
    const result = planOrderReservations(
      input({
        lines: [watchLine],
        availability: [stock(V_WATCH, 1)],
        serialUnits: [unit({ reservedByOther: true })],
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "SERIAL_UNIT_ALREADY_RESERVED", serialUnitId: "unit-1" },
    });
  });

  it("las unidades se miran antes que el disponible: una vendida se informa aunque además no haya stock", () => {
    const result = planOrderReservations(
      input({
        lines: [watchLine],
        availability: [stock(V_WATCH, 0)],
        serialUnits: [unit({ status: "sold" })],
      }),
    );

    expect(result.ok === false && result.error.code).toBe("SERIAL_UNIT_UNAVAILABLE");
  });

  it("una unidad disponible pero sin saldo en la variante se rechaza por INSUFFICIENT_STOCK", () => {
    const result = planOrderReservations(
      input({
        lines: [watchLine],
        availability: [stock(V_WATCH, 0)],
        serialUnits: [unit()],
      }),
    );

    expect(result.ok === false && result.error.code).toBe("INSUFFICIENT_STOCK");
  });
});

describe("planOrderReservations · entradas incoherentes son un bug del llamador, no un fallo del negocio", () => {
  it("una línea con cantidad cero lanza InvalidReservationInputError", () => {
    expect(() =>
      planOrderReservations(input({ lines: [line({ qty: Quantity.units(0) })] })),
    ).toThrow(InvalidReservationInputError);
  });

  it("una variante sin disponible informado lanza InvalidReservationInputError", () => {
    expect(() => planOrderReservations(input({ availability: [] }))).toThrow(
      InvalidReservationInputError,
    );
  });

  it("una unidad que no se informó, que es de otra variante o con cantidad distinta de 1 lanza", () => {
    const watchLine = line({ variantId: V_WATCH, serialUnitId: "unit-1" });
    const base = { availability: [stock(V_WATCH, 1)] };

    expect(() =>
      planOrderReservations(input({ ...base, lines: [watchLine], serialUnits: [] })),
    ).toThrow(InvalidReservationInputError);
    expect(() =>
      planOrderReservations(
        input({ ...base, lines: [watchLine], serialUnits: [unit({ variantId: V_CASE })] }),
      ),
    ).toThrow(InvalidReservationInputError);
    expect(() =>
      planOrderReservations(
        input({
          ...base,
          lines: [{ ...watchLine, qty: Quantity.units(2) }],
          serialUnits: [unit()],
        }),
      ),
    ).toThrow(InvalidReservationInputError);
  });

  it("un TTL fuera de rango lanza antes de mirar nada", () => {
    expect(() => planOrderReservations(input({ ttlHours: 0 }))).toThrow(
      InvalidReservationInputError,
    );
  });
});
