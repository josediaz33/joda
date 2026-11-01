import {
  planOrderReservations,
  Quantity,
  type Clock,
  type OrderReservationError,
} from "@joda/domain";
import type { Prisma } from "@joda/db";
import { lockVariantsThenLots } from "../../db/stockLocks.js";
import type { TenantTx, TenantTxContext } from "../../db/withTenantTx.js";
import { appError, toTRPCError, type ApiError } from "../../middleware/errorMapper.js";
import * as repo from "./repository.js";

// Reservas de stock (WP-C18b; RF-VTA-04, RN-RES-01…07, ADR-019). Este módulo no
// tiene router: reservar y soltar son EFECTOS de otros casos de uso (pasar un
// pedido a `awaiting_payment`, cancelarlo, planificar y ejecutar un decant, y
// el job de liberación), así que los llaman `modules/sales`, `modules/decant` y
// `jobs/`, siempre con el `tx` de su transacción: la reserva y la operación que
// la origina se confirman o se revierten juntas.
//
// Todo lo que decide sobre stock respeta el orden de bloqueo único (RN-RES-07,
// `db/stockLocks.ts`): primero las filas de las variantes, por `id` ascendente.
// El disponible se lee DESPUÉS de bloquearlas.

export interface ReservationDeps {
  readonly clock: Clock;
}

/** `reference_type` de las reservas que nacen de un pedido de venta. */
export const SALE_ORDER_REFERENCE = "sale_order";
/** `reference_type` de las reservas de un plan de decant (granel e insumos de una orden). */
export const DECANT_WORK_ORDER_REFERENCE = "decant_work_order";

/** Una línea del pedido tal como la lee el repositorio de ventas. */
export interface OrderLineToReserve {
  readonly id: string;
  readonly variant_id: string;
  readonly serial_unit_id: string | null;
  readonly qty: Prisma.Decimal;
}

function toQuantity(value: number, uom: "unit" | "ml"): Quantity {
  return uom === "unit" ? Quantity.units(value) : Quantity.ml(value);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function reservationError(
  error: OrderReservationError,
  skuByVariant: ReadonlyMap<string, string>,
): ApiError {
  switch (error.code) {
    case "INSUFFICIENT_STOCK":
      return appError(
        "CONFLICT_INSUFFICIENT_STOCK",
        409,
        "No hay stock disponible para reservar todo el pedido. Revisá las cantidades de las líneas que se indican.",
        {
          shortages: error.shortages.map((shortage) => ({
            variantId: shortage.variantId,
            sku: skuByVariant.get(shortage.variantId) ?? null,
            requested: shortage.requested.value,
            available: shortage.available.value,
          })),
        },
      );
    case "SERIAL_UNIT_UNAVAILABLE":
      return appError(
        "CONFLICT_SERIAL_UNIT_UNAVAILABLE",
        409,
        "Una de las unidades elegidas ya no está disponible para la venta. Elegí otra o sacala del pedido.",
        { serialUnitId: error.serialUnitId, status: error.status },
      );
    case "SERIAL_UNIT_ALREADY_RESERVED":
      return appError(
        "CONFLICT_SERIAL_UNIT_RESERVED",
        409,
        "Una de las unidades elegidas está reservada por otro pedido. Elegí otra o esperá a que se libere.",
        { serialUnitId: error.serialUnitId },
      );
  }
}

/**
 * Reserva el pedido que pasa a `awaiting_payment`, en la MISMA transacción que
 * el cambio de estado (RF-VTA-04). Una reserva por línea:
 *
 *   · por variante, sin lote, para una línea común (RN-RES-06);
 *   · por unidad serializada (`serial_unit_id`) para un reloj;
 *   · NINGUNA para un decant bajo pedido (`made_to_order`): no tiene saldo
 *     propio, y su compromiso es reservar granel e insumos al planificar el
 *     fraccionamiento (RN-FRA-01, `inventory.decant.plan`).
 *
 * Vence según RN-RES-02 para el pedido en espera de pago sin medio de pago
 * registrado: las horas que el tenant tenga configuradas (24 por defecto).
 *
 * Todo o nada: ante un faltante, una unidad vendida o una unidad reservada por
 * otro pedido lanza 409 y la transacción del llamador se revierte entera.
 * Devuelve cuántas reservas creó.
 */
export async function reserveOrderLines(
  tx: TenantTx,
  session: TenantTxContext,
  orderId: string,
  lines: readonly OrderLineToReserve[],
  deps: ReservationDeps,
): Promise<number> {
  const { tenantId } = session;
  const variants = await repo.findVariantsForReservation(
    tx,
    tenantId,
    unique(lines.map((line) => line.variant_id)),
  );
  const variantById = new Map(variants.map((variant) => [variant.id, variant]));
  const reservable = lines.filter((line) => {
    const variant = variantById.get(line.variant_id);
    if (!variant) throw new Error(`la variante ${line.variant_id} del pedido ${orderId} no existe`);
    return variant.production_mode !== "made_to_order";
  });
  if (reservable.length === 0) return 0;

  const variantIds = unique(reservable.map((line) => line.variant_id));
  const now = deps.clock.now();

  // RN-RES-07: las variantes primero, antes de leer el disponible.
  await lockVariantsThenLots(tx, tenantId, { variantIds });
  // Una unidad cuya reserva ya venció pero el job todavía no liberó seguiría
  // ocupando el índice único (0041): se libera acá, bajo el bloqueo.
  await repo.releaseExpiredOfVariants(tx, tenantId, variantIds, now);

  const serialUnitIds = unique(
    reservable.flatMap((line) => (line.serial_unit_id === null ? [] : [line.serial_unit_id])),
  );
  const [stock, units, reservedUnitIds, ttlHours] = await Promise.all([
    repo.findVariantsStock(tx, variantIds),
    repo.findSerialUnitsForReservation(tx, tenantId, serialUnitIds),
    repo.listSerialUnitsWithOpenReservation(tx, tenantId, serialUnitIds),
    repo.findReservationTtlHours(tx, tenantId),
  ]);
  const reserved = new Set(reservedUnitIds);

  const plan = planOrderReservations({
    lines: reservable.map((line) => ({
      lineId: line.id,
      variantId: line.variant_id,
      qty: toQuantity(line.qty.toNumber(), variantById.get(line.variant_id)!.uom),
      serialUnitId: line.serial_unit_id,
    })),
    availability: variantIds.map((variantId) => ({
      variantId,
      available: toQuantity(stock.get(variantId)?.available ?? 0, variantById.get(variantId)!.uom),
    })),
    serialUnits: units.map((unit) => ({
      id: unit.id,
      variantId: unit.variant_id,
      status: unit.status,
      reservedByOther: reserved.has(unit.id),
    })),
    startedAt: now,
    ttlHours,
  });
  if (!plan.ok) {
    throw toTRPCError(
      reservationError(plan.error, new Map(variants.map((variant) => [variant.id, variant.sku]))),
    );
  }

  await repo.insertReservations(
    tx,
    plan.value.map((draft) => ({
      tenantId,
      variantId: draft.variantId,
      lotId: null,
      serialUnitId: draft.serialUnitId,
      qty: draft.qty.value,
      reason: draft.reason,
      referenceType: SALE_ORDER_REFERENCE,
      referenceId: orderId,
      expiresAt: new Date(draft.expiresAtMs),
      createdBy: session.userId,
    })),
  );
  return plan.value.length;
}

/**
 * Suelta las reservas sin liberar de un origen (un pedido que se cancela, una
 * orden de fraccionamiento que se ejecuta o se cancela). Liberar es marcar
 * `released_at`: la fila no se borra y una liberada no se reactiva (RN-RES-04).
 * Toma antes el bloqueo de las variantes involucradas (RN-RES-07). Devuelve
 * cuántas liberó; sin reservas sin liberar, 0 y no toca nada.
 *
 * **Quien ya bloqueó stock en su transacción tiene que haber incluido en ese
 * bloqueo las variantes de estas reservas** (`listOpenReservationVariantIds`,
 * leídas antes): esta función las pide de nuevo, y una que no tenía se tomaría
 * acá, tarde, con variantes y lotes de id mayor ya en la mano. Es lo que hace
 * la ejecución de un fraccionamiento; el gancho de cancelar una orden
 * (WP-C13c) tiene que hacer lo mismo. Cancelar un pedido no lo necesita: antes
 * de soltar solo tomó la fila del pedido.
 *
 * **Quien no puede liberarlas recibe 403, no un 0 en silencio.** La política de
 * UPDATE de la tabla (0041) exige el permiso del `reason` y, cuando falta, oculta
 * la fila: el `UPDATE` afecta cero filas y no da error. Si después de soltar
 * quedan reservas sin liberar del origen, es que la política las ocultó (nadie
 * más las puede estar tomando: las variantes están bloqueadas).
 */
export async function releaseReservationsOf(
  tx: TenantTx,
  session: TenantTxContext,
  referenceType: string,
  referenceId: string,
  deps: ReservationDeps,
): Promise<number> {
  const { tenantId } = session;
  const variantIds = await repo.listOpenReservationVariantIds(
    tx,
    tenantId,
    referenceType,
    referenceId,
  );
  if (variantIds.length === 0) return 0;
  await lockVariantsThenLots(tx, tenantId, { variantIds });
  const released = await repo.releaseReservationsOfReference(
    tx,
    tenantId,
    referenceType,
    referenceId,
    deps.clock.now(),
  );
  const stillOpen = await repo.listOpenReservationVariantIds(
    tx,
    tenantId,
    referenceType,
    referenceId,
  );
  if (stillOpen.length > 0) {
    throw toTRPCError(
      appError(
        "FORBIDDEN_INSUFFICIENT_PERMISSION",
        403,
        "No tenés permiso para liberar estas reservas.",
      ),
    );
  }
  return released.length;
}

/** Las reservas de uno o más pedidos, para que el pedido las devuelva (vivas y liberadas). */
export async function listOrderReservations(
  tx: TenantTx,
  tenantId: string,
  orderIds: readonly string[],
): Promise<Map<string, repo.ReservationRow[]>> {
  const rows = await repo.listReservationsOfReferences(
    tx,
    tenantId,
    SALE_ORDER_REFERENCE,
    orderIds,
  );
  const byOrder = new Map<string, repo.ReservationRow[]>();
  for (const row of rows) {
    // `reference_id` es nullable en la tabla; las del pedido siempre lo traen.
    const orderId = row.reference_id;
    if (orderId === null) continue;
    byOrder.set(orderId, [...(byOrder.get(orderId) ?? []), row]);
  }
  return byOrder;
}
