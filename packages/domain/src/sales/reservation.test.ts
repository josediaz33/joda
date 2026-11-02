import { describe, expect, it } from "vitest";
import { InvalidReservationInputError } from "../shared/errors.js";
import {
  computeDecantHoldExpiresAt,
  computeManualHoldExpiresAt,
  computeOrderPendingPaymentExpiresAt,
  computeReservationExpiresAt,
  MANUAL_HOLD_MAX_DAYS,
  ORDER_PENDING_PAYMENT_DEFAULT_TTL_HOURS,
  RESERVATION_TTL_HOURS_MAX,
  RESERVATION_TTL_HOURS_MIN,
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

describe("RN-RES-02 · pedido en espera de pago sin medio registrado — configurable por tenant (WP-C18b)", () => {
  it("el valor por defecto es de 24 horas", () => {
    expect(ORDER_PENDING_PAYMENT_DEFAULT_TTL_HOURS).toBe(24);
  });

  it("con 24 horas vence en +24 h (epoch ms)", () => {
    expect(computeOrderPendingPaymentExpiresAt(STARTED_AT, 24)).toBe(1_767_312_000_000);
  });

  it("con 1 hora, el mínimo, vence en +1 h", () => {
    expect(computeOrderPendingPaymentExpiresAt(STARTED_AT, 1)).toBe(1_767_229_200_000);
  });

  it("con 720 horas, el máximo, vence en +30 días: el mismo tope que la retención manual", () => {
    expect(RESERVATION_TTL_HOURS_MIN).toBe(1);
    expect(RESERVATION_TTL_HOURS_MAX).toBe(720);
    expect(computeOrderPendingPaymentExpiresAt(STARTED_AT, 720)).toBe(1_769_817_600_000);
  });

  it.each([0, -1, 721, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "ttlHours %s es un bug de quien lo leyó (la base lo acota con un CHECK): lanza InvalidReservationInputError",
    (ttlHours) => {
      expect(() => computeOrderPendingPaymentExpiresAt(STARTED_AT, ttlHours)).toThrow(
        InvalidReservationInputError,
      );
    },
  );
});

describe("RN-FRA-01 · la reserva de un plan de decant dura hasta ejecutar o cancelar, con tope de 30 días", () => {
  it("vence a los 30 días de planificar (epoch ms)", () => {
    expect(computeDecantHoldExpiresAt(STARTED_AT)).toBe(1_769_817_600_000);
  });
});
