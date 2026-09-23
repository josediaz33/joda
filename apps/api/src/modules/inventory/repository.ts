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
