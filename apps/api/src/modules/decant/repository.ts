import type { Prisma } from "@joda/db";
import type { TenantTx } from "../../db/withTenantTx.js";

// Acceso a datos del módulo fraccionamiento (WP-C13). Ver docs/api-conventions.md
// §1.1: "repository — consultas y escrituras, sin decisiones". Las capas de
// costo y la relectura de movimientos son del ledger y viven en
// modules/inventory/repository.ts; acá solo lo propio de las órdenes.

export type DecantWorkOrderRow = Prisma.decant_work_ordersGetPayload<Record<string, never>>;

const LOT_INCLUDE = { inventory_balances: true, product_variants: true } as const;

/** Un lote con su saldo y con el tipo/unidad/política de SU variante: lo que `LotSnapshot` necesita para distinguir un granel de un sellado (RN-FRA-07). */
export type LotWithVariantRow = Prisma.inventory_lotsGetPayload<{ include: typeof LOT_INCLUDE }>;

const QUEUE_INCLUDE = { inventory_lots: { include: { inventory_balances: true } } } as const;

export type QueueOrderRow = Prisma.decant_work_ordersGetPayload<{ include: typeof QUEUE_INCLUDE }>;

// ---------------------------------------------------------------------
// Lecturas de pertenencia (docs/api-conventions.md §8.4): bajo RLS, dentro de
// la misma transacción, antes de escribir con un id que viene del cliente.
// ---------------------------------------------------------------------
export async function saleOrderExists(tx: TenantTx, saleOrderId: string): Promise<boolean> {
  return (await tx.sale_orders.count({ where: { id: saleOrderId } })) > 0;
}

export interface TargetVariantRow {
  readonly id: string;
  readonly product_id: string;
  readonly variant_type: Prisma.product_variantsGetPayload<Record<string, never>>["variant_type"];
  readonly production_mode: Prisma.product_variantsGetPayload<
    Record<string, never>
  >["production_mode"];
  readonly source_variant_id: string | null;
  readonly size_ml: Prisma.Decimal | null;
}

export async function findTargetVariant(
  tx: TenantTx,
  variantId: string,
): Promise<TargetVariantRow | null> {
  return tx.product_variants.findFirst({
    where: { id: variantId },
    select: {
      id: true,
      product_id: true,
      variant_type: true,
      production_mode: true,
      source_variant_id: true,
      size_ml: true,
    },
  });
}

/** `perfume_details.waste_factor` del producto, o `null` si no es un perfume (RN-FRA-02). */
export async function findWasteFactor(tx: TenantTx, productId: string): Promise<number | null> {
  const details = await tx.perfume_details.findFirst({
    where: { product_id: productId },
    select: { waste_factor: true },
  });
  return details ? details.waste_factor.toNumber() : null;
}

// ---------------------------------------------------------------------
// BOM y lotes de insumos.
// ---------------------------------------------------------------------
export type BomComponentRow = Prisma.bom_componentsGetPayload<Record<string, never>>;

export async function listBomComponents(
  tx: TenantTx,
  parentVariantId: string,
): Promise<BomComponentRow[]> {
  return tx.bom_components.findMany({
    where: { parent_variant_id: parentVariantId },
    orderBy: { id: "asc" },
  });
}

export interface VariantLabelRow {
  readonly id: string;
  readonly sku: string;
  readonly allocation_policy: Prisma.product_variantsGetPayload<
    Record<string, never>
  >["allocation_policy"];
}

/** SKU y política de asignación de las variantes de los insumos: la política decide de qué lote sale cada uno (RN-LOT-05). */
export async function listVariantLabels(
  tx: TenantTx,
  variantIds: string[],
): Promise<VariantLabelRow[]> {
  return tx.product_variants.findMany({
    where: { id: { in: variantIds } },
    select: { id: true, sku: true, allocation_policy: true },
  });
}

/** Lotes de insumo que todavía se pueden consumir: en `available` y con saldo. Los de cuarentena o dañados no son saldo vendible. */
export async function listSupplyLots(
  tx: TenantTx,
  variantIds: string[],
): Promise<LotWithVariantRow[]> {
  return tx.inventory_lots.findMany({
    where: {
      variant_id: { in: variantIds },
      status: "available",
      inventory_balances: { on_hand: { gt: 0 } },
    },
    include: LOT_INCLUDE,
    orderBy: { id: "asc" },
  });
}

// ---------------------------------------------------------------------
// Granel de origen.
// ---------------------------------------------------------------------
export async function findLotWithVariant(
  tx: TenantTx,
  lotId: string,
): Promise<LotWithVariantRow | null> {
  return tx.inventory_lots.findFirst({ where: { id: lotId }, include: LOT_INCLUDE });
}

/**
 * Los lotes de granel abiertos de una variante con saldo, el de apertura MÁS
 * ANTIGUA primero (`opened_at`, no `received_at`: se termina antes el frasco
 * que lleva más tiempo abierto, y por lo tanto evaporándose). El id desempata.
 */
export async function listOpenBulkLots(
  tx: TenantTx,
  bulkVariantId: string,
): Promise<LotWithVariantRow[]> {
  return tx.inventory_lots.findMany({
    where: {
      variant_id: bulkVariantId,
      status: "open_for_decant",
      inventory_balances: { on_hand: { gt: 0 } },
    },
    include: LOT_INCLUDE,
    orderBy: [{ opened_at: "asc" }, { id: "asc" }],
  });
}

export async function findLotsWithVariant(
  tx: TenantTx,
  lotIds: string[],
): Promise<LotWithVariantRow[]> {
  return tx.inventory_lots.findMany({ where: { id: { in: lotIds } }, include: LOT_INCLUDE });
}

/**
 * Bloquea los lotes (`FOR UPDATE`) en UNA sola sentencia y en orden ascendente
 * de `lot_id`. Sin un orden determinístico, dos ejecuciones que toquen los
 * mismos lotes en distinto orden se interbloquean (.claude/rules/api.md,
 * "Concurrencia"; docs/api-conventions.md §8.2): el mismo `ORDER BY` que va a
 * usar la confirmación de la venta (WP-C19) sobre estos mismos lotes. No lo
 * "limpies": la sentencia única y el orden son el contrato.
 *
 * HOY el orden también lo da el índice: bajo RLS el plan de `joda_api` recorre
 * `inventory_lots_id_tenant_key` y devuelve por `id`, así que sacar el
 * `ORDER BY` no cambia nada a simple vista. Cambia cuando el plan cambia
 * (estadísticas, un índice nuevo): el orden de bloqueo pasa a ser el del heap
 * y dos ejecuciones se interbloquean (40P01). Lo prueba, con el plan de heap
 * forzado, un test de decant.integration.test.ts.
 *
 * Prisma no expone `FOR UPDATE`, así que va por `$queryRaw`; `::uuid[]`
 * explícito porque Prisma manda el arreglo como `text[]`. La lectura tipada
 * se hace DESPUÉS, con una sentencia nueva: en READ COMMITTED ve lo que dejó
 * quien tenía el bloqueo antes.
 */
export async function lockLotsAscending(tx: TenantTx, lotIds: string[]): Promise<void> {
  await tx.$queryRaw`
    SELECT l.id
      FROM app.inventory_lots l
     WHERE l.id = ANY(${lotIds}::uuid[])
     ORDER BY l.id
       FOR UPDATE OF l`;
}

// ---------------------------------------------------------------------
// Órdenes.
// ---------------------------------------------------------------------
/**
 * Bloquea la orden y la lee. Dos personas que inician (o ejecutan) la misma
 * orden se serializan acá: la segunda espera, lee el estado nuevo y el
 * dominio rechaza la transición.
 */
export async function findWorkOrderForUpdate(
  tx: TenantTx,
  workOrderId: string,
): Promise<DecantWorkOrderRow | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT w.id FROM app.decant_work_orders w WHERE w.id = ${workOrderId}::uuid FOR UPDATE OF w`;
  if (locked.length === 0) return null;
  return tx.decant_work_orders.findFirst({ where: { id: workOrderId } });
}

export interface InsertWorkOrderInput {
  readonly tenantId: string;
  readonly saleOrderId: string;
  readonly sourceLotId: string;
  readonly targetVariantId: string;
  readonly qtyUnits: number;
  readonly mlPerUnit: number;
  readonly mlExpected: number;
  readonly wasteExpected: number;
  readonly createdBy: string;
}

export async function insertWorkOrder(
  tx: TenantTx,
  input: InsertWorkOrderInput,
): Promise<DecantWorkOrderRow> {
  return tx.decant_work_orders.create({
    data: {
      tenant_id: input.tenantId,
      sale_order_id: input.saleOrderId,
      source_lot_id: input.sourceLotId,
      target_variant_id: input.targetVariantId,
      qty_units: input.qtyUnits,
      ml_per_unit: input.mlPerUnit,
      ml_expected: input.mlExpected,
      waste_expected: input.wasteExpected,
      created_by: input.createdBy,
    },
  });
}

export async function markWorkOrderInProgress(
  tx: TenantTx,
  workOrderId: string,
): Promise<DecantWorkOrderRow> {
  return tx.decant_work_orders.update({
    where: { id: workOrderId },
    data: { status: "in_progress" },
  });
}

export interface MarkWorkOrderDoneInput {
  readonly wasteActual: number;
  readonly executedBy: string;
  readonly executedAt: Date;
}

export async function markWorkOrderDone(
  tx: TenantTx,
  workOrderId: string,
  input: MarkWorkOrderDoneInput,
): Promise<DecantWorkOrderRow> {
  return tx.decant_work_orders.update({
    where: { id: workOrderId },
    data: {
      status: "done",
      waste_actual: input.wasteActual,
      executed_by: input.executedBy,
      executed_at: input.executedAt,
    },
  });
}

/** La cola (RF-FRA-06): las órdenes sin ejecutar, con el lote de origen y su saldo. El orden compuesto es fijo del lado del servidor. */
export async function listQueueOrders(
  tx: TenantTx,
  status: "pending" | "in_progress" | undefined,
): Promise<QueueOrderRow[]> {
  return tx.decant_work_orders.findMany({
    where: { status: status ?? { in: ["pending", "in_progress"] } },
    include: QUEUE_INCLUDE,
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
  });
}

// ---------------------------------------------------------------------
// Ledger — solo los tres tipos de movimiento de una ejecución (RN-FRA-03).
// ---------------------------------------------------------------------
export interface InsertDecantMovementInput {
  readonly tenantId: string;
  readonly lotId: string;
  readonly variantId: string;
  readonly qty: number;
  readonly uom: "unit" | "ml";
  readonly movementType: "decant_consumption" | "waste" | "bom_consumption";
  readonly totalCostPyg: bigint;
  readonly workOrderId: string;
  readonly createdBy: string;
  readonly note: string | null;
}

export async function insertDecantMovement(
  tx: TenantTx,
  input: InsertDecantMovementInput,
): Promise<bigint> {
  const row = await tx.inventory_movements.create({
    data: {
      tenant_id: input.tenantId,
      lot_id: input.lotId,
      variant_id: input.variantId,
      qty: input.qty,
      uom: input.uom,
      movement_type: input.movementType,
      total_cost_pyg: input.totalCostPyg,
      reference_type: "decant_work_order",
      reference_id: input.workOrderId,
      created_by: input.createdBy,
      note: input.note,
    },
    select: { id: true },
  });
  return row.id;
}
