import type {
  AdminMovement,
  CreateAdjustmentInput,
  LotHistory,
  LotHistoryInput,
  StockAvailability,
  StockAvailabilityInput,
} from "@joda/contracts";
import { Money, Quantity, planInventoryAdjustment } from "@joda/domain";
import type { PrismaClient } from "@joda/db";
import { recordAuditEntry } from "../../db/audit.js";
import { withIdempotentTx } from "../../db/withIdempotentTx.js";
import { withTenantTx, type TenantTxContext } from "../../db/withTenantTx.js";
import { buildIdempotencyRequest } from "../../middleware/idempotency.js";
import { appError, toTRPCError } from "../../middleware/errorMapper.js";
import type { RequestContext } from "../../trpc/context.js";
import { toAdminLot, toAdminMovement, toStockAvailability } from "./mappers.js";
import * as repo from "./repository.js";

const NOT_FOUND_ERROR = appError("NOT_FOUND", 404, "No encontrado.");

/** Mismo criterio que requireStaffContext de modules/catalog/router.ts — acá vive en el service porque createAdjustment necesita además ip/userAgent/requestId de RequestContext, no solo el trío de TenantTxContext. */
function requireStaffContext(ctx: RequestContext): TenantTxContext {
  if (ctx.audience === "staff" && ctx.userId && ctx.tenantId) {
    return { userId: ctx.userId, tenantId: ctx.tenantId, audience: ctx.audience };
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
