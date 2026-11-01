import type { Prisma } from "@joda/db";
import type { TenantTx } from "../../db/withTenantTx.js";

// Acceso a datos de `stock_reservations` (WP-C18b). Ver docs/api-conventions.md
// §1.1: "repository — consultas y escrituras, sin decisiones". Quién reserva,
// cuánto y hasta cuándo lo decide el dominio y el servicio de cada módulo; acá
// solo se lee y se escribe.
//
// «Viva» es `released_at IS NULL AND expires_at > now()` con el `now()` de la
// base, la misma definición que `v_stock_available` (RN-RES-03): una sola
// fórmula para el disponible, aunque el reloj de la API y el de la base
// difieran unos segundos. El reloj de la API se usa para ESCRIBIR (el
// vencimiento de una reserva nueva, el instante de una liberación), no para
// decidir cuáles cuentan.

export type ReservationRow = Prisma.stock_reservationsGetPayload<Record<string, never>>;
export type ReservationReason = ReservationRow["reason"];

export interface NewReservation {
  readonly tenantId: string;
  readonly variantId: string;
  readonly lotId: string | null;
  readonly serialUnitId: string | null;
  readonly qty: number;
  readonly reason: ReservationReason;
  readonly referenceType: string;
  readonly referenceId: string;
  readonly expiresAt: Date;
  readonly createdBy: string | null;
}

/** Inserta las reservas. `createMany` no devuelve filas: el servicio relee lo que necesita. */
export async function insertReservations(
  tx: TenantTx,
  reservations: readonly NewReservation[],
): Promise<void> {
  if (reservations.length === 0) return;
  await tx.stock_reservations.createMany({
    data: reservations.map((reservation) => ({
      tenant_id: reservation.tenantId,
      variant_id: reservation.variantId,
      lot_id: reservation.lotId,
      serial_unit_id: reservation.serialUnitId,
      qty: reservation.qty,
      reason: reservation.reason,
      reference_type: reservation.referenceType,
      reference_id: reservation.referenceId,
      expires_at: reservation.expiresAt,
      created_by: reservation.createdBy,
    })),
  });
}

/** Las reservas de uno o más orígenes (pedidos u órdenes de fraccionamiento), vivas y liberadas. */
export async function listReservationsOfReferences(
  tx: TenantTx,
  tenantId: string,
  referenceType: string,
  referenceIds: readonly string[],
): Promise<ReservationRow[]> {
  if (referenceIds.length === 0) return [];
  return tx.stock_reservations.findMany({
    where: {
      tenant_id: tenantId,
      reference_type: referenceType,
      reference_id: { in: [...referenceIds] },
    },
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
  });
}

/** Las variantes de las reservas SIN LIBERAR de un origen: a ellas se les toma el bloqueo antes de soltarlas (RN-RES-07). */
export async function listOpenReservationVariantIds(
  tx: TenantTx,
  tenantId: string,
  referenceType: string,
  referenceId: string,
): Promise<string[]> {
  const rows = await tx.stock_reservations.findMany({
    where: {
      tenant_id: tenantId,
      reference_type: referenceType,
      reference_id: referenceId,
      released_at: null,
    },
    select: { variant_id: true },
    distinct: ["variant_id"],
  });
  return rows.map((row) => row.variant_id);
}

export interface ReleasedReservation {
  readonly id: string;
  readonly variant_id: string;
  readonly qty: Prisma.Decimal;
}

// Liberar es marcar `released_at`; la fila no se borra (RN-RES-04). Las dos
// sentencias de abajo toman las filas en orden de `id` (`ORDER BY id FOR
// UPDATE` en el CTE) para que dos liberaciones que se superponen —el job, una
// cancelación, un pedido que libera las vencidas de su variante— las tomen en
// el mismo orden y no se interbloqueen entre sí. `released_at IS NULL` en el
// UPDATE final: una liberada no se vuelve a liberar ni se reactiva.

/** Libera las reservas sin liberar de un origen (cancelar un pedido, ejecutar o cancelar una orden). */
export async function releaseReservationsOfReference(
  tx: TenantTx,
  tenantId: string,
  referenceType: string,
  referenceId: string,
  releasedAt: Date,
): Promise<ReleasedReservation[]> {
  return tx.$queryRaw<ReleasedReservation[]>`
    WITH target AS (
      SELECT r.id FROM app.stock_reservations r
       WHERE r.tenant_id = ${tenantId}::uuid
         AND r.reference_type = ${referenceType}
         AND r.reference_id = ${referenceId}::uuid
         AND r.released_at IS NULL
       ORDER BY r.id
         FOR UPDATE OF r
    )
    UPDATE app.stock_reservations r
       SET released_at = ${releasedAt.toISOString()}::timestamptz
      FROM target
     WHERE r.id = target.id AND r.released_at IS NULL
    RETURNING r.id, r.variant_id, r.qty`;
}

/**
 * Libera las vencidas sin liberar de unas variantes. Quien va a reservar una
 * unidad serializada lo hace antes de insertar: el índice único de 0041 cuenta
 * las reservas SIN LIBERAR, vencidas incluidas, y no hay por qué esperar al job
 * para reutilizar una unidad cuya reserva ya venció.
 */
export async function releaseExpiredOfVariants(
  tx: TenantTx,
  tenantId: string,
  variantIds: readonly string[],
  now: Date,
): Promise<ReleasedReservation[]> {
  if (variantIds.length === 0) return [];
  return tx.$queryRaw<ReleasedReservation[]>`
    WITH target AS (
      SELECT r.id FROM app.stock_reservations r
       WHERE r.tenant_id = ${tenantId}::uuid
         AND r.variant_id = ANY(${[...variantIds]}::uuid[])
         AND r.released_at IS NULL
         AND r.expires_at <= ${now.toISOString()}::timestamptz
       ORDER BY r.id
         FOR UPDATE OF r
    )
    UPDATE app.stock_reservations r
       SET released_at = ${now.toISOString()}::timestamptz
      FROM target
     WHERE r.id = target.id AND r.released_at IS NULL
    RETURNING r.id, r.variant_id, r.qty`;
}

/**
 * El job de liberación (RN-RES-04): libera TODAS las vencidas sin liberar del
 * tenant del contexto. `SKIP LOCKED` es legítimo acá —es un trabajador en
 * segundo plano, no una venta (docs/api-conventions.md §8.2)—: una reserva que
 * otra transacción está liberando o reservando en este instante se salta y la
 * recoge la corrida siguiente, en vez de esperarla. RLS acota a un tenant
 * (`tenant_isolation`), y el `UPDATE` solo puede dejar la reserva liberada
 * (`reservations_update`, 0041).
 */
export async function releaseAllExpired(
  tx: TenantTx,
  tenantId: string,
  now: Date,
): Promise<ReleasedReservation[]> {
  return tx.$queryRaw<ReleasedReservation[]>`
    WITH target AS (
      SELECT r.id FROM app.stock_reservations r
       WHERE r.tenant_id = ${tenantId}::uuid
         AND r.released_at IS NULL
         AND r.expires_at <= ${now.toISOString()}::timestamptz
       ORDER BY r.id
         FOR UPDATE OF r SKIP LOCKED
    )
    UPDATE app.stock_reservations r
       SET released_at = ${now.toISOString()}::timestamptz
      FROM target
     WHERE r.id = target.id AND r.released_at IS NULL
    RETURNING r.id, r.variant_id, r.qty`;
}

/** Las unidades serializadas con una reserva sin liberar (de cualquier pedido): no se prometen a dos clientes. */
export async function listSerialUnitsWithOpenReservation(
  tx: TenantTx,
  tenantId: string,
  serialUnitIds: readonly string[],
): Promise<string[]> {
  if (serialUnitIds.length === 0) return [];
  const rows = await tx.stock_reservations.findMany({
    where: {
      tenant_id: tenantId,
      serial_unit_id: { in: [...serialUnitIds] },
      released_at: null,
    },
    select: { serial_unit_id: true },
  });
  return rows.flatMap((row) => (row.serial_unit_id === null ? [] : [row.serial_unit_id]));
}

/** Cuánto hay reservado y vivo, atado a cada lote. Un lote sin reservas no figura. */
export async function sumLiveReservedByLot(
  tx: TenantTx,
  tenantId: string,
  lotIds: readonly string[],
): Promise<Map<string, number>> {
  if (lotIds.length === 0) return new Map();
  const rows = await tx.$queryRaw<{ lot_id: string; reserved: Prisma.Decimal }[]>`
    SELECT r.lot_id, sum(r.qty) AS reserved
      FROM app.stock_reservations r
     WHERE r.tenant_id = ${tenantId}::uuid
       AND r.lot_id = ANY(${[...lotIds]}::uuid[])
       AND r.released_at IS NULL
       AND r.expires_at > now()
     GROUP BY r.lot_id`;
  return new Map(rows.map((row) => [row.lot_id, row.reserved.toNumber()]));
}

/** ¿El lote tiene una reserva viva propia? Una promesa sobre ese frasco concreto (RN-RES-06). */
export async function hasLiveReservationOnLot(
  tx: TenantTx,
  tenantId: string,
  lotId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ one: number }[]>`
    SELECT 1 AS one
      FROM app.stock_reservations r
     WHERE r.tenant_id = ${tenantId}::uuid
       AND r.lot_id = ${lotId}::uuid
       AND r.released_at IS NULL
       AND r.expires_at > now()
     LIMIT 1`;
  return rows.length > 0;
}

export interface VariantStockRow {
  readonly variant_id: string;
  readonly on_hand: number;
  readonly reserved: number;
  readonly available: number;
}

/**
 * El disponible por variante (`v_stock_available`: saldo − reservas vivas,
 * RN-RES-03). Una variante sin ningún lote no tiene fila: no figura, y quien
 * llama la toma como cero. Se lee DESPUÉS de bloquear las variantes (RN-RES-07),
 * con una sentencia nueva: en READ COMMITTED ve lo que dejó quien tenía el
 * bloqueo antes.
 */
export async function findVariantsStock(
  tx: TenantTx,
  variantIds: readonly string[],
): Promise<Map<string, VariantStockRow>> {
  if (variantIds.length === 0) return new Map();
  const rows = await tx.v_stock_available.findMany({
    where: { variant_id: { in: [...variantIds] } },
  });
  // La vista es de solo lectura y Prisma tipa todas sus columnas como nulables.
  const stock = new Map<string, VariantStockRow>();
  for (const row of rows) {
    if (row.variant_id === null) continue;
    stock.set(row.variant_id, {
      variant_id: row.variant_id,
      on_hand: row.on_hand?.toNumber() ?? 0,
      reserved: row.reserved?.toNumber() ?? 0,
      available: row.available?.toNumber() ?? 0,
    });
  }
  return stock;
}

/** `tenants.reservation_ttl_hours` (0041): lo que dura la reserva de un pedido en espera de pago sin medio registrado. */
export async function findReservationTtlHours(tx: TenantTx, tenantId: string): Promise<number> {
  const tenant = await tx.tenants.findFirst({
    where: { id: tenantId },
    select: { reservation_ttl_hours: true },
  });
  if (!tenant) throw new Error(`el tenant ${tenantId} no se pudo leer bajo RLS`);
  return tenant.reservation_ttl_hours;
}

export interface VariantForReservation {
  readonly id: string;
  readonly sku: string;
  readonly uom: "unit" | "ml";
  readonly production_mode: "stocked" | "made_to_order";
}

/** Lo que hace falta de cada variante de un pedido para decidir si se reserva y en qué unidad. */
export async function findVariantsForReservation(
  tx: TenantTx,
  tenantId: string,
  variantIds: readonly string[],
): Promise<VariantForReservation[]> {
  return tx.product_variants.findMany({
    where: { id: { in: [...variantIds] }, tenant_id: tenantId },
    select: { id: true, sku: true, uom: true, production_mode: true },
  });
}

export interface SerialUnitForReservation {
  readonly id: string;
  readonly variant_id: string;
  readonly status: string;
}

export async function findSerialUnitsForReservation(
  tx: TenantTx,
  tenantId: string,
  serialUnitIds: readonly string[],
): Promise<SerialUnitForReservation[]> {
  if (serialUnitIds.length === 0) return [];
  return tx.serialized_units.findMany({
    where: { id: { in: [...serialUnitIds] }, tenant_id: tenantId },
    select: { id: true, variant_id: true, status: true },
  });
}
