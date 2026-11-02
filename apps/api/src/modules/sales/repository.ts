import type { Prisma } from "@joda/db";
import type { SaleOrderStatus } from "@joda/domain";
import type { TenantTx } from "../../db/withTenantTx.js";

// `cogs_pyg` (el costo de lo vendido) no sale de esta capa: el vendedor lee los
// pedidos y no tiene permiso para ver costos (0037, WP-B11f). Omitirlo acá, y
// no solo en el mapper, evita que un campo nuevo del DTO lo exponga por descuido.
const ORDER_INCLUDE = {
  sale_order_lines: { omit: { cogs_pyg: true }, orderBy: { position: "asc" as const } },
  sale_order_transitions: { orderBy: { id: "asc" as const } },
} as const;
const ORDER_OMIT = { cogs_pyg: true } as const;

export type SaleOrderRow = Prisma.sale_ordersGetPayload<{
  include: typeof ORDER_INCLUDE;
  omit: typeof ORDER_OMIT;
}>;

// B10 volvió restrictiva la política de aislamiento RLS. Igual que en compras,
// cada acceso conserva el predicado `tenant_id`: una política futura más amplia
// no convierte un id relacionado en una referencia ajena.
export const findChannel = (tx: TenantTx, tenantId: string, id: string) =>
  tx.sales_channels.findFirst({
    where: { id, tenant_id: tenantId },
    select: { id: true, is_active: true },
  });

export const findCustomer = (tx: TenantTx, tenantId: string, id: string) =>
  tx.customers.findFirst({
    where: { id, tenant_id: tenantId },
    select: { id: true, is_active: true },
  });

export const findVariants = (tx: TenantTx, tenantId: string, ids: string[]) =>
  tx.product_variants.findMany({
    where: { id: { in: ids }, tenant_id: tenantId },
    select: { id: true, uom: true, price_pyg: true, vat_rate: true, is_serialized: true },
  });

export const findSerialUnits = (tx: TenantTx, tenantId: string, ids: string[]) =>
  tx.serialized_units.findMany({
    where: { id: { in: ids }, tenant_id: tenantId },
    select: { id: true, variant_id: true, status: true },
  });

/**
 * Órdenes de fraccionamiento del pedido que no están canceladas: pendientes, en
 * curso o ejecutadas. Cancelar el pedido las dejaría colgadas de una venta que
 * ya no va a ocurrir (RN-EST-03; WP-C13c es quien las cancela).
 *
 * Se lee bajo RLS: hoy `decant_work_orders` solo tiene la política de tenant y el
 * vendedor la ve. Si una política futura la restringe por permiso, este conteo
 * daría 0 para él y la cancelación pasaría en silencio; la prueba de
 * `sales.integration.test.ts` que cancela como vendedor es la red.
 */
export const countOpenDecantOrders = (tx: TenantTx, tenantId: string, saleOrderId: string) =>
  tx.decant_work_orders.count({
    where: { tenant_id: tenantId, sale_order_id: saleOrderId, status: { not: "cancelled" } },
  });

/**
 * Siguiente número de pedido del año, `VTA-2026-0001`. Toma un bloqueo de
 * asesoramiento por tenant hasta el final de la transacción: dos pedidos que
 * se crean a la vez no pueden leer el mismo máximo. Solo cuenta los códigos con
 * este formato; los que traiga la migración de datos (WP-D) con otro no estorban.
 */
export async function nextOrderSequence(
  tx: TenantTx,
  tenantId: string,
  year: string,
): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sale_order_code:${tenantId}`}, 0))`;
  const pattern = `^VTA-${year}-([0-9]{1,9})$`;
  const rows = await tx.$queryRaw<{ next: number }[]>`
    SELECT (COALESCE(MAX(substring(code FROM ${pattern})::bigint), 0) + 1)::int AS next
      FROM app.sale_orders
     WHERE tenant_id = ${tenantId}::uuid AND code ~ ${pattern}`;
  return rows[0]!.next;
}

export const findOrder = (tx: TenantTx, tenantId: string, id: string) =>
  tx.sale_orders.findFirst({
    where: { id, tenant_id: tenantId },
    include: ORDER_INCLUDE,
    omit: ORDER_OMIT,
  });

export const listOrders = (
  tx: TenantTx,
  input: {
    tenantId: string;
    cursor?: string;
    limit: number;
    status?: SaleOrderStatus;
    customerId?: string;
  },
) =>
  tx.sale_orders.findMany({
    where: { tenant_id: input.tenantId, status: input.status, customer_id: input.customerId },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
    take: input.limit + 1,
    include: ORDER_INCLUDE,
    omit: ORDER_OMIT,
  });

export async function createOrder(
  tx: TenantTx,
  data: Prisma.sale_ordersUncheckedCreateInput,
  lines: Omit<Prisma.sale_order_linesCreateManyInput, "sale_order_id">[],
): Promise<string> {
  const row = await tx.sale_orders.create({ data, select: { id: true } });
  await tx.sale_order_lines.createMany({
    data: lines.map((line) => ({ ...line, sale_order_id: row.id })),
  });
  return row.id;
}

/** Serializa transiciones y borrados concurrentes sobre el mismo pedido antes de leer su estado. */
export async function lockOrder(tx: TenantTx, tenantId: string, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM app.sale_orders WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
}

/**
 * Cambia el estado solo si el pedido sigue en el que se leyó. Cero filas: la
 * política de UPDATE lo ocultó o alguien lo movió antes (el bloqueo de arriba
 * lo vuelve improbable, esto lo hace imposible).
 */
export async function updateOrderStatus(
  tx: TenantTx,
  tenantId: string,
  id: string,
  from: SaleOrderStatus,
  data: {
    status: SaleOrderStatus;
    placedAt?: Date;
    cancelledAt?: Date;
    confirmedAt?: Date;
    /** El COGS del pedido: la suma del de sus líneas (WP-C19). */
    cogsPyg?: bigint;
  },
): Promise<boolean> {
  const result = await tx.sale_orders.updateMany({
    where: { id, tenant_id: tenantId, status: from },
    data: {
      status: data.status,
      ...(data.placedAt && { placed_at: data.placedAt }),
      ...(data.cancelledAt && { cancelled_at: data.cancelledAt }),
      ...(data.confirmedAt && { confirmed_at: data.confirmedAt }),
      ...(data.cogsPyg !== undefined && { cogs_pyg: data.cogsPyg }),
    },
  });
  return result.count === 1;
}

/**
 * `delete` y no `deleteMany`: con el cliente tipado, una FK que impide borrar
 * (la seña de 0034) llega como `P2003` con el nombre de la restricción, que es
 * lo que el mapeador de errores necesita para decir qué pasó. Sin la fila (la
 * política de DELETE la oculta) lanza `P2025`.
 */
export const removeOrder = (tx: TenantTx, tenantId: string, id: string) =>
  tx.sale_orders.delete({ where: { id, tenant_id: tenantId }, select: { id: true } });

export const insertTransition = (
  tx: TenantTx,
  data: Prisma.sale_order_transitionsUncheckedCreateInput,
) => tx.sale_order_transitions.create({ data });

// ---------------------------------------------------------------------
// Confirmación de la venta — WP-C19 (RF-VTA-05, RF-VTA-06).
// ---------------------------------------------------------------------

/** Lo que la confirmación necesita de la variante de cada línea para decidir cómo se consume. */
export const findVariantsForConfirmation = (tx: TenantTx, tenantId: string, ids: string[]) =>
  tx.product_variants.findMany({
    where: { id: { in: ids }, tenant_id: tenantId },
    select: {
      id: true,
      sku: true,
      uom: true,
      variant_type: true,
      production_mode: true,
      is_serialized: true,
      allocation_policy: true,
    },
  });

/** Las unidades serializadas elegidas por las líneas, con el lote del que salen. */
export const findSerialUnitsForConfirmation = (tx: TenantTx, tenantId: string, ids: string[]) =>
  tx.serialized_units.findMany({
    where: { id: { in: ids }, tenant_id: tenantId },
    select: { id: true, variant_id: true, lot_id: true, status: true },
  });

/**
 * Cuánto tiene reservado y vivo ESTE pedido por variante. «Viva» es la definición
 * de `v_stock_available` (`released_at IS NULL AND expires_at > now()` con el
 * `now()` de la base, RN-RES-03): el disponible de la variante ya descuenta esto,
 * y el pedido que consume tiene derecho a ello.
 */
export async function sumLiveReservedByVariantOfOrder(
  tx: TenantTx,
  tenantId: string,
  orderId: string,
): Promise<Map<string, number>> {
  const rows = await tx.$queryRaw<{ variant_id: string; reserved: Prisma.Decimal }[]>`
    SELECT r.variant_id, sum(r.qty) AS reserved
      FROM app.stock_reservations r
     WHERE r.tenant_id = ${tenantId}::uuid
       AND r.reference_type = 'sale_order'
       AND r.reference_id = ${orderId}::uuid
       AND r.released_at IS NULL
       AND r.expires_at > now()
     GROUP BY r.variant_id`;
  return new Map(rows.map((row) => [row.variant_id, row.reserved.toNumber()]));
}

/** Las unidades serializadas con una reserva viva de OTRO origen: prometidas a otro cliente. */
export async function listSerialUnitsReservedByOthers(
  tx: TenantTx,
  tenantId: string,
  serialUnitIds: readonly string[],
  orderId: string,
): Promise<string[]> {
  if (serialUnitIds.length === 0) return [];
  const rows = await tx.$queryRaw<{ serial_unit_id: string }[]>`
    SELECT DISTINCT r.serial_unit_id
      FROM app.stock_reservations r
     WHERE r.tenant_id = ${tenantId}::uuid
       AND r.serial_unit_id = ANY(${[...serialUnitIds]}::uuid[])
       AND r.released_at IS NULL
       AND r.expires_at > now()
       AND NOT (r.reference_type = 'sale_order' AND r.reference_id = ${orderId}::uuid)`;
  return rows.map((row) => row.serial_unit_id);
}

/**
 * Pasa la unidad a `sold` y la liga a la línea (RN-VTA-04), solo si sigue
 * `available`: la guarda va en el `WHERE`, no en una lectura previa. Devuelve
 * `false` si no la tomó (otro la vendió o la sacó de circulación).
 */
export async function markSerialUnitSold(
  tx: TenantTx,
  tenantId: string,
  unitId: string,
  lineId: string,
): Promise<boolean> {
  const result = await tx.serialized_units.updateMany({
    where: { id: unitId, tenant_id: tenantId, status: "available" },
    data: { status: "sold", sold_order_line_id: lineId },
  });
  return result.count === 1;
}

/** Guarda el COGS de cada línea (la suma de sus capas): una sentencia, no una por línea. */
export async function setLinesCogs(
  tx: TenantTx,
  tenantId: string,
  lines: readonly { readonly id: string; readonly cogsPyg: bigint }[],
): Promise<void> {
  if (lines.length === 0) return;
  await tx.$executeRaw`
    UPDATE app.sale_order_lines l
       SET cogs_pyg = v.cogs
      FROM unnest(${lines.map((line) => line.id)}::uuid[], ${lines.map((line) => line.cogsPyg)}::bigint[])
           AS v(id, cogs)
     WHERE l.id = v.id AND l.tenant_id = ${tenantId}::uuid`;
}

/**
 * Las líneas del pedido que ya tienen una orden de fraccionamiento sin cancelar
 * (el índice único de 0039 admite una por línea): `plan` pudo haberlas
 * planificado antes de la confirmación y no se duplican.
 */
export async function listLinesWithActiveDecantOrder(
  tx: TenantTx,
  tenantId: string,
  lineIds: readonly string[],
): Promise<Set<string>> {
  if (lineIds.length === 0) return new Set();
  const rows = await tx.decant_work_orders.findMany({
    where: {
      tenant_id: tenantId,
      sale_order_line_id: { in: [...lineIds] },
      status: { not: "cancelled" },
    },
    select: { sale_order_line_id: true },
  });
  return new Set(
    rows.flatMap((row) => (row.sale_order_line_id === null ? [] : [row.sale_order_line_id])),
  );
}
