import { describe, expect, it } from "vitest";
import { InvalidReservationInputError } from "../shared/errors.js";
import {
  computeManualHoldExpiresAt,
  computeReservationExpiresAt,
  MANUAL_HOLD_MAX_DAYS,
} from "./reservation.js";

// 2026-01-01T00:00:00.000Z = 1767225600000 (verificado con Date.getTime(),
// no recalculado acá — el valor esperado se escribe literal, no con la
// misma fórmula que el código bajo prueba).
const STARTED_AT = new Date("2026-01-01T00:00:00.000Z");

describe("RN-RES-02 · TTL de reserva por medio de pago", () => {
  it.each([
    ["checkout_start", 1_767_226_500_000], // +15 min
    ["card_pending", 1_767_227_400_000], // +30 min
    ["bank_transfer", 1_767_398_400_000], // +48 h
  ] as const)("%s vence en %i (epoch ms)", (trigger, expectedExpiresAt) => {
    expect(computeReservationExpiresAt(STARTED_AT, trigger)).toBe(expectedExpiresAt);
  });
});

describe("RN-RES-02 · retención manual — tope de 30 días", () => {
  it("1 día da un vencimiento de +24h en epoch ms", () => {
    expect(computeManualHoldExpiresAt(STARTED_AT, 1)).toEqual({
      ok: true,
      value: 1_767_312_000_000,
    });
  });

  it(`el tope documentado es ${MANUAL_HOLD_MAX_DAYS} días`, () => {
    expect(MANUAL_HOLD_MAX_DAYS).toBe(30);
  });

  it("exactamente 30 días se acepta: el tope es inclusive", () => {
    expect(computeManualHoldExpiresAt(STARTED_AT, 30)).toEqual({
      ok: true,
      value: 1_769_817_600_000,
    });
  });

  it("31 días devuelve err() con MANUAL_HOLD_EXCEEDS_MAX, sin lanzar", () => {
    expect(computeManualHoldExpiresAt(STARTED_AT, 31)).toEqual({
      ok: false,
      error: { code: "MANUAL_HOLD_EXCEEDS_MAX", requestedDays: 31 },
    });
  });

  it("días cero o negativo es un bug del llamador: lanza InvalidReservationInputError", () => {
    expect(() => computeManualHoldExpiresAt(STARTED_AT, 0)).toThrow(InvalidReservationInputError);
    expect(() => computeManualHoldExpiresAt(STARTED_AT, -5)).toThrow(InvalidReservationInputError);
  });

  it("días no finito (NaN, Infinity) es un bug del llamador: lanza InvalidReservationInputError", () => {
    expect(() => computeManualHoldExpiresAt(STARTED_AT, Number.NaN)).toThrow(
      InvalidReservationInputError,
    );
    expect(() => computeManualHoldExpiresAt(STARTED_AT, Number.POSITIVE_INFINITY)).toThrow(
      InvalidReservationInputError,
    );
  });
});
