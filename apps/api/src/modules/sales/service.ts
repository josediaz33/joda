import {
  DEFAULT_PAGE_SIZE,
  type CreateSaleOrderInput,
  type SaleOrderDto,
  type TransitionSaleOrderInput,
} from "@joda/contracts";
import {
  Money,
  priceSaleOrder,
  Quantity,
  transitionSaleOrder,
  type Clock,
  type SaleOrderPricingError,
  type SaleOrderStatus,
} from "@joda/domain";
import type { PrismaClient } from "@joda/db";
import { recordAuditEntry } from "../../db/audit.js";
import { decodeCursor, encodeCursor } from "../../db/cursor.js";
import { withTenantTx, type TenantTx, type TenantTxContext } from "../../db/withTenantTx.js";
import {
  appError,
  isPrismaKnownError,
  toTRPCError,
  type ApiError,
} from "../../middleware/errorMapper.js";
import { toSaleOrder } from "./mappers.js";
import * as repo from "./repository.js";

export interface SalesContext extends TenantTxContext {
  readonly auditMeta: {
    readonly ip: string | null;
    readonly userAgent: string | null;
    readonly requestId: string | null;
  };
}

/** El reloj entra por parámetro: `placed_at`, `occurred_at` y el año del código no leen la hora de la máquina. */
export interface SalesServiceDeps {
  readonly clock: Clock;
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
  ctx: SalesContext,
  action: string,
  entityId: string,
  before: Record<string, string | number | boolean | null> | null,
  after: Record<string, string | number | boolean | null> | null,
) {
  await recordAuditEntry(tx, {
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    audience: ctx.audience,
    action,
    entity: "sale_orders",
    entityId,
    before,
    after,
    ip: ctx.auditMeta.ip,
    userAgent: ctx.auditMeta.userAgent,
    requestId: ctx.auditMeta.requestId,
  });
}

/** El año del código es el de la fecha comercial de Paraguay, no el de UTC: un pedido del 31 de diciembre a la noche no es del año siguiente. */
const ASUNCION_YEAR = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Asuncion",
  year: "numeric",
});

function validation(code: string, message: string, details?: Record<string, unknown>): never {
  throw toTRPCError(appError(code, 400, message, details));
}

function pricingFailure(error: SaleOrderPricingError): ApiError {
  if (error.code === "NEGATIVE_TOTAL") {
    return appError(
      "VALIDATION_DISCOUNT_EXCEEDS_TOTAL",
      400,
      "El descuento no puede ser mayor al subtotal del pedido.",
      {
        subtotalPyg: error.subtotalPyg.minor.toString(),
        discountPyg: error.discountPyg.minor.toString(),
      },
    );
  }
  return appError(
    "VALIDATION_ORDER_TOO_LARGE",
    400,
    "El pedido supera el importe máximo permitido.",
    { subtotalPyg: error.subtotalPyg.minor.toString() },
  );
}

export async function listOrders(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: { cursor?: string; limit?: number; status?: SaleOrderStatus; customerId?: string },
) {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  const cursor = cursorId(input.cursor);
  return withTenantTx(db, ctx, async (tx) =>
    page(
      await repo.listOrders(tx, {
        tenantId: ctx.tenantId,
        cursor,
        limit,
        status: input.status,
        customerId: input.customerId,
      }),
      limit,
      toSaleOrder,
    ),
  );
}

export async function getOrder(
  db: PrismaClient,
  ctx: TenantTxContext,
  id: string,
): Promise<SaleOrderDto> {
  return withTenantTx(db, ctx, async (tx) => {
    const row = await repo.findOrder(tx, ctx.tenantId, id);
    if (!row) throw toTRPCError(NOT_FOUND);
    return toSaleOrder(row);
  });
}

/**
 * Crea el pedido en `draft` (RN-EST-02). No toca inventario ni reservas
 * (RN-VTA-02): consumir es de WP-C19, reservar de WP-C18.
 *
 * La creación NO registra una transición `null → draft`. `sale_order_transitions`
 * es append-only y su FK al pedido es `ON DELETE CASCADE`: con esa fila, borrar
 * el borrador fallaría siempre (23001), y la política de DELETE de 0034 existe
 * justamente para borrarlo. Es la misma resolución que WP-C14 dio a las órdenes
 * de compra. La creación queda en `audit_log`; el historial de transiciones
 * empieza cuando el pedido sale de `draft`, y un borrador nunca tiene
 * (`trg_so_no_return_to_draft`, 0034: no se vuelve a `draft`).
 */
export async function createOrder(
  db: PrismaClient,
  ctx: SalesContext,
  input: CreateSaleOrderInput,
  deps: SalesServiceDeps,
): Promise<SaleOrderDto> {
  return withTenantTx(db, ctx, async (tx) => {
    // Los ids que llegan del cliente se leen primero bajo RLS (api.md,
    // "Verificación de pertenencia"): la FK de Postgres no evalúa RLS.
    const channel = await repo.findChannel(tx, ctx.tenantId, input.channelId);
    if (!channel?.is_active) {
      validation("VALIDATION_CHANNEL_UNAVAILABLE", "El canal de venta no está disponible.");
    }
    if (input.customerId) {
      const customer = await repo.findCustomer(tx, ctx.tenantId, input.customerId);
      if (!customer?.is_active) {
        validation("VALIDATION_CUSTOMER_UNAVAILABLE", "El cliente no está disponible.");
      }
    }

    const variantIds = [...new Set(input.lines.map((line) => line.variantId))];
    const variants = await repo.findVariants(tx, ctx.tenantId, variantIds);
    if (variants.length !== variantIds.length) {
      validation("VALIDATION_VARIANT_UNAVAILABLE", "Una variante no está disponible.");
    }
    const variantById = new Map(variants.map((variant) => [variant.id, variant]));

    // RN-VTA-04: una línea con unidad serializada mueve exactamente una unidad, y una
    // variante serializada se vende eligiendo la unidad. Se pide al crear porque este WP
    // no edita líneas: sin unidad, la línea no se podría completar nunca. WP-C19 vuelve
    // a validar al confirmar: entre tanto la unidad pudo venderse en otro pedido.
    const serialIds: string[] = [];
    for (const line of input.lines) {
      const variant = variantById.get(line.variantId)!;
      if (variant.is_serialized && (!line.serialUnitId || line.qty !== "1")) {
        validation(
          "VALIDATION_SERIAL_UNIT_REQUIRED",
          "Una variante serializada se vende de a una unidad, eligiendo cuál.",
        );
      }
      if (!variant.is_serialized && line.serialUnitId) {
        validation(
          "VALIDATION_SERIAL_UNIT_NOT_APPLICABLE",
          "Solo una variante serializada lleva una unidad elegida.",
        );
      }
      if (line.serialUnitId) serialIds.push(line.serialUnitId);
    }
    if (new Set(serialIds).size !== serialIds.length) {
      validation("VALIDATION_SERIAL_UNIT_DUPLICATED", "Una unidad no se puede vender dos veces.");
    }
    if (serialIds.length > 0) {
      const units = new Map(
        (await repo.findSerialUnits(tx, ctx.tenantId, serialIds)).map((unit) => [unit.id, unit]),
      );
      for (const line of input.lines) {
        if (!line.serialUnitId) continue;
        const unit = units.get(line.serialUnitId);
        if (!unit || unit.variant_id !== line.variantId || unit.status !== "available") {
          validation("VALIDATION_SERIAL_UNIT_UNAVAILABLE", "Una unidad no está disponible.");
        }
      }
    }

    // RN-VTA-01: el servidor calcula; el total del cliente solo se compara.
    const priced = priceSaleOrder({
      lines: input.lines.map((line) => {
        const variant = variantById.get(line.variantId)!;
        return {
          unitPrice: Money.pyg(variant.price_pyg),
          qty: Quantity.units(Number(line.qty)),
          vatRate: variant.vat_rate,
        };
      }),
      discountPyg: Money.pyg(BigInt(input.discountPyg ?? "0")),
    });
    if (!priced.ok) throw toTRPCError(pricingFailure(priced.error));
    const order = priced.value;
    if (input.totalPyg !== undefined && BigInt(input.totalPyg) !== order.totalPyg.minor) {
      validation(
        "VALIDATION_TOTAL_MISMATCH",
        "El total no coincide con el que calcula el sistema. Revisá los precios y volvé a intentarlo.",
        { sentPyg: input.totalPyg, calculatedPyg: order.totalPyg.minor.toString() },
      );
    }

    const year = ASUNCION_YEAR.format(deps.clock.now());
    const sequence = await repo.nextOrderSequence(tx, ctx.tenantId, year);
    const code = `VTA-${year}-${String(sequence).padStart(4, "0")}`;

    const id = await repo.createOrder(
      tx,
      {
        tenant_id: ctx.tenantId,
        channel_id: input.channelId,
        customer_id: input.customerId ?? null,
        code,
        status: "draft",
        subtotal_pyg: order.subtotalPyg.minor,
        discount_pyg: order.discountPyg.minor,
        shipping_pyg: order.shippingPyg.minor,
        total_pyg: order.totalPyg.minor,
        vat_10_pyg: order.vat10Pyg.minor,
        vat_5_pyg: order.vat5Pyg.minor,
        exempt_pyg: order.exemptPyg.minor,
        notes: input.notes ?? null,
        created_by: ctx.userId,
      },
      input.lines.map((line, position) => {
        const variant = variantById.get(line.variantId)!;
        const pricedLine = order.lines[position]!;
        return {
          tenant_id: ctx.tenantId,
          variant_id: line.variantId,
          serial_unit_id: line.serialUnitId ?? null,
          qty: line.qty,
          uom: variant.uom,
          unit_price_pyg: variant.price_pyg,
          discount_pyg: pricedLine.discountPyg.minor,
          line_total_pyg: pricedLine.lineTotalPyg.minor,
          vat_rate: variant.vat_rate,
          vat_pyg: pricedLine.vatPyg.minor,
          position,
        };
      }),
    );
    await audit(tx, ctx, "sales.order.create", id, null, {
      status: "draft",
      code,
      channelId: input.channelId,
      customerId: input.customerId ?? null,
      totalPyg: order.totalPyg.minor.toString(),
      lineCount: input.lines.length,
    });
    const row = await repo.findOrder(tx, ctx.tenantId, id);
    if (!row) throw new Error("pedido recién creado no se pudo releer");
    return toSaleOrder(row);
  });
}

/**
 * Borra un borrador (política de DELETE de 0034: `sales.order:write` y `draft`).
 * Un pedido que ya salió de `draft` se cancela, no se borra. Si el borrador
 * tiene una seña enganchada, la base lo impide (23503, `RESTRICT` desde 0034) y
 * el mapeador global responde `CONFLICT_ORDER_HAS_DEPOSIT`: hay que desvincular
 * la seña a propósito, no se desengancha en silencio.
 */
export async function removeOrder(db: PrismaClient, ctx: SalesContext, id: string): Promise<void> {
  return withTenantTx(db, ctx, async (tx) => {
    await repo.lockOrder(tx, ctx.tenantId, id);
    const before = await repo.findOrder(tx, ctx.tenantId, id);
    if (!before) throw toTRPCError(NOT_FOUND);
    if (before.status !== "draft") {
      throw toTRPCError(
        appError(
          "CONFLICT_SALE_ORDER_NOT_DRAFT",
          409,
          "Solo se puede borrar un pedido en borrador. Uno que ya avanzó se cancela.",
        ),
      );
    }
    try {
      await repo.removeOrder(tx, ctx.tenantId, id);
    } catch (error) {
      // P2025: la política de DELETE ocultó la fila aunque se haya leído. Sin una
      // fila borrada no hay efecto que auditar.
      if (isPrismaKnownError(error) && error.code === "P2025") {
        throw toTRPCError(FORBIDDEN_ACTION);
      }
      throw error;
    }
    await audit(
      tx,
      ctx,
      "sales.order.remove",
      id,
      {
        status: before.status,
        code: before.code,
        channelId: before.channel_id,
        customerId: before.customer_id,
        totalPyg: before.total_pyg.toString(),
        lineCount: before.sale_order_lines.length,
      },
      null,
    );
  });
}

/**
 * Transiciones que no tocan inventario ni cobro (RN-VTA-02): `draft →
 * awaiting_payment` y la cancelación desde `draft` o `awaiting_payment`. La
 * máquina de estados es la de `packages/domain` (RN-EST-02).
 *
 * Cancelar no se hace con órdenes de fraccionamiento sin cancelar: quedarían
 * colgadas de un pedido que no va a ocurrir, y hoy `inventory.decant.plan`
 * acepta una venta en cualquier estado (solo verifica que exista; C19 lo
 * restringe a `awaiting_payment` o `paid`). Cancelar las órdenes es de
 * WP-C13c. Tampoco suelta ninguna reserva: no hay (WP-C18); cuando C18 las
 * cree, soltarlas al cancelar es suyo.
 */
export async function transitionOrder(
  db: PrismaClient,
  ctx: SalesContext,
  input: TransitionSaleOrderInput,
  deps: SalesServiceDeps,
): Promise<SaleOrderDto> {
  return withTenantTx(db, ctx, async (tx) => {
    await repo.lockOrder(tx, ctx.tenantId, input.id);
    const before = await repo.findOrder(tx, ctx.tenantId, input.id);
    if (!before) throw toTRPCError(NOT_FOUND);
    const result = transitionSaleOrder(before.status, input.toStatus);
    if (!result.ok) {
      throw toTRPCError(
        appError(
          "CONFLICT_INVALID_TRANSITION",
          409,
          `El pedido no puede pasar de ${result.error.from} a ${result.error.to}.`,
          { from: result.error.from, to: result.error.to },
        ),
      );
    }
    if (
      result.value === "cancelled" &&
      (await repo.countOpenDecantOrders(tx, ctx.tenantId, input.id)) > 0
    ) {
      throw toTRPCError(
        appError(
          "CONFLICT_SALE_ORDER_HAS_DECANT_ORDERS",
          409,
          "No se puede cancelar el pedido porque tiene órdenes de fraccionamiento sin cancelar.",
        ),
      );
    }
    const now = deps.clock.now();
    const updated = await repo.updateOrderStatus(tx, ctx.tenantId, input.id, before.status, {
      status: result.value,
      ...(result.value === "awaiting_payment" && { placedAt: now }),
      ...(result.value === "cancelled" && { cancelledAt: now }),
    });
    if (!updated) throw toTRPCError(FORBIDDEN_ACTION);
    await repo.insertTransition(tx, {
      tenant_id: ctx.tenantId,
      sale_order_id: input.id,
      from_status: before.status,
      to_status: result.value,
      actor_id: ctx.userId,
      audience: ctx.audience,
      reason: input.reason ?? null,
      occurred_at: now,
    });
    await audit(
      tx,
      ctx,
      "sales.order.transition",
      input.id,
      { status: before.status },
      { status: result.value },
    );
    const row = await repo.findOrder(tx, ctx.tenantId, input.id);
    if (!row) throw new Error("pedido actualizado no se pudo releer");
    return toSaleOrder(row);
  });
}
