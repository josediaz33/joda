import {
  DEFAULT_PAGE_SIZE,
  type CreatePurchaseOrderInput,
  type CreateSupplierInput,
  type PurchaseOrderDto,
  type SupplierDto,
  type TransitionPurchaseOrderInput,
  type UpdateSupplierInput,
} from "@joda/contracts";
import { transitionPurchaseOrder, type PoStatus } from "@joda/domain";
import type { PrismaClient } from "@joda/db";
import { recordAuditEntry } from "../../db/audit.js";
import { decodeCursor, encodeCursor } from "../../db/cursor.js";
import { withTenantTx, type TenantTx, type TenantTxContext } from "../../db/withTenantTx.js";
import { appError, hasSqlState, toTRPCError } from "../../middleware/errorMapper.js";
import { toPurchaseOrder, toSupplier } from "./mappers.js";
import * as repo from "./repository.js";

export interface MarketContext extends TenantTxContext {
  readonly auditMeta: {
    readonly ip: string | null;
    readonly userAgent: string | null;
    readonly requestId: string | null;
  };
}

const NOT_FOUND = appError("NOT_FOUND", 404, "No encontrado.");
const FORBIDDEN_ACTION = appError(
  "FORBIDDEN_INSUFFICIENT_PERMISSION",
  403,
  "No tenés permiso para realizar esta acción.",
);
const invalidCursor = appError(
  "VALIDATION_INVALID_CURSOR",
  400,
  "El cursor de paginación no es válido.",
);

function cursorId(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  const id = decodeCursor(cursor);
  if (!id) throw toTRPCError(invalidCursor);
  return id;
}

function page<Row extends { id: string }, Dto>(rows: Row[], limit: number, map: (row: Row) => Dto) {
  const selected = rows.slice(0, limit);
  return {
    items: selected.map(map),
    nextCursor: rows.length > limit ? encodeCursor(selected.at(-1)!.id) : null,
  };
}

async function audit(
  tx: TenantTx,
  ctx: MarketContext,
  action: string,
  entity: string,
  entityId: string,
  before: Record<string, string | number | boolean | null> | null,
  after: Record<string, string | number | boolean | null> | null,
) {
  await recordAuditEntry(tx, {
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    audience: ctx.audience,
    action,
    entity,
    entityId,
    before,
    after,
    ip: ctx.auditMeta.ip,
    userAgent: ctx.auditMeta.userAgent,
    requestId: ctx.auditMeta.requestId,
  });
}

function supplierAuditState(row: repo.SupplierRow) {
  return {
    code: row.code,
    name: row.name,
    country: row.country,
    defaultCurrency: row.default_currency,
    paymentTermsDays: row.payment_terms_days,
    leadTimeDays: row.lead_time_days,
    isActive: row.is_active,
    notes: row.notes,
  };
}

export async function listSuppliers(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: { cursor?: string; limit?: number; isActive?: boolean },
) {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  const cursor = cursorId(input.cursor);
  return withTenantTx(db, ctx, async (tx) =>
    page(
      await repo.listSuppliers(tx, {
        tenantId: ctx.tenantId,
        cursor,
        limit,
        isActive: input.isActive,
      }),
      limit,
      toSupplier,
    ),
  );
}

export async function getSupplier(
  db: PrismaClient,
  ctx: TenantTxContext,
  id: string,
): Promise<SupplierDto> {
  return withTenantTx(db, ctx, async (tx) => {
    const row = await repo.findSupplier(tx, ctx.tenantId, id);
    if (!row) throw toTRPCError(NOT_FOUND);
    return toSupplier(row);
  });
}

export async function createSupplier(
  db: PrismaClient,
  ctx: MarketContext,
  input: CreateSupplierInput,
): Promise<SupplierDto> {
  return withTenantTx(db, ctx, async (tx) => {
    const row = await repo.createSupplier(tx, {
      tenant_id: ctx.tenantId,
      code: input.code,
      name: input.name,
      country: input.country ?? null,
      default_currency: input.defaultCurrency,
      payment_terms_days: input.paymentTermsDays,
      lead_time_days: input.leadTimeDays ?? null,
      notes: input.notes ?? null,
    });
    await audit(
      tx,
      ctx,
      "market.supplier.create",
      "suppliers",
      row.id,
      null,
      supplierAuditState(row),
    );
    return toSupplier(row);
  });
}

export async function updateSupplier(
  db: PrismaClient,
  ctx: MarketContext,
  input: UpdateSupplierInput,
): Promise<SupplierDto> {
  return withTenantTx(db, ctx, async (tx) => {
    await repo.lockSupplier(tx, ctx.tenantId, input.id);
    const before = await repo.findSupplier(tx, ctx.tenantId, input.id);
    if (!before) throw toTRPCError(NOT_FOUND);
    const row = await repo.updateSupplier(tx, ctx.tenantId, input.id, {
      code: input.code,
      name: input.name,
      country: input.country,
      default_currency: input.defaultCurrency,
      payment_terms_days: input.paymentTermsDays,
      lead_time_days: input.leadTimeDays,
      is_active: input.isActive,
      notes: input.notes,
    });
    await audit(
      tx,
      ctx,
      "market.supplier.update",
      "suppliers",
      row.id,
      supplierAuditState(before),
      supplierAuditState(row),
    );
    return toSupplier(row);
  });
}

export async function listOrders(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: { cursor?: string; limit?: number; supplierId?: string; status?: PoStatus },
) {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  const cursor = cursorId(input.cursor);
  return withTenantTx(db, ctx, async (tx) =>
    page(
      await repo.listOrders(tx, {
        tenantId: ctx.tenantId,
        cursor,
        limit,
        supplierId: input.supplierId,
        status: input.status,
      }),
      limit,
      toPurchaseOrder,
    ),
  );
}

export async function getOrder(
  db: PrismaClient,
  ctx: TenantTxContext,
  id: string,
): Promise<PurchaseOrderDto> {
  return withTenantTx(db, ctx, async (tx) => {
    const row = await repo.findOrder(tx, ctx.tenantId, id);
    if (!row) throw toTRPCError(NOT_FOUND);
    return toPurchaseOrder(row);
  });
}

export async function createOrder(
  db: PrismaClient,
  ctx: MarketContext,
  input: CreatePurchaseOrderInput,
): Promise<PurchaseOrderDto> {
  return withTenantTx(db, ctx, async (tx) => {
    const supplier = await repo.findSupplier(tx, ctx.tenantId, input.supplierId);
    if (!supplier || !supplier.is_active)
      throw toTRPCError(
        appError("VALIDATION_SUPPLIER_UNAVAILABLE", 400, "El proveedor no está disponible."),
      );
    const variants = await repo.findVariants(tx, ctx.tenantId, [
      ...new Set(input.lines.map((line) => line.variantId)),
    ]);
    if (variants.length !== new Set(input.lines.map((line) => line.variantId)).size) {
      throw toTRPCError(
        appError("VALIDATION_VARIANT_UNAVAILABLE", 400, "Una variante no está disponible."),
      );
    }
    const uomById = new Map(variants.map((variant) => [variant.id, variant.uom]));
    for (const line of input.lines) {
      if (
        uomById.get(line.variantId) !== line.uom ||
        (line.uom === "unit" && !/^\d+$/.test(line.qtyOrdered))
      ) {
        throw toTRPCError(
          appError(
            "VALIDATION_LINE_UOM",
            400,
            "La unidad o cantidad de una línea no coincide con la variante.",
          ),
        );
      }
    }
    const id = await repo.createOrder(
      tx,
      {
        tenant_id: ctx.tenantId,
        supplier_id: input.supplierId,
        code: input.code,
        status: "draft",
        currency: input.currency,
        fx_rate_to_pyg: input.fxRateToPyg ?? null,
        freight_minor: BigInt(input.freightMinor ?? "0"),
        customs_minor: BigInt(input.customsMinor ?? "0"),
        other_costs_minor: BigInt(input.otherCostsMinor ?? "0"),
        freight_method: input.freightMethod ?? "by_value",
        expected_at: input.expectedAt ? new Date(`${input.expectedAt}T00:00:00.000Z`) : null,
        notes: input.notes ?? null,
        created_by: ctx.userId,
      },
      input.lines.map((line, position) => ({
        tenant_id: ctx.tenantId,
        variant_id: line.variantId,
        qty_ordered: line.qtyOrdered,
        uom: line.uom,
        unit_price_minor: BigInt(line.unitPriceMinor),
        destination: line.destination ?? null,
        position,
      })),
    );
    await audit(tx, ctx, "market.purchaseOrder.create", "purchase_orders", id, null, {
      status: "draft",
      code: input.code,
      supplierId: input.supplierId,
      currency: input.currency,
      lineCount: input.lines.length,
    });
    const row = await repo.findOrder(tx, ctx.tenantId, id);
    if (!row) throw new Error("orden recién creada no se pudo releer");
    return toPurchaseOrder(row);
  });
}

export async function removeOrder(db: PrismaClient, ctx: MarketContext, id: string): Promise<void> {
  return withTenantTx(db, ctx, async (tx) => {
    await repo.lockOrder(tx, ctx.tenantId, id);
    const before = await repo.findOrder(tx, ctx.tenantId, id);
    if (!before) throw toTRPCError(NOT_FOUND);
    if (before.status !== "draft") {
      throw toTRPCError(
        appError(
          "CONFLICT_PURCHASE_ORDER_NOT_DRAFT",
          409,
          "Solo se puede borrar una orden en borrador.",
        ),
      );
    }
    try {
      const affectedRows = await repo.removeOrder(tx, ctx.tenantId, id);
      // RLS puede ocultar la fila al DELETE aunque se haya leído y bloqueado
      // con :read/:approve. Sin una fila borrada no existe efecto que auditar.
      if (affectedRows !== 1) throw toTRPCError(FORBIDDEN_ACTION);
    } catch (error) {
      if (hasSqlState(error, "23001")) {
        throw toTRPCError(
          appError(
            "CONFLICT_PURCHASE_ORDER_HISTORY",
            409,
            "La orden tiene historial de aprobación; hay que cancelarla.",
          ),
        );
      }
      throw error;
    }
    await audit(
      tx,
      ctx,
      "market.purchaseOrder.remove",
      "purchase_orders",
      id,
      {
        status: before.status,
        code: before.code,
        supplierId: before.supplier_id,
        currency: before.currency,
        lineCount: before.purchase_order_lines.length,
      },
      null,
    );
  });
}

export async function transitionOrder(
  db: PrismaClient,
  ctx: MarketContext,
  input:
    TransitionPurchaseOrderInput | { id: string; toStatus: "approved"; reason?: string | null },
  action:
    | "market.purchaseOrder.transition"
    | "market.purchaseOrder.approve" = "market.purchaseOrder.transition",
): Promise<PurchaseOrderDto> {
  return withTenantTx(db, ctx, async (tx) => {
    await repo.lockOrder(tx, ctx.tenantId, input.id);
    const before = await repo.findOrder(tx, ctx.tenantId, input.id);
    if (!before) throw toTRPCError(NOT_FOUND);
    const result = transitionPurchaseOrder(before.status, input.toStatus);
    if (!result.ok) {
      throw toTRPCError(
        appError(
          "CONFLICT_INVALID_TRANSITION",
          409,
          `La orden no puede pasar de ${result.error.from} a ${result.error.to}.`,
          { from: result.error.from, to: result.error.to },
        ),
      );
    }
    const updated = await repo.updateOrderStatus(tx, ctx.tenantId, input.id, {
      status: result.value,
      ...(result.value === "approved" && { approval: { actorId: ctx.userId, at: new Date() } }),
    });
    if (!updated) throw toTRPCError(FORBIDDEN_ACTION);
    await repo.insertTransition(tx, {
      tenant_id: ctx.tenantId,
      purchase_order_id: input.id,
      from_status: before.status,
      to_status: result.value,
      actor_id: ctx.userId,
      reason: input.reason ?? null,
    });
    await audit(
      tx,
      ctx,
      action,
      "purchase_orders",
      input.id,
      {
        status: before.status,
        approvedBy: before.approved_by,
        approvedAt: before.approved_at?.toISOString() ?? null,
      },
      {
        status: updated.status,
        approvedBy: updated.approved_by,
        approvedAt: updated.approved_at?.toISOString() ?? null,
      },
    );
    const row = await repo.findOrder(tx, ctx.tenantId, input.id);
    if (!row) throw new Error("orden actualizada no se pudo releer");
    return toPurchaseOrder(row);
  });
}
