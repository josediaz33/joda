import {
  DEFAULT_PAGE_SIZE,
  type AdminMovement,
  type AdminSerializedUnit,
  type CreateAdjustmentInput,
  type CreateSerializedUnitInput,
  type ListSerializedUnitsInput,
  type ListSerializedUnitsOutput,
  type LotHistory,
  type LotHistoryInput,
  type OpenLotInput,
  type OpenLotOutput,
  type SerializedUnitHistory,
  type SerializedUnitHistoryInput,
  type StockAvailability,
  type StockAvailabilityInput,
} from "@joda/contracts";
import {
  Money,
  Quantity,
  openLot as planLotOpening,
  planInventoryAdjustment,
  planSerializedUnitRegistration,
  type Clock,
  type IdGenerator,
  type LotOpening,
  type LotOpeningError,
  type LotOpeningMovement,
  type SerializedUnitRegistrationError,
} from "@joda/domain";
import type { PrismaClient } from "@joda/db";
import { recordAuditEntry } from "../../db/audit.js";
import { decodeCursor, encodeCursor } from "../../db/cursor.js";
import { withIdempotentTx } from "../../db/withIdempotentTx.js";
import { withTenantTx, type TenantTx, type TenantTxContext } from "../../db/withTenantTx.js";
import { buildIdempotencyRequest } from "../../middleware/idempotency.js";
import { appError, toTRPCError } from "../../middleware/errorMapper.js";
import type { RequestContext } from "../../trpc/context.js";
import {
  toAdminLot,
  toAdminMovement,
  toAdminSerializedUnit,
  toStockAvailability,
} from "./mappers.js";
import * as repo from "./repository.js";

const NOT_FOUND_ERROR = appError("NOT_FOUND", 404, "No encontrado.");

/** Mismo criterio que requireStaffContext de modules/catalog/router.ts — acá vive en el service porque createAdjustment necesita además ip/userAgent/requestId de RequestContext, no solo el trío de TenantTxContext. */
function requireStaffContext(ctx: RequestContext): TenantTxContext {
  if (ctx.audience === "staff" && ctx.userId && ctx.tenantId && ctx.sessionId) {
    return {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      audience: ctx.audience,
      sessionId: ctx.sessionId,
    };
  }
  throw toTRPCError(
    appError("UNAUTHENTICATED_SESSION_EXPIRED", 401, "Necesitás una sesión de personal."),
  );
}

// ---------------------------------------------------------------------
// Saldo — RF-INV-03.
// ---------------------------------------------------------------------
export async function getStockAvailability(
  db: PrismaClient,
  ctx: RequestContext,
  input: StockAvailabilityInput,
): Promise<StockAvailability> {
  const session = requireStaffContext(ctx);
  return withTenantTx(db, session, async (tx) => {
    if (!(await repo.variantExists(tx, input.variantId))) throw toTRPCError(NOT_FOUND_ERROR);
    const row = await repo.findStockAvailability(tx, input.variantId);
    return toStockAvailability(input.variantId, row);
  });
}

// ---------------------------------------------------------------------
// Historial de lote — RF-INV-05.
// ---------------------------------------------------------------------
export async function getLotHistory(
  db: PrismaClient,
  ctx: RequestContext,
  input: LotHistoryInput,
): Promise<LotHistory> {
  const session = requireStaffContext(ctx);
  return withTenantTx(db, session, async (tx) => {
    const lotRow = await repo.findLotWithBalance(tx, input.lotId);
    if (!lotRow) throw toTRPCError(NOT_FOUND_ERROR);

    const movementRows = await repo.listMovementsByLot(tx, input.lotId);
    return { lot: toAdminLot(lotRow), movements: movementRows.map(toAdminMovement) };
  });
}

// ---------------------------------------------------------------------
// Ajuste manual — RF-INV-04. ADR-007: corregir un error es INSERTAR un
// movimiento de ajuste, nunca editar el saldo ni un movimiento existente.
// ---------------------------------------------------------------------
const QTY_MUST_BE_INTEGER_ERROR = appError(
  "VALIDATION_QTY_MUST_BE_INTEGER",
  400,
  "Este lote se mide en unidades enteras; la cantidad del ajuste no puede tener decimales.",
);

function insufficientStockError(lotId: string, currentOnHand: number, qty: number) {
  return appError(
    "CONFLICT_INSUFFICIENT_STOCK",
    409,
    "El ajuste dejaría el saldo del lote en negativo.",
    { lotId, currentOnHand, qty },
  );
}

export async function createAdjustment(
  db: PrismaClient,
  ctx: RequestContext,
  input: CreateAdjustmentInput,
): Promise<AdminMovement> {
  const session = requireStaffContext(ctx);
  const idempotency = buildIdempotencyRequest(ctx.req, input);

  const { result } = await withIdempotentTx(db, session, idempotency, async (tx) => {
    const lot = await repo.findLotForAdjustment(tx, input.lotId);
    if (!lot) throw toTRPCError(NOT_FOUND_ERROR);

    if (lot.uom === "unit" && !Number.isInteger(input.qty)) {
      throw toTRPCError(QTY_MUST_BE_INTEGER_ERROR);
    }

    const delta = lot.uom === "unit" ? Quantity.units(input.qty) : Quantity.ml(input.qty);
    const currentOnHand = lot.uom === "unit" ? Quantity.units(lot.onHand) : Quantity.ml(lot.onHand);

    const plan = planInventoryAdjustment({
      lotId: lot.id,
      currentOnHand,
      delta,
      unitCost: Money.pyg(lot.unitLandedCostPyg),
    });

    if (!plan.ok) {
      throw toTRPCError(insufficientStockError(lot.id, lot.onHand, input.qty));
    }

    const movementId = await repo.insertAdjustmentMovement(tx, {
      tenantId: session.tenantId,
      lotId: lot.id,
      variantId: lot.variantId,
      qty: input.qty,
      uom: lot.uom,
      totalCostPyg: plan.value.totalCost?.minor ?? null,
      createdBy: session.userId,
      note: input.reason,
    });

    if (plan.value.costLayer) {
      await repo.insertCostAllocation(tx, {
        tenantId: session.tenantId,
        movementId,
        lotId: plan.value.costLayer.lotId,
        qty: plan.value.costLayer.qty.value,
        unitCostPyg: plan.value.costLayer.unitCost.minor,
        totalCostPyg: plan.value.costLayer.totalCost.minor,
      });
    }

    await recordAuditEntry(tx, {
      tenantId: session.tenantId,
      actorId: session.userId,
      audience: session.audience,
      action: "inventory.adjustment.create",
      entity: "inventory_movements",
      // `entity_id` es `uuid` (audit_log, packages/db/prisma/schema.prisma) —
      // inventory_movements.id es bigint identity, no representable ahí. El
      // id del movimiento va en `after` en vez de forzar un tipo que no le
      // corresponde.
      entityId: null,
      before: null,
      after: {
        movementId: movementId.toString(),
        lotId: lot.id,
        qty: String(input.qty),
        reason: input.reason,
      },
      ip: ctx.req.ip,
      userAgent: ctx.req.headers["user-agent"] ?? null,
      requestId: ctx.requestId,
    });

    const row = await repo.findMovementById(tx, movementId);
    if (!row)
      throw new Error(`movimiento ${movementId} no se pudo releer dentro de la misma transacción`);
    return { result: toAdminMovement(row), statusCode: 200 };
  });

  return result;
}

// ---------------------------------------------------------------------
// Apertura de frasco — RF-INV-08, RN-LOT-02, ADR-009 (WP-C11). Una
// CONVERSIÓN entre lotes, no un cambio de estado. El dominio decide qué se
// mueve (`openLot`, incluida la separación previa del caso borde 21); acá se
// lee, se bloquea y se persiste, todo en la misma transacción.
// ---------------------------------------------------------------------

/** Lo que el servicio de apertura necesita del entorno y no puede leer solo (.claude/rules/domain.md: reloj e ids entran por puerto). */
export interface InventoryServiceDeps {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

const LOT_NOT_SEALED_ERROR = appError(
  "CONFLICT_LOT_NOT_SEALED",
  409,
  "Solo se puede abrir un lote de una variante sellada.",
);

const BULK_VARIANT_MISSING_ERROR = appError(
  "CONFLICT_BULK_VARIANT_MISSING",
  409,
  "El producto no tiene una variante de granel. Creala en el catálogo antes de abrir un frasco.",
);

const NOMINAL_VOLUME_MISSING_ERROR = appError(
  "CONFLICT_NOMINAL_VOLUME_MISSING",
  409,
  "El producto no tiene volumen nominal: no se puede calcular el granel del frasco.",
);

function openingError(error: LotOpeningError) {
  switch (error.code) {
    case "SEALED_LOT_NOT_OPENABLE":
      return appError(
        "CONFLICT_LOT_NOT_OPENABLE",
        409,
        "Este lote no se puede abrir: ya fue abierto o no está disponible.",
        { status: error.status },
      );
    case "SEALED_LOT_WITHOUT_STOCK":
      return appError("CONFLICT_INSUFFICIENT_STOCK", 409, "El lote no tiene frascos para abrir.", {
        onHand: error.onHand.value,
      });
    case "SEALED_VARIANT_NOT_AVAILABLE":
      return appError(
        "CONFLICT_INSUFFICIENT_STOCK",
        409,
        "No hay frascos disponibles de esta variante: los que quedan están reservados.",
        { available: error.available.value },
      );
  }
}

/** RN-LOT-02 y caso borde 21: la apertura abre UNA unidad; si el lote tiene varias, separa primero esa unidad en su propio lote. */
export async function openLot(
  db: PrismaClient,
  deps: InventoryServiceDeps,
  ctx: RequestContext,
  input: OpenLotInput,
): Promise<OpenLotOutput> {
  const session = requireStaffContext(ctx);
  const idempotency = buildIdempotencyRequest(ctx.req, input);

  const { result } = await withIdempotentTx(db, session, idempotency, async (tx) => {
    // Bloquea el lote y lo lee: dos aperturas del mismo lote se serializan
    // acá, y la segunda ve `open_for_decant` (caso borde 5).
    const lot = await repo.findLotForOpening(tx, input.lotId);
    if (!lot) throw toTRPCError(NOT_FOUND_ERROR);
    if (lot.product_variants.variant_type !== "sealed") throw toTRPCError(LOT_NOT_SEALED_ERROR);

    const productId = lot.product_variants.product_id;
    // A lo sumo una por producto: lo impone el índice único parcial de 0028.
    const [bulkVariantId] = await repo.findBulkVariantIds(tx, productId);
    if (bulkVariantId === undefined) throw toTRPCError(BULK_VARIANT_MISSING_ERROR);
    const nominalVolumeMl = await repo.findNominalVolumeMl(tx, productId);
    if (nominalVolumeMl === null) throw toTRPCError(NOMINAL_VOLUME_MISSING_ERROR);

    // Aceptado hasta WP-C18: esta lectura NO bloquea la variante, solo el lote.
    // Dos aperturas de lotes distintos de la misma variante, con el último
    // frasco reservado, podrían pasar las dos. Hoy no hay hueco real:
    // `stock_reservations` está vacía hasta C18, que decide cómo se serializa
    // esto (bloquear la fila de la variante, o atar la reserva a un lote).
    // Bloquear la variante acá, sin ese diseño, podría cruzarse con el orden
    // de bloqueo de lotes de la venta (RN-LOT-05, WP-C19).
    const availability = toStockAvailability(
      lot.variant_id,
      await repo.findStockAvailability(tx, lot.variant_id),
    );

    const plan = planLotOpening({
      sealedLot: {
        id: lot.id,
        status: lot.status,
        qtyInitial: Quantity.units(lot.qty_initial.toNumber()),
        onHand: Quantity.units(lot.inventory_balances?.on_hand.toNumber() ?? 0),
        unitLandedCostPyg: Money.pyg(lot.unit_landed_cost_pyg),
      },
      nominalVolumeMl,
      variantAvailable: Quantity.units(availability.available),
      clock: deps.clock,
      idGenerator: deps.idGenerator,
    });
    if (!plan.ok) throw toTRPCError(openingError(plan.error));
    const opening = plan.value;

    const movementIds = await persistOpening(tx, session, lot, bulkVariantId, opening);

    await recordAuditEntry(tx, {
      tenantId: session.tenantId,
      actorId: session.userId,
      audience: session.audience,
      action: "inventory.lot.open",
      entity: "inventory_lots",
      entityId: opening.sealedLotId,
      before: { lotId: lot.id, status: lot.status },
      after: {
        sourceLotId: opening.separation ? lot.id : null,
        openedSealedLotId: opening.sealedLotId,
        bulkLotId: opening.bulkLot.id,
        bulkQtyMl: String(opening.bulkLot.qtyInitial.value),
        unitLandedCostPyg: opening.bulkLot.landedCostPyg.minor.toString(),
      },
      ip: ctx.req.ip,
      userAgent: ctx.req.headers["user-agent"] ?? null,
      requestId: ctx.requestId,
    });

    return { result: await buildOpenLotOutput(tx, lot.id, opening, movementIds), statusCode: 200 };
  });

  return result;
}

/**
 * Escribe la apertura en el orden de RN-LOT-02: la unidad SALE del lote
 * (con su capa de costo) antes de que el sellado cambie de estado — un
 * sellado abierto no admite movimientos (RN-LOT-03) — y el granel NACE antes
 * de recibir su entrada. Devuelve los ids de los movimientos, en ese orden.
 */
async function persistOpening(
  tx: TenantTx,
  session: TenantTxContext,
  lot: repo.LotForOpeningRow,
  bulkVariantId: string,
  opening: LotOpening,
): Promise<bigint[]> {
  const inherited = {
    tenantId: session.tenantId,
    unitCostMinor: lot.unit_cost_minor,
    currency: lot.currency,
    fxRateToPyg: lot.fx_rate_to_pyg,
    batchCode: lot.batch_code,
    manufacturedAt: lot.manufactured_at,
    expiryAt: lot.expiry_at,
  };
  const movementIds: bigint[] = [];

  async function recordMovement(movement: LotOpeningMovement): Promise<void> {
    const isBulk = movement.lotId === opening.bulkLot.id;
    const movementId = await repo.insertTransferMovement(tx, {
      tenantId: session.tenantId,
      lotId: movement.lotId,
      variantId: isBulk ? bulkVariantId : lot.variant_id,
      qty: movement.qty.value,
      uom: movement.qty.uom,
      movementType: movement.movementType,
      totalCostPyg: movement.totalCost.minor,
      referenceType: movement.purpose === "separation" ? "lot_separation" : "lot_opening",
      referenceId:
        movement.purpose === "separation" && opening.separation
          ? opening.separation.unitLot.id
          : opening.sealedLotId,
      createdBy: session.userId,
    });
    movementIds.push(movementId);
    if (movement.costLayer) {
      await repo.insertCostAllocation(tx, {
        tenantId: session.tenantId,
        movementId,
        lotId: movement.costLayer.lotId,
        qty: movement.costLayer.qty.value,
        unitCostPyg: movement.costLayer.unitCost.minor,
        totalCostPyg: movement.costLayer.totalCost.minor,
      });
    }
  }

  if (opening.separation) {
    const { unitLot } = opening.separation;
    await repo.insertDerivedLot(tx, unitLot.id, {
      ...inherited,
      variantId: lot.variant_id,
      parentLotId: unitLot.parentLotId,
      status: "available",
      qtyInitial: unitLot.qtyInitial.value,
      uom: "unit",
      landedCostPyg: unitLot.landedCostPyg.minor,
      unitLandedCostPyg: unitLot.unitLandedCostPyg.minor,
      openedAt: null,
      // Conserva la antigüedad del lote original: FIFO no lo trata como más nuevo.
      receivedAt: lot.received_at,
    });
  }

  for (const movement of opening.movements.filter((m) => m.lotId !== opening.bulkLot.id)) {
    await recordMovement(movement);
  }

  await repo.markLotOpenForDecant(tx, opening.sealedLotId, opening.openedAt);
  await repo.insertDerivedLot(tx, opening.bulkLot.id, {
    ...inherited,
    variantId: bulkVariantId,
    parentLotId: opening.bulkLot.parentLotId,
    status: "open_for_decant",
    qtyInitial: opening.bulkLot.qtyInitial.value,
    uom: "ml",
    landedCostPyg: opening.bulkLot.landedCostPyg.minor,
    unitLandedCostPyg: opening.bulkLot.unitLandedCostPyg.minor,
    openedAt: opening.openedAt,
    receivedAt: opening.openedAt,
  });

  for (const movement of opening.movements.filter((m) => m.lotId === opening.bulkLot.id)) {
    await recordMovement(movement);
  }

  return movementIds;
}

/** Relee lo escrito dentro de la misma transacción, con su saldo ya proyectado por los triggers. */
async function buildOpenLotOutput(
  tx: TenantTx,
  originalLotId: string,
  opening: LotOpening,
  movementIds: bigint[],
): Promise<OpenLotOutput> {
  const [sourceRow, openedRow, bulkRow] = await Promise.all([
    opening.separation ? repo.findLotWithBalance(tx, originalLotId) : Promise.resolve(null),
    repo.findLotWithBalance(tx, opening.sealedLotId),
    repo.findLotWithBalance(tx, opening.bulkLot.id),
  ]);
  if (!openedRow || !bulkRow || (opening.separation && !sourceRow)) {
    throw new Error(
      "los lotes de la apertura no se pudieron releer dentro de la misma transacción",
    );
  }
  const movementRows = await repo.findMovementsByIds(tx, movementIds);
  return {
    sourceLot: sourceRow ? toAdminLot(sourceRow) : null,
    openedSealedLot: toAdminLot(openedRow),
    bulkLot: toAdminLot(bulkRow),
    movements: movementRows.map(toAdminMovement),
  };
}

// ---------------------------------------------------------------------
// Unidades serializadas — RF-INV-10, RN-SER-01…04 (WP-C12). Alta,
// consulta y trazabilidad. El consumo al vender es WP-C19 (RN-VTA-04).
// ---------------------------------------------------------------------
const VARIANT_NOT_SERIALIZED_ERROR = appError(
  "CONFLICT_VARIANT_NOT_SERIALIZED",
  409,
  "La variante de este lote no es serializada: no lleva unidades con número de serie.",
);

const SERIAL_DUPLICATE_ERROR = appError(
  "CONFLICT_SERIAL_DUPLICATE",
  409,
  "Ya existe una unidad con ese número de serie.",
);

const INVALID_CURSOR_ERROR = appError(
  "VALIDATION_INVALID_CURSOR",
  400,
  "El cursor de paginación no es válido.",
);

function serialRegistrationError(error: SerializedUnitRegistrationError) {
  switch (error.code) {
    case "VARIANT_NOT_SERIALIZED":
      return VARIANT_NOT_SERIALIZED_ERROR;
    case "LOT_SERIAL_CAPACITY_EXCEEDED":
      return appError(
        "CONFLICT_LOT_SERIAL_CAPACITY",
        409,
        "El lote ya tiene registradas todas sus unidades.",
        { capacity: error.capacity.value, registered: error.registered },
      );
  }
}

/**
 * RN-SER-02 y RN-SER-03. La unidad es de la variante de su lote (RN-SER-04):
 * la deriva el servidor, no se acepta del cliente. El lote se bloquea ANTES
 * de contar las unidades registradas: sin eso, dos altas simultáneas ven "2
 * de 3" y registran la cuarta.
 */
export async function createSerializedUnit(
  db: PrismaClient,
  deps: InventoryServiceDeps,
  ctx: RequestContext,
  input: CreateSerializedUnitInput,
): Promise<AdminSerializedUnit> {
  const session = requireStaffContext(ctx);
  const idempotency = buildIdempotencyRequest(ctx.req, input);

  const { result } = await withIdempotentTx(db, session, idempotency, async (tx) => {
    const lot = await repo.findLotForSerialRegistration(tx, input.lotId);
    if (!lot) throw toTRPCError(NOT_FOUND_ERROR);

    const registeredCount = await repo.countSerializedUnitsOfLot(tx, lot.id);
    const plan = planSerializedUnitRegistration({
      variantIsSerialized: lot.product_variants.is_serialized,
      // Un lote en `ml` no tiene variante serializada (CHECK de product_variants):
      // llega acá solo para que el dominio lo rechace como VARIANT_NOT_SERIALIZED.
      lotQtyInitial:
        lot.uom === "unit"
          ? Quantity.units(lot.qty_initial.toNumber())
          : Quantity.ml(lot.qty_initial.toNumber()),
      registeredCount,
    });
    if (!plan.ok) throw toTRPCError(serialRegistrationError(plan.error));

    const id = deps.idGenerator.next();
    const created = await repo.insertSerializedUnit(tx, {
      id,
      tenantId: session.tenantId,
      variantId: lot.variant_id,
      lotId: lot.id,
      serialNumber: input.serialNumber,
      warrantyUntil: input.warrantyUntil ? new Date(`${input.warrantyUntil}T00:00:00.000Z`) : null,
      notes: input.notes ?? null,
    });
    if (!created) throw toTRPCError(SERIAL_DUPLICATE_ERROR);

    await recordAuditEntry(tx, {
      tenantId: session.tenantId,
      actorId: session.userId,
      audience: session.audience,
      action: "inventory.serial.create",
      entity: "serialized_units",
      entityId: id,
      before: null,
      after: {
        lotId: lot.id,
        variantId: lot.variant_id,
        serialNumber: input.serialNumber,
        warrantyUntil: input.warrantyUntil ?? null,
      },
      ip: ctx.req.ip,
      userAgent: ctx.req.headers["user-agent"] ?? null,
      requestId: ctx.requestId,
    });

    const row = await repo.findSerializedUnitById(tx, id);
    if (!row) throw new Error(`unidad ${id} no se pudo releer dentro de la misma transacción`);
    return { result: toAdminSerializedUnit(row), statusCode: 200 };
  });

  return result;
}

export async function listSerializedUnits(
  db: PrismaClient,
  ctx: RequestContext,
  input: ListSerializedUnitsInput,
): Promise<ListSerializedUnitsOutput> {
  const session = requireStaffContext(ctx);
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  let cursorId: string | undefined;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor);
    if (decoded === null) throw toTRPCError(INVALID_CURSOR_ERROR);
    cursorId = decoded;
  }

  return withTenantTx(db, session, async (tx) => {
    const rows = await repo.listSerializedUnits(tx, {
      serialNumber: input.serialNumber,
      lotId: input.lotId,
      variantId: input.variantId,
      status: input.status,
      cursorId,
      limit,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = page.at(-1);
    return {
      items: page.map(toAdminSerializedUnit),
      nextCursor: hasMore && lastRow ? encodeCursor(lastRow.id) : null,
    };
  });
}

/** Trazabilidad de una unidad: sus datos y todos los movimientos que la mencionan. */
export async function getSerializedUnitHistory(
  db: PrismaClient,
  ctx: RequestContext,
  input: SerializedUnitHistoryInput,
): Promise<SerializedUnitHistory> {
  const session = requireStaffContext(ctx);
  return withTenantTx(db, session, async (tx) => {
    const unit = await repo.findSerializedUnitById(tx, input.serialUnitId);
    if (!unit) throw toTRPCError(NOT_FOUND_ERROR);

    const movementRows = await repo.listMovementsBySerialUnit(tx, unit.id);
    return { unit: toAdminSerializedUnit(unit), movements: movementRows.map(toAdminMovement) };
  });
}
