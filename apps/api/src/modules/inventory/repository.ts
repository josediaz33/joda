import type { Prisma } from "@joda/db";
import type { TenantTx } from "../../db/withTenantTx.js";

// Acceso a datos del módulo inventario (WP-C10). Ver docs/api-conventions.md
// §1.1: "repository — consultas y escrituras, sin decisiones".
const LOT_INCLUDE = { inventory_balances: true } as const;

export type LotWithBalanceRow = Prisma.inventory_lotsGetPayload<{ include: typeof LOT_INCLUDE }>;
export type MovementRow = Prisma.inventory_movementsGetPayload<Record<string, never>>;
export type StockAvailabilityRow = Prisma.v_stock_availableGetPayload<Record<string, never>>;

export async function findStockAvailability(
  tx: TenantTx,
  variantId: string,
): Promise<StockAvailabilityRow | null> {
  return tx.v_stock_available.findFirst({ where: { variant_id: variantId } });
}

/**
 * `v_stock_available` no tiene fila para una variante sin ningún lote
 * todavía — el mismo `null` que da una variante inexistente o de otro
 * tenant (RLS filtra esta segunda, tenant_isolation estándar). Sin este
 * chequeo, `getStockAvailability` no podía distinguir "variante real, sin
 * stock" (0 legítimo) de "variantId con typo o ajeno" (debería ser 404,
 * docs/api-conventions.md §4.2: "recurso inexistente → NOT_FOUND") —
 * hallazgo de la revisión cruzada de WP-C10.
 */
export async function variantExists(tx: TenantTx, variantId: string): Promise<boolean> {
  const count = await tx.product_variants.count({ where: { id: variantId } });
  return count > 0;
}

export async function findLotWithBalance(
  tx: TenantTx,
  id: string,
): Promise<LotWithBalanceRow | null> {
  return tx.inventory_lots.findFirst({ where: { id }, include: LOT_INCLUDE });
}

export async function listMovementsByLot(tx: TenantTx, lotId: string): Promise<MovementRow[]> {
  return tx.inventory_movements.findMany({
    where: { lot_id: lotId },
    orderBy: [{ occurred_at: "asc" }, { id: "asc" }],
  });
}

export async function findMovementById(tx: TenantTx, id: bigint): Promise<MovementRow | null> {
  return tx.inventory_movements.findFirst({ where: { id } });
}

export interface LotForAdjustment {
  readonly id: string;
  readonly variantId: string;
  readonly uom: "unit" | "ml";
  readonly unitLandedCostPyg: bigint;
  readonly onHand: number;
}

interface LotForAdjustmentQueryRow {
  readonly id: string;
  readonly variant_id: string;
  readonly uom: "unit" | "ml";
  readonly unit_landed_cost_pyg: bigint;
  readonly on_hand: { toNumber(): number };
}

/**
 * Bloquea la fila del lote (docs/api-conventions.md §8.2: "bloqueo de
 * lotes... en una sola sentencia" — acá un único lote, pero misma
 * disciplina: cualquier otra operación que toque el saldo de ESTE lote
 * queda serializada detrás de este `FOR UPDATE`, dentro de la misma
 * transacción, desde antes de decidir nada). Prisma no expone `FOR UPDATE`
 * en su query builder — `$queryRaw` es la única vía; `FOR UPDATE OF l`
 * bloquea solo `inventory_lots`, no la fila de `inventory_balances` (no
 * hace falta: cualquier otro escritor que respete esta misma disciplina
 * pasa primero por este lock antes de tocar el saldo).
 */
export async function findLotForAdjustment(
  tx: TenantTx,
  lotId: string,
): Promise<LotForAdjustment | null> {
  // `::uuid` explícito: Prisma envía el parámetro como `text`, y Postgres no
  // tiene un operador `uuid = text` implícito — sin el cast, falla con
  // "operator does not exist: uuid = text" (42883) en vez de encontrar la fila.
  const rows = await tx.$queryRaw<LotForAdjustmentQueryRow[]>`
    SELECT l.id, l.variant_id, l.uom, l.unit_landed_cost_pyg, b.on_hand
      FROM app.inventory_lots l
      JOIN app.inventory_balances b ON b.lot_id = l.id
     WHERE l.id = ${lotId}::uuid
       FOR UPDATE OF l`;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    variantId: row.variant_id,
    uom: row.uom,
    unitLandedCostPyg: row.unit_landed_cost_pyg,
    onHand: row.on_hand.toNumber(),
  };
}

export interface InsertAdjustmentMovementInput {
  readonly tenantId: string;
  readonly lotId: string;
  readonly variantId: string;
  readonly qty: number;
  readonly uom: "unit" | "ml";
  readonly totalCostPyg: bigint | null;
  readonly createdBy: string;
  readonly note: string;
}

/** Movimiento de ajuste (RF-INV-04) — el único `movement_type` que esta sesión escribe; goods_receipt/sale/decant/etc. llegan con sus propios WP. */
export async function insertAdjustmentMovement(
  tx: TenantTx,
  input: InsertAdjustmentMovementInput,
): Promise<bigint> {
  const row = await tx.inventory_movements.create({
    data: {
      tenant_id: input.tenantId,
      lot_id: input.lotId,
      variant_id: input.variantId,
      qty: input.qty,
      uom: input.uom,
      movement_type: "adjustment",
      total_cost_pyg: input.totalCostPyg,
      created_by: input.createdBy,
      note: input.note,
    },
    select: { id: true },
  });
  return row.id;
}

export interface InsertCostAllocationInput {
  readonly tenantId: string;
  readonly movementId: bigint;
  readonly lotId: string;
  readonly qty: number;
  readonly unitCostPyg: bigint;
  readonly totalCostPyg: bigint;
}

export async function insertCostAllocation(
  tx: TenantTx,
  input: InsertCostAllocationInput,
): Promise<void> {
  await tx.movement_cost_allocations.create({
    data: {
      tenant_id: input.tenantId,
      movement_id: input.movementId,
      lot_id: input.lotId,
      qty: input.qty,
      unit_cost_pyg: input.unitCostPyg,
      total_cost_pyg: input.totalCostPyg,
    },
  });
}

// ---------------------------------------------------------------------
// Apertura de frasco — WP-C11 (RN-LOT-02, ADR-009).
// ---------------------------------------------------------------------
const LOT_FOR_OPENING_INCLUDE = { inventory_balances: true, product_variants: true } as const;

/** El lote sellado a abrir, con su saldo y el tipo/producto de su variante. */
export type LotForOpeningRow = Prisma.inventory_lotsGetPayload<{
  include: typeof LOT_FOR_OPENING_INCLUDE;
}>;

/**
 * Bloquea la fila del lote y la lee. Prisma no expone `FOR UPDATE`, así que
 * el bloqueo va por `$queryRaw` y la lectura tipada, después, por el cliente:
 * en READ COMMITTED cada sentencia toma un snapshot nuevo, y la segunda ya
 * ve el estado que dejó quien tenía el bloqueo antes.
 *
 * Es el único lote que se bloquea: los que nacen en la apertura son nuevos e
 * invisibles para cualquier otra transacción. Con más de un lote habría que
 * tomarlos en orden ascendente de `lot_id` y en una sola sentencia
 * (.claude/rules/api.md, "Concurrencia"). Dos aperturas del mismo lote se
 * serializan acá: la segunda espera, lee `open_for_decant` y el dominio la
 * rechaza (caso borde 5).
 */
export async function findLotForOpening(
  tx: TenantTx,
  lotId: string,
): Promise<LotForOpeningRow | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM app.inventory_lots l WHERE l.id = ${lotId}::uuid FOR UPDATE OF l`;
  if (locked.length === 0) return null;
  return tx.inventory_lots.findFirst({
    where: { id: lotId },
    include: LOT_FOR_OPENING_INCLUDE,
  });
}

/** Las variantes de granel de un producto: el índice de 0028 garantiza a lo sumo una. */
export async function findBulkVariantIds(tx: TenantTx, productId: string): Promise<string[]> {
  const rows = await tx.product_variants.findMany({
    where: { product_id: productId, variant_type: "bulk" },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** `perfume_details.nominal_volume_ml` del producto, o `null` si no es un perfume. */
export async function findNominalVolumeMl(tx: TenantTx, productId: string): Promise<number | null> {
  const details = await tx.perfume_details.findFirst({
    where: { product_id: productId },
    select: { nominal_volume_ml: true },
  });
  return details ? details.nominal_volume_ml.toNumber() : null;
}

export interface InsertLotInput {
  readonly tenantId: string;
  readonly variantId: string;
  readonly parentLotId: string;
  readonly status: "available" | "open_for_decant";
  readonly qtyInitial: number;
  readonly uom: "unit" | "ml";
  readonly unitCostMinor: bigint;
  readonly currency: string;
  readonly fxRateToPyg: Prisma.Decimal;
  readonly landedCostPyg: bigint;
  readonly unitLandedCostPyg: bigint;
  readonly batchCode: string | null;
  readonly manufacturedAt: Date | null;
  readonly expiryAt: Date | null;
  readonly openedAt: Date | null;
  readonly receivedAt: Date;
}

/**
 * Alta de un lote derivado de otro (`parent_lot_id`). El `id` lo genera el
 * dominio (`IdGenerator`): se pasa acá para que los movimientos, que ya
 * apuntan a él, no dependan de una segunda lectura. La fila de saldo nace en
 * cero con el lote (trigger `init_lot_balance`).
 */
export async function insertDerivedLot(
  tx: TenantTx,
  id: string,
  input: InsertLotInput,
): Promise<void> {
  await tx.inventory_lots.create({
    data: {
      id,
      tenant_id: input.tenantId,
      variant_id: input.variantId,
      parent_lot_id: input.parentLotId,
      status: input.status,
      qty_initial: input.qtyInitial,
      uom: input.uom,
      unit_cost_minor: input.unitCostMinor,
      currency: input.currency,
      fx_rate_to_pyg: input.fxRateToPyg,
      landed_cost_pyg: input.landedCostPyg,
      unit_landed_cost_pyg: input.unitLandedCostPyg,
      batch_code: input.batchCode,
      manufactured_at: input.manufacturedAt,
      expiry_at: input.expiryAt,
      opened_at: input.openedAt,
      received_at: input.receivedAt,
    },
  });
}

/** RN-LOT-02 paso 2: el sellado pasa a `open_for_decant`. Es terminal (RN-LOT-03, 0023). */
export async function markLotOpenForDecant(
  tx: TenantTx,
  lotId: string,
  openedAt: Date,
): Promise<void> {
  await tx.inventory_lots.update({
    where: { id: lotId },
    data: { status: "open_for_decant", opened_at: openedAt },
  });
}

export interface InsertTransferMovementInput {
  readonly tenantId: string;
  readonly lotId: string;
  readonly variantId: string;
  readonly qty: number;
  readonly uom: "unit" | "ml";
  readonly movementType: "transfer_in" | "transfer_out";
  readonly totalCostPyg: bigint;
  readonly referenceType: "lot_separation" | "lot_opening";
  readonly referenceId: string;
  readonly createdBy: string;
}

/** Movimiento de la separación o de la apertura de un frasco: solo `transfer_in`/`transfer_out`. */
export async function insertTransferMovement(
  tx: TenantTx,
  input: InsertTransferMovementInput,
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
      reference_type: input.referenceType,
      reference_id: input.referenceId,
      created_by: input.createdBy,
    },
    select: { id: true },
  });
  return row.id;
}

export async function findMovementsByIds(tx: TenantTx, ids: bigint[]): Promise<MovementRow[]> {
  return tx.inventory_movements.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
}
