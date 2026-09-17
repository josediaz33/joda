// TTL de reserva por medio de pago (RN-RES-02; ADR-019; GLOSARIO.md
// "Reserva"). `stock_reservations` vive separada del ledger — esta función
// solo calcula CUÁNDO vence una reserva, nunca toca el saldo disponible
// (eso es `disponible = saldo − reservas`, RN-RES-03, que vive en
// `inventory/balance.ts` y queda fuera de WP-A09 — no está en su criterio
// de aceptación).
//
// La fila "seña recibida" de la tabla de RN-RES-02 (vence junto con la
// seña) NO tiene función acá: no es una duración fija que sumar a
// `startedAt`, es "usar el `expiresAt` de la seña tal cual" — quien
// orquesta (apps/api) copia `deposit.expiresAt` (sales/deposit.ts)
// directo a la reserva, sin pasar por este archivo.
//
// packages/domain no puede construir un `Date` nuevo (no-restricted-globals
// sobre el identificador `Date`, .claude/rules/domain.md): por eso el
// vencimiento se devuelve como epoch en milisegundos (`number`), no como
// `Date`. Quien orquesta arma el timestamp final a partir de ese número.
// `startedAt.getTime()` sí es válido: es un método sobre un `Date` que YA
// entró por parámetro, no una construcción nueva (mismo criterio que
// `inventory/allocation.ts` al comparar `receivedAt`/`expiryAt`). Catalogado
// como patrón en docs/engineering-principles.md Parte III, "Vencimiento
// futuro como epoch-ms, nunca como Date" — este archivo es el precedente.
//
// `ReservationTrigger` NO es el mismo vocabulario que
// `reservation_reason` (packages/db/migrations/0001_foundation.sql:
// `checkout | order_pending_payment | deposit_hold | decant_hold |
// manual_hold`), a propósito pero sin mapeo 1:1: acá hay un valor por cada
// FILA con TTL fijo de RN-RES-02 (uno por medio de pago), mientras que la
// base solo necesita distinguir el MOTIVO de la reserva para
// `stock_reservations.reason`. `card_pending` y `bank_transfer` — dos TTL
// distintos acá — colapsan los dos en el mismo `order_pending_payment` de
// la base; `checkout_start` es `checkout`; `manual_hold` (con su propia
// función acá) es `manual_hold` allá. `decant_hold` no tiene contraparte
// en este archivo: es la reserva de granel durante un fraccionamiento
// (decant/planning.ts), un motivo distinto de RN-RES-02. Quien escriba
// WP-C18 (orquestación de reservas) es quien traduce `ReservationTrigger`
// al `reason` de la fila — este archivo no necesita saberlo para calcular
// un TTL, pero vale dejarlo anotado antes de que alguien asuma que son el
// mismo enum.
import { InvalidReservationInputError } from "../shared/errors.js";
import { err, ok, type Result } from "../shared/result.js";

/**
 * Los tres medios con TTL fijo de RN-RES-02. "Seña recibida" y "retención
 * manual" no son un `ReservationTrigger`: la primera no es una duración
 * (ver arriba) y la segunda tiene su propia función, `computeManualHoldExpiresAt`,
 * porque su duración es un parámetro variable con tope, no una constante.
 */
export type ReservationTrigger = "checkout_start" | "card_pending" | "bank_transfer";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** RN-RES-02 · tabla literal — nunca un único TTL genérico para las tres. */
const RESERVATION_TTL_MS: Readonly<Record<ReservationTrigger, number>> = {
  checkout_start: 15 * MINUTE_MS,
  card_pending: 30 * MINUTE_MS,
  bank_transfer: 48 * HOUR_MS,
};

/** RN-RES-02 · vencimiento de una reserva de checkout, tarjeta o transferencia, como epoch ms. */
export function computeReservationExpiresAt(startedAt: Date, trigger: ReservationTrigger): number {
  return startedAt.getTime() + RESERVATION_TTL_MS[trigger];
}

/** RN-RES-02 · "retención manual del personal ... máximo 30 días". */
export const MANUAL_HOLD_MAX_DAYS = 30;

/**
 * Objeto plano con `code` — mismo criterio que `FreightError`
 * (procurement/freight.ts): esto se devuelve dentro de un `Result`, nadie
 * lo lanza.
 */
export type ManualHoldError = {
  readonly code: "MANUAL_HOLD_EXCEEDS_MAX";
  readonly requestedDays: number;
};

/**
 * RN-RES-02 · retención manual: el operador define la duración en días,
 * tope 30. Que el operador se pase de ese tope por error de tipeo es un
 * fallo que el negocio contempla (`Result`), no un bug del llamador — a
 * diferencia de `days` no positivo o no finito, que sí lo es (ningún flujo
 * legítimo pide una retención de "-3" o "NaN" días).
 */
export function computeManualHoldExpiresAt(
  startedAt: Date,
  days: number,
): Result<number, ManualHoldError> {
  if (!Number.isFinite(days) || days <= 0) {
    throw new InvalidReservationInputError(
      `computeManualHoldExpiresAt requiere days positivo y finito, recibido ${days}.`,
    );
  }

  if (days > MANUAL_HOLD_MAX_DAYS) {
    return err({ code: "MANUAL_HOLD_EXCEEDS_MAX", requestedDays: days });
  }

  return ok(startedAt.getTime() + days * DAY_MS);
}
