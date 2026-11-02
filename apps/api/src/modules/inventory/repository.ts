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
 * Lee el lote de un ajuste con su saldo. **El bloqueo ya lo tomó el servicio**
 * con `lockLotWithItsVariant` (`db/stockLocks.ts`, RN-RES-07): primero la
 * variante y después el lote, y cualquier otra operación que toque el saldo de
 * ESTE lote queda serializada detrás de ellos, dentro de la misma transacción,
 * desde antes de decidir nada. Esta lectura va DESPUÉS, con una sentencia
 * nueva: en READ COMMITTED ve lo que dejó quien tenía el bloqueo antes. No
 * toma ningún bloqueo propio: bloquear acá el lote sin haber tomado la variante
 * es justo el orden que RN-RES-07 prohíbe.
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
     WHERE l.id = ${lotId}::uuid`;
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
// Venta — WP-C19 (RF-VTA-05, RF-VTA-06, RN-VTA-02, RN-COS-04, ADR-008).
// ---------------------------------------------------------------------

/** Un lote que la venta puede consumir, tal como lo entrega `app.list_sale_allocation_lots`. */
export interface SaleAllocationLotRow {
  readonly lot_id: string;
  readonly variant_id: string;
  readonly received_at: Date;
  readonly expiry_at: Date | null;
  readonly on_hand: Prisma.Decimal;
  readonly unit_landed_cost_pyg: bigint;
}

/**
 * Los lotes `available` con saldo de unas variantes, con su costo unitario, Y
 * LOS BLOQUEA (`FOR UPDATE`, una sentencia, `id` ascendente: la función los toma
 * adentro, 0042). Es el único camino por el que quien vende lee un lote: el
 * vendedor no tiene `inventory.stock:read` (`lots_read`), así que sin esta función
 * no vería ningún lote, ni podría bloquearlos. La llama el servicio DESPUÉS de
 * `lockVariantsThenLots` (RN-RES-07: las variantes primero).
 *
 * **El costo que devuelve es de la API, no de la respuesta:** lo usa el dominio
 * para armar las capas y no se copia a ningún DTO, mensaje de error ni auditoría.
 */
export async function listSaleAllocationLots(
  tx: TenantTx,
  variantIds: readonly string[],
): Promise<SaleAllocationLotRow[]> {
  return tx.$queryRaw<SaleAllocationLotRow[]>`
    SELECT f.lot_id, f.variant_id, f.received_at, f.expiry_at, f.on_hand, f.unit_landed_cost_pyg
      FROM app.list_sale_allocation_lots(${[...variantIds]}::uuid[]) f
     ORDER BY f.lot_id`;
}

export interface InsertSaleMovementInput {
  readonly tenantId: string;
  readonly lotId: string;
  readonly variantId: string;
  readonly serialUnitId: string | null;
  /** Lo que sale, positivo: el movimiento se registra con signo negativo. */
  readonly qty: number;
  readonly uom: "unit" | "ml";
  readonly unitCostPyg: bigint;
  readonly totalCostPyg: bigint;
  readonly saleOrderId: string;
  readonly occurredAt: Date;
  readonly createdBy: string;
  readonly note: string;
}

/**
 * Registra UNA salida por venta de un lote y su capa de costo (RN-COS-04: una
 * capa por lote tocado). Dos sentencias de SQL crudo, **sin `RETURNING`**:
 *
 *   · El vendedor registra el movimiento `sale` (`sales.order:write`, 0034) pero
 *     no lo lee: desde 0037 el SELECT de `inventory_movements` exige
 *     `inventory.stock:read`, y `INSERT … RETURNING` evalúa esa política sobre la
 *     fila nueva (42501). El `create` de Prisma emite `RETURNING`.
 *   · La capa necesita el id del movimiento: sale de `currval` de la secuencia
 *     de `inventory_movements.id`, NO de `lastval()` (dentro del INSERT de la capa
 *     devolvería la identidad de la capa; verificado en 0037).
 *   · El movimiento va en la transacción del llamador, **fuera de todo
 *     SAVEPOINT** (0039): su `xmin` tiene que ser el de la transacción para que
 *     `app.can_allocate_cost_to_movement` deje insertar la capa. Prisma no abre
 *     savepoints dentro de una transacción interactiva.
 *
 * `total_cost_pyg` del movimiento y de la capa son el mismo importe: la
 * restricción diferida de 0009 verifica `Σ capas = |total_cost_pyg|` al commit.
 */
export async function insertSaleMovementWithLayer(
  tx: TenantTx,
  input: InsertSaleMovementInput,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO app.inventory_movements
      (tenant_id, lot_id, variant_id, serial_unit_id, qty, uom, movement_type,
       total_cost_pyg, reference_type, reference_id, occurred_at, created_by, note)
    VALUES
      (${input.tenantId}::uuid, ${input.lotId}::uuid, ${input.variantId}::uuid,
       ${input.serialUnitId}::uuid, ${-input.qty}::numeric, ${input.uom}::app.uom, 'sale',
       ${input.totalCostPyg}::bigint, 'sale_order', ${input.saleOrderId}::uuid,
       ${input.occurredAt.toISOString()}::timestamptz, ${input.createdBy}::uuid, ${input.note})`;
  await tx.$executeRaw`
    INSERT INTO app.movement_cost_allocations
      (tenant_id, movement_id, lot_id, qty, unit_cost_pyg, total_cost_pyg)
    VALUES
      (${input.tenantId}::uuid,
       currval(pg_get_serial_sequence('app.inventory_movements', 'id')),
       ${input.lotId}::uuid, ${input.qty}::numeric, ${input.unitCostPyg}::bigint,
       ${input.totalCostPyg}::bigint)`;
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
 * El sellado a abrir, con su saldo y su variante, SIN bloquear. El servicio
 * toma antes el bloqueo de la variante del sellado y la del granel, y después
 * el lote (`lockVariantsThenLots`, RN-RES-07), y recién entonces llama a esta
 * lectura: en READ COMMITTED cada sentencia toma un snapshot nuevo, así que ve
 * lo que dejó quien tenía el bloqueo antes. Los lotes que nacen en la apertura
 * son nuevos e invisibles para cualquier otra transacción: no se bloquean. Dos
 * aperturas del mismo lote se serializan por la variante: la segunda espera,
 * lee `open_for_decant` y el dominio la rechaza (caso borde 5).
 */
export async function findLotForOpening(
  tx: TenantTx,
  lotId: string,
): Promise<LotForOpeningRow | null> {
  return tx.inventory_lots.findFirst({
    where: { id: lotId },
    include: LOT_FOR_OPENING_INCLUDE,
  });
}

/**
 * Lo mínimo del lote a abrir, leído SIN bloquear: de qué variante es, de qué
 * producto y de qué tipo. Con eso el servicio sabe QUÉ variantes bloquear antes
 * que el lote (RN-RES-07); el lote se relee y se revalida ya bloqueado.
 */
export async function peekLotForOpening(tx: TenantTx, lotId: string) {
  return tx.inventory_lots.findFirst({
    where: { id: lotId },
    select: {
      variant_id: true,
      product_variants: { select: { product_id: true, variant_type: true } },
    },
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

// ---------------------------------------------------------------------
// Unidades serializadas — WP-C12 (RF-INV-10, RN-SER-01…04).
// ---------------------------------------------------------------------
export type SerializedUnitRow = Prisma.serialized_unitsGetPayload<Record<string, never>>;

const LOT_FOR_SERIALS_INCLUDE = { product_variants: true } as const;

/** El lote contra el que se registra una unidad, con la variante que dice si es serializada. */
export type LotForSerialsRow = Prisma.inventory_lotsGetPayload<{
  include: typeof LOT_FOR_SERIALS_INCLUDE;
}>;

/**
 * Lee el lote contra el que se registra una unidad. RN-SER-03 (las unidades
 * registradas no superan `qty_initial`) es una lectura seguida de una
 * escritura: dos altas simultáneas ven "2 de 3" y registran la cuarta. El
 * bloqueo (la variante y después el lote, `lockLotWithItsVariant`, RN-RES-07)
 * tiene que tomarse ANTES de contar, y solo lo cierra si todas las altas del
 * lote pasan por ahí. Un `CHECK` no lo puede impedir: cuenta filas de otra
 * tabla.
 */
export async function findLotForSerialRegistration(
  tx: TenantTx,
  lotId: string,
): Promise<LotForSerialsRow | null> {
  return tx.inventory_lots.findFirst({
    where: { id: lotId },
    include: LOT_FOR_SERIALS_INCLUDE,
  });
}

/** Unidades registradas del lote, de TODOS los estados: las vendidas también cuentan (RN-SER-03). */
export async function countSerializedUnitsOfLot(tx: TenantTx, lotId: string): Promise<number> {
  return tx.serialized_units.count({ where: { lot_id: lotId } });
}

/** Unidades registradas de la variante, de TODOS los estados: las vendidas también cuentan (RN-SER-03). */
export async function countSerializedUnitsOfVariant(
  tx: TenantTx,
  variantId: string,
): Promise<number> {
  return tx.serialized_units.count({ where: { variant_id: variantId } });
}

export interface InsertSerializedUnitInput {
  readonly id: string;
  readonly tenantId: string;
  readonly variantId: string;
  readonly lotId: string;
  readonly serialNumber: string;
  readonly warrantyUntil: Date | null;
  readonly notes: string | null;
}

/**
 * Inserta la unidad y dice si quedó creada. `skipDuplicates` es `INSERT ...
 * ON CONFLICT DO NOTHING`: un número de serie repetido en el tenant
 * (RN-SER-01, `UNIQUE (tenant_id, serial_number)`) no lanza, devuelve `false`.
 * La unicidad la sigue imponiendo la base; esto solo evita que el rechazo
 * llegue como un error interno, y sin la carrera de "leer si existe y después
 * insertar".
 */
export async function insertSerializedUnit(
  tx: TenantTx,
  input: InsertSerializedUnitInput,
): Promise<boolean> {
  const { count } = await tx.serialized_units.createMany({
    data: [
      {
        id: input.id,
        tenant_id: input.tenantId,
        variant_id: input.variantId,
        lot_id: input.lotId,
        serial_number: input.serialNumber,
        warranty_until: input.warrantyUntil,
        notes: input.notes,
      },
    ],
    skipDuplicates: true,
  });
  return count === 1;
}

export async function findSerializedUnitById(
  tx: TenantTx,
  id: string,
): Promise<SerializedUnitRow | null> {
  return tx.serialized_units.findFirst({ where: { id } });
}

export interface ListSerializedUnitsFilter {
  readonly serialNumber: string | undefined;
  readonly lotId: string | undefined;
  readonly variantId: string | undefined;
  readonly status: SerializedUnitRow["status"] | undefined;
  readonly cursorId: string | undefined;
  readonly limit: number;
}

export async function listSerializedUnits(
  tx: TenantTx,
  filter: ListSerializedUnitsFilter,
): Promise<SerializedUnitRow[]> {
  return tx.serialized_units.findMany({
    where: {
      serial_number: filter.serialNumber,
      lot_id: filter.lotId,
      variant_id: filter.variantId,
      status: filter.status,
    },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    ...(filter.cursorId && { cursor: { id: filter.cursorId }, skip: 1 }),
    take: filter.limit + 1,
  });
}

/** Movimientos que mencionan la unidad, en orden de ocurrencia. */
export async function listMovementsBySerialUnit(
  tx: TenantTx,
  serialUnitId: string,
): Promise<MovementRow[]> {
  return tx.inventory_movements.findMany({
    where: { serial_unit_id: serialUnitId },
    orderBy: [{ occurred_at: "asc" }, { id: "asc" }],
  });
}
