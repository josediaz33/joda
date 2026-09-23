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
import { appError, toTRPCError } from "../../middleware/errorMapper.js";
import { toPurchaseOrder, toSupplier } from "./mappers.js";
import * as repo from "./repository.js";

const NOT_FOUND = appError("NOT_FOUND", 404, "No encontrado.");
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
  ctx: TenantTxContext,
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
    ip: null,
    userAgent: null,
    requestId: null,
  });
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
      await repo.listSuppliers(tx, { cursor, limit, isActive: input.isActive }),
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
    const row = await repo.findSupplier(tx, id);
    if (!row) throw toTRPCError(NOT_FOUND);
    return toSupplier(row);
  });
}

export async function createSupplier(
  db: PrismaClient,
  ctx: TenantTxContext,
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
    await audit(tx, ctx, "market.supplier.create", "suppliers", row.id, null, {
      code: row.code,
      name: row.name,
      defaultCurrency: row.default_currency,
      paymentTermsDays: row.payment_terms_days,
      leadTimeDays: row.lead_time_days,
    });
    return toSupplier(row);
  });
}

export async function updateSupplier(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: UpdateSupplierInput,
): Promise<SupplierDto> {
  return withTenantTx(db, ctx, async (tx) => {
    const before = await repo.findSupplier(tx, input.id);
    if (!before) throw toTRPCError(NOT_FOUND);
    const row = await repo.updateSupplier(tx, input.id, {
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
      {
        code: before.code,
        name: before.name,
        defaultCurrency: before.default_currency,
        paymentTermsDays: before.payment_terms_days,
        leadTimeDays: before.lead_time_days,
        isActive: before.is_active,
      },
      {
        code: row.code,
        name: row.name,
        defaultCurrency: row.default_currency,
        paymentTermsDays: row.payment_terms_days,
        leadTimeDays: row.lead_time_days,
        isActive: row.is_active,
      },
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
    const row = await repo.findOrder(tx, id);
    if (!row) throw toTRPCError(NOT_FOUND);
    return toPurchaseOrder(row);
  });
}

export async function createOrder(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: CreatePurchaseOrderInput,
): Promise<PurchaseOrderDto> {
  return withTenantTx(db, ctx, async (tx) => {
    const supplier = await repo.findSupplier(tx, input.supplierId);
    if (!supplier || !supplier.is_active)
      throw toTRPCError(
        appError("VALIDATION_SUPPLIER_UNAVAILABLE", 400, "El proveedor no está disponible."),
      );
    const variants = await repo.findVariants(tx, [
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
    await repo.insertTransition(tx, {
      tenant_id: ctx.tenantId,
      purchase_order_id: id,
      from_status: null,
      to_status: "draft",
      actor_id: ctx.userId,
    });
    await audit(tx, ctx, "market.purchaseOrder.create", "purchase_orders", id, null, {
      status: "draft",
      code: input.code,
      supplierId: input.supplierId,
      currency: input.currency,
      lineCount: input.lines.length,
    });
    const row = await repo.findOrder(tx, id);
    if (!row) throw new Error("orden recién creada no se pudo releer");
    return toPurchaseOrder(row);
  });
}

export async function transitionOrder(
  db: PrismaClient,
  ctx: TenantTxContext,
  input:
    TransitionPurchaseOrderInput | { id: string; toStatus: "approved"; reason?: string | null },
  action:
    | "market.purchaseOrder.transition"
    | "market.purchaseOrder.approve" = "market.purchaseOrder.transition",
): Promise<PurchaseOrderDto> {
  return withTenantTx(db, ctx, async (tx) => {
    await repo.lockOrder(tx, input.id);
    const before = await repo.findOrder(tx, input.id);
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
    await repo.updateOrderStatus(tx, input.id, {
      status: result.value,
      ...(result.value === "approved" && { approved_by: ctx.userId, approved_at: new Date() }),
    });
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
      { status: before.status },
      { status: result.value },
    );
    const row = await repo.findOrder(tx, input.id);
    if (!row) throw new Error("orden actualizada no se pudo releer");
    return toPurchaseOrder(row);
  });
}
