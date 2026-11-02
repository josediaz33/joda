// Reserva de un pedido que pasa a `awaiting_payment` (RF-VTA-04, RN-RES-03,
// RN-RES-06, ADR-019). `stock_reservations` vive separada del ledger: reservar
// no mueve el saldo, descuenta del DISPONIBLE (saldo − reservas vivas,
// `v_stock_available`). Esta función es pura: recibe el disponible y las
// unidades ya leídos, decide y devuelve las filas a insertar. Quien orquesta
// (apps/api) bloquea las variantes ANTES de leer (RN-RES-07), porque dos
// pedidos que leen el mismo disponible sin ese orden comprometen la misma
// unidad.
//
// Qué se reserva y qué no (RN-RES-06):
//   · una línea común reserva POR VARIANTE: `variantId` y la cantidad, sin lote
//     (qué lote sale lo decide la confirmación de la venta, RN-LOT-05);
//   · un reloj serializado reserva SU UNIDAD (`serialUnitId`), de a una (RN-VTA-04);
//   · un decant bajo pedido NO se reserva acá: no tiene saldo propio, y el
//     compromiso es reservar granel e insumos al planificar el fraccionamiento
//     (RN-FRA-01, `inventory.decant.plan`). Quien arma la entrada lo deja afuera.
import { InvalidReservationInputError } from "../shared/errors.js";
import type { Quantity } from "../shared/quantity.js";
import { err, ok, type Result } from "../shared/result.js";
import { computeOrderPendingPaymentExpiresAt } from "./reservation.js";

/** Una línea del pedido que reserva stock. */
export interface OrderReservationLine {
  readonly lineId: string;
  readonly variantId: string;
  /** En la unidad de la variante (RN-VTA-06): unidades enteras de un reloj o un sellado. */
  readonly qty: Quantity;
  /** La unidad elegida si la variante es serializada; `null` si no. */
  readonly serialUnitId: string | null;
}

/** Disponible de una variante DESPUÉS de las reservas vivas (RN-RES-03). Sin fila en la vista, cero. */
export interface VariantAvailability {
  readonly variantId: string;
  readonly available: Quantity;
}

/** Lo que hace falta saber de una unidad serializada elegida por una línea. */
export interface SerialUnitSnapshot {
  readonly id: string;
  readonly variantId: string;
  /** `serialized_units.status`: solo una `available` se reserva. */
  readonly status: string;
  /** Tiene una reserva sin liberar de OTRO pedido (el índice único de 0041 la rechazaría igual). */
  readonly reservedByOther: boolean;
}

export interface PlanOrderReservationsInput {
  readonly lines: readonly OrderReservationLine[];
  readonly availability: readonly VariantAvailability[];
  readonly serialUnits: readonly SerialUnitSnapshot[];
  readonly startedAt: Date;
  /** `tenants.reservation_ttl_hours` (RN-RES-02: el pedido en espera de pago sin medio registrado). */
  readonly ttlHours: number;
}

export interface OrderReservationShortage {
  readonly variantId: string;
  readonly requested: Quantity;
  readonly available: Quantity;
}

export type OrderReservationError =
  | {
      readonly code: "SERIAL_UNIT_UNAVAILABLE";
      readonly serialUnitId: string;
      readonly status: string;
    }
  | { readonly code: "SERIAL_UNIT_ALREADY_RESERVED"; readonly serialUnitId: string }
  | {
      readonly code: "INSUFFICIENT_STOCK";
      readonly shortages: readonly OrderReservationShortage[];
    };

/** Una fila de `stock_reservations` lista para insertar, atada a la línea que la origina. */
export interface OrderReservationDraft {
  readonly lineId: string;
  readonly variantId: string;
  readonly serialUnitId: string | null;
  readonly qty: Quantity;
  readonly reason: "order_pending_payment";
  /** Epoch ms (packages/domain no construye `Date`): quien orquesta arma el timestamp. */
  readonly expiresAtMs: number;
}

/**
 * RN-RES-03, RN-RES-06 · decide si el pedido puede reservar todo lo que pide y
 * arma las reservas, una por línea. Todo o nada: ante cualquier rechazo no se
 * reserva nada (el llamador revierte la transacción).
 *
 * Primero se miran las unidades serializadas (una `sold`, en cuarentena o ya
 * reservada por otro pedido no se promete a dos clientes), después el
 * disponible por variante, SUMANDO todas las líneas de la misma variante: dos
 * líneas de 3 contra un disponible de 5 no caben, aunque cada una por separado
 * sí. Los faltantes se informan juntos, ordenados por variante, para que quien
 * vende corrija el pedido de una vez.
 *
 * Una línea sin cantidad positiva, una unidad que no es de la variante de la
 * línea (o cuya cantidad no es 1) o una variante sin disponible informado son
 * bugs de quien arma la entrada, no fallos del negocio: lanza.
 */
export function planOrderReservations(
  input: PlanOrderReservationsInput,
): Result<readonly OrderReservationDraft[], OrderReservationError> {
  const expiresAtMs = computeOrderPendingPaymentExpiresAt(input.startedAt, input.ttlHours);
  const availabilityByVariant = new Map(input.availability.map((item) => [item.variantId, item]));
  const unitById = new Map(input.serialUnits.map((unit) => [unit.id, unit]));

  for (const line of input.lines) {
    if (line.qty.value <= 0) {
      throw new InvalidReservationInputError(
        `planOrderReservations requiere qty positiva, la línea ${line.lineId} trae ${line.qty.value}.`,
      );
    }
    if (line.serialUnitId === null) continue;

    const unit = unitById.get(line.serialUnitId);
    if (!unit || unit.variantId !== line.variantId || line.qty.value !== 1) {
      throw new InvalidReservationInputError(
        `planOrderReservations: la unidad ${line.serialUnitId} de la línea ${line.lineId} no es de su variante, no se informó o la cantidad no es 1.`,
      );
    }
    if (unit.status !== "available") {
      return err({ code: "SERIAL_UNIT_UNAVAILABLE", serialUnitId: unit.id, status: unit.status });
    }
    if (unit.reservedByOther) {
      return err({ code: "SERIAL_UNIT_ALREADY_RESERVED", serialUnitId: unit.id });
    }
  }

  const requestedByVariant = new Map<string, Quantity>();
  for (const line of input.lines) {
    const previous = requestedByVariant.get(line.variantId);
    requestedByVariant.set(line.variantId, previous ? previous.plus(line.qty) : line.qty);
  }

  const shortages: OrderReservationShortage[] = [];
  const variantIds = [...requestedByVariant.keys()].sort((a, b) => (a < b ? -1 : 1));
  for (const variantId of variantIds) {
    const requested = requestedByVariant.get(variantId)!;
    const availability = availabilityByVariant.get(variantId);
    if (!availability) {
      throw new InvalidReservationInputError(
        `planOrderReservations: falta el disponible de la variante ${variantId}.`,
      );
    }
    if (availability.available.compare(requested) < 0) {
      shortages.push({ variantId, requested, available: availability.available });
    }
  }
  if (shortages.length > 0) return err({ code: "INSUFFICIENT_STOCK", shortages });

  return ok(
    input.lines.map((line): OrderReservationDraft => ({
      lineId: line.lineId,
      variantId: line.variantId,
      serialUnitId: line.serialUnitId,
      qty: line.qty,
      reason: "order_pending_payment",
      expiresAtMs,
    })),
  );
}
