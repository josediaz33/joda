import {
  DEFAULT_PAGE_SIZE,
  type ConfirmSaleOrderInput,
  type CreateSaleOrderInput,
  type SaleOrderDto,
  type TransitionSaleOrderInput,
} from "@joda/contracts";
import {
  Money,
  planSaleConsumption,
  priceSaleOrder,
  Quantity,
  transitionSaleOrder,
  type Clock,
  type SaleConsumptionError,
  type SaleOrderPricingError,
  type SaleOrderStatus,
} from "@joda/domain";
import type { PrismaClient } from "@joda/db";
import { recordAuditEntry } from "../../db/audit.js";
import { decodeCursor, encodeCursor } from "../../db/cursor.js";
import { withIdempotentTx, type IdempotencyRequest } from "../../db/withIdempotentTx.js";
import { withTenantTx, type TenantTx, type TenantTxContext } from "../../db/withTenantTx.js";
import {
  appError,
  isPrismaKnownError,
  toTRPCError,
  type ApiError,
} from "../../middleware/errorMapper.js";
import { lockVariantsThenLots, shareLockVariantsAscending } from "../../db/stockLocks.js";
import { createPlannedWorkOrder, listDecantVariantIds } from "../decant/service.js";
import * as inventoryRepo from "../inventory/repository.js";
import * as reservationsRepo from "../reservations/repository.js";
import {
  listOrderReservations,
  releaseReservationsOf,
  reserveOrderLines,
  SALE_ORDER_REFERENCE,
} from "../reservations/service.js";
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
  return withTenantTx(db, ctx, async (tx) => {
    const rows = await repo.listOrders(tx, {
      tenantId: ctx.tenantId,
      cursor,
      limit,
      status: input.status,
      customerId: input.customerId,
    });
    // La página son `limit` pedidos (la fila de más solo dice si hay otra): las reservas de esos.
    const reservations = await listOrderReservations(
      tx,
      ctx.tenantId,
      rows.slice(0, limit).map((row) => row.id),
    );
    return page(rows, limit, (row) => toSaleOrder(row, reservations.get(row.id)));
  });
}

export async function getOrder(
  db: PrismaClient,
  ctx: TenantTxContext,
  id: string,
): Promise<SaleOrderDto> {
  return withTenantTx(db, ctx, async (tx) => {
    const row = await repo.findOrder(tx, ctx.tenantId, id);
    if (!row) throw toTRPCError(NOT_FOUND);
    return toSaleOrder(row, (await listOrderReservations(tx, ctx.tenantId, [id])).get(id));
  });
}

/**
 * Crea el pedido en `draft` (RN-EST-02). No toca inventario ni reservas
 * (RN-VTA-02, RN-RES-01): consumir es de WP-C19, y la reserva nace al pasar el
 * pedido a `awaiting_payment` (`transitionOrder`, WP-C18b).
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
    // Las líneas referencian varias variantes y la FK toma `KEY SHARE` sobre cada
    // una en el orden de las filas: contra quien reserva (`FOR UPDATE` ascendente,
    // RN-RES-07) eso puede interbloquearse. Se toman antes, en el mismo orden.
    await shareLockVariantsAscending(tx, ctx.tenantId, variantIds);
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
    // Un borrador no reserva nada (RN-VTA-02, RN-RES-01): la reserva nace al pasar a `awaiting_payment`.
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
 * **Pasar a `awaiting_payment` reserva el stock del pedido en esta misma
 * transacción** (RF-VTA-04, RN-RES-06; `reserveOrderLines`): por variante, por
 * unidad serializada para un reloj, y nada para un decant bajo pedido (lo
 * compromete el plan del fraccionamiento). Si algo no alcanza, 409 y no cambia
 * nada. **Cancelar suelta las reservas del pedido** (`released_at`).
 *
 * Cancelar no se hace con órdenes de fraccionamiento sin cancelar: quedarían
 * colgadas de un pedido que no va a ocurrir, y hoy `inventory.decant.plan`
 * acepta una venta en cualquier estado (solo verifica que exista; C19 lo
 * restringe a `awaiting_payment` o `paid`). Cancelar las órdenes —y soltar
 * sus reservas de granel e insumos— es de WP-C13c.
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
    // RN-RES-07: la fila del pedido ya está bloqueada (primero la entidad); las
    // variantes las bloquea el servicio de reservas, antes de leer el disponible.
    let reservationsCreated = 0;
    let reservationsReleased = 0;
    if (result.value === "awaiting_payment") {
      reservationsCreated = await reserveOrderLines(
        tx,
        ctx,
        input.id,
        before.sale_order_lines,
        deps,
      );
    } else if (result.value === "cancelled") {
      reservationsReleased = await releaseReservationsOf(
        tx,
        ctx,
        SALE_ORDER_REFERENCE,
        input.id,
        deps,
      );
    }
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
      {
        status: result.value,
        ...(result.value === "awaiting_payment" && { reservationsCreated }),
        ...(result.value === "cancelled" && { reservationsReleased }),
      },
    );
    const row = await repo.findOrder(tx, ctx.tenantId, input.id);
    if (!row) throw new Error("pedido actualizado no se pudo releer");
    return toSaleOrder(
      row,
      (await listOrderReservations(tx, ctx.tenantId, [input.id])).get(input.id),
    );
  });
}

// ---------------------------------------------------------------------
// Confirmación del pago — WP-C19 (RF-VTA-05, RF-VTA-06, RN-VTA-02, RN-VTA-04).
// ---------------------------------------------------------------------

function toLineQuantity(value: number, uom: "unit" | "ml"): Quantity {
  return uom === "unit" ? Quantity.units(value) : Quantity.ml(value);
}

/** Lo que queda libre de un lote: el saldo menos lo que otros prometieron sobre él, nunca negativo. */
function freeOfLot(onHand: number, reserved: number, uom: "unit" | "ml"): Quantity {
  const free = toLineQuantity(onHand, uom).minus(toLineQuantity(reserved, uom));
  return free.isNegative() ? Quantity.zero(uom) : free;
}

/**
 * El rechazo del dominio como respuesta de la API. **Ninguno trae un costo**: ni
 * el de un lote, ni el de una capa, ni el COGS. El vendedor confirma ventas sin
 * `inventory.stock:read` y un mensaje que nombrara un costo se lo daría igual.
 * Lo que sí dice es qué variante falta y cuánto: cantidades de stock, que el
 * personal de ventas ya ve al reservar.
 */
function consumptionFailure(
  error: SaleConsumptionError,
  skuByVariant: ReadonlyMap<string, string>,
  skuByLine: ReadonlyMap<string, string>,
): ApiError {
  switch (error.code) {
    case "INSUFFICIENT_STOCK":
      return appError(
        "CONFLICT_INSUFFICIENT_STOCK",
        409,
        "No hay stock suficiente para entregar todo el pedido. Revisá las cantidades de las líneas que se indican.",
        {
          shortages: error.shortages.map((shortage) => ({
            variantId: shortage.variantId,
            sku: skuByVariant.get(shortage.variantId) ?? null,
            requested: shortage.requested.value,
            available: shortage.available.value,
          })),
        },
      );
    case "SERIAL_UNIT_LOT_UNAVAILABLE":
      return appError(
        "CONFLICT_SERIAL_UNIT_UNAVAILABLE",
        409,
        "Una de las unidades elegidas ya no está disponible para la venta. Elegí otra o sacala del pedido.",
        { serialUnitId: error.serialUnitId, sku: skuByLine.get(error.lineId) ?? null },
      );
    case "ALLOCATION_NEEDS_LOT_CHOICE":
      return appError(
        "CONFLICT_ALLOCATION_NEEDS_LOT_CHOICE",
        409,
        "Una variante del pedido se vende eligiendo el lote y el pedido todavía no lleva esa elección: no se puede confirmar desde acá.",
        { sku: skuByLine.get(error.lineId) ?? null, policy: error.policy },
      );
  }
}

/**
 * Confirma el pago del pedido (`awaiting_payment → paid`) y consume el
 * inventario, todo en UNA transacción (RN-VTA-02, RN-VTA-05). Si cualquier paso
 * falla —un faltante, una unidad que se vendió en otro lado, un decant sin
 * granel— no cambia nada: ni el estado, ni el ledger, ni las reservas.
 *
 * ORDEN (RN-RES-07, ADR-019): (1) la fila del pedido; (2) las variantes de TODAS
 * las líneas, y las de los decants bajo pedido que hay que planificar, y las de las
 * reservas del pedido, por `id` ascendente y en UNA llamada a `lockVariantsThenLots`
 * (una variante pedida después rompería el orden); (3) los lotes consumibles, que
 * toma `app.list_sale_allocation_lots` en una sentencia por `id` ascendente
 * (quien no lee lotes —el vendedor— no podría bloquearlos desde acá: 0042).
 * Recién entonces se lee el saldo y se decide.
 *
 * QUÉ HACE, por línea:
 *   · común: consume por la política de la variante (FIFO/FEFO) en una capa por
 *     lote tocado; un movimiento `sale` y una capa de costo por capa (RN-COS-04);
 *   · serializada: exige la unidad (`VALIDATION_SERIAL_UNIT_REQUIRED` si falta),
 *     mueve exactamente una y la pasa a `sold` ligada a la línea (RN-VTA-04);
 *   · decant bajo pedido: crea su orden de fraccionamiento (`createPlannedWorkOrder`)
 *     en esta transacción y NO asienta su costo: se asienta al ejecutar el
 *     fraccionamiento (RN-FRA-03/04), y la línea queda con `cogs_pyg` en cero,
 *     costo pendiente. Una línea con una orden activa (la planificó `plan` antes) no
 *     se duplica.
 *   · `cogs_pyg` de la línea y del pedido son la suma de las capas (RN-COS-05).
 *
 * Después suelta las reservas del pedido: el consumo de verdad las reemplaza.
 *
 * **El costo no sale de la API.** Se calcula con el costo unitario que da
 * `list_sale_allocation_lots`, se persiste en `cogs_pyg` y en las capas, y no viaja
 * en la respuesta, en la auditoría ni en ningún error (el vendedor no lo lee:
 * WP-B11f/B11g). El movimiento y sus capas se escriben sin `RETURNING` y fuera de
 * todo savepoint (`insertSaleMovementWithLayer`).
 *
 * Reintentar: con la misma `Idempotency-Key` devuelve la respuesta guardada sin
 * reprocesar; sin clave, el pedido ya está en `paid` y la transición se rechaza
 * (409): no se consume dos veces.
 */
export async function confirmOrder(
  db: PrismaClient,
  ctx: SalesContext,
  input: ConfirmSaleOrderInput,
  deps: SalesServiceDeps,
  idempotency: IdempotencyRequest | null,
): Promise<SaleOrderDto> {
  const { result } = await withIdempotentTx(db, ctx, idempotency, async (tx) => ({
    result: await confirmInTransaction(tx, ctx, input, deps),
    statusCode: 200,
  }));
  return result;
}

async function confirmInTransaction(
  tx: TenantTx,
  ctx: SalesContext,
  input: ConfirmSaleOrderInput,
  deps: SalesServiceDeps,
): Promise<SaleOrderDto> {
  const { tenantId } = ctx;
  // 1. La fila de la entidad que decide el caso de uso, antes que las de stock.
  await repo.lockOrder(tx, tenantId, input.id);
  const before = await repo.findOrder(tx, tenantId, input.id);
  if (!before) throw toTRPCError(NOT_FOUND);
  const next = transitionSaleOrder(before.status, "paid");
  if (!next.ok) {
    throw toTRPCError(
      appError(
        "CONFLICT_INVALID_TRANSITION",
        409,
        `El pedido no puede pasar de ${next.error.from} a ${next.error.to}.`,
        { from: next.error.from, to: next.error.to },
      ),
    );
  }
  const now = deps.clock.now();
  const lines = before.sale_order_lines;

  const variants = await repo.findVariantsForConfirmation(tx, tenantId, [
    ...new Set(lines.map((line) => line.variant_id)),
  ]);
  const variantById = new Map(variants.map((variant) => [variant.id, variant]));
  const variantOf = (line: (typeof lines)[number]) => {
    const variant = variantById.get(line.variant_id);
    if (!variant)
      throw new Error(`la variante ${line.variant_id} del pedido ${input.id} no existe`);
    return variant;
  };
  const isDecantOnDemand = (line: (typeof lines)[number]) =>
    variantOf(line).production_mode === "made_to_order";
  const decantLines = lines.filter(isDecantOnDemand);
  const consumeLines = lines.filter((line) => !isDecantOnDemand(line));

  for (const line of consumeLines) {
    const variant = variantOf(line);
    if (variant.variant_type === "decant") {
      // Un decant para stock mezclaría ml y unidades (WP-C13b): no se vende hasta que exista.
      throw toTRPCError(
        appError(
          "CONFLICT_STOCKED_DECANT_NOT_SUPPORTED",
          409,
          "Un decant producido para stock todavía no se puede vender desde un pedido.",
          { sku: variant.sku },
        ),
      );
    }
    if (variant.is_serialized && line.serial_unit_id === null) {
      validation(
        "VALIDATION_SERIAL_UNIT_REQUIRED",
        "Una variante serializada se vende de a una unidad, eligiendo cuál.",
      );
    }
    if (!variant.is_serialized && line.serial_unit_id !== null) {
      validation(
        "VALIDATION_SERIAL_UNIT_NOT_APPLICABLE",
        "Solo una variante serializada lleva una unidad elegida.",
      );
    }
  }

  // 2. Las variantes, TODAS en la misma llamada y ascendentes (RN-RES-07): las que se
  // consumen, las que un decant bajo pedido toca (la suya, su granel y su BOM) y las
  // de las reservas del pedido (que se sueltan al final). Los lotes de todas.
  const consumeVariantIds = [...new Set(consumeLines.map((line) => line.variant_id))];
  const decantVariantIds: string[] = [];
  for (const variantId of new Set(decantLines.map((line) => line.variant_id))) {
    decantVariantIds.push(...(await listDecantVariantIds(tx, variantId)));
  }
  const reservedVariantIds = await reservationsRepo.listOpenReservationVariantIds(
    tx,
    tenantId,
    SALE_ORDER_REFERENCE,
    input.id,
  );
  await lockVariantsThenLots(tx, tenantId, {
    variantIds: [...consumeVariantIds, ...decantVariantIds, ...reservedVariantIds],
    allLotsOfVariants: true,
  });

  // 3. Consumo. Todo lo que se lee de acá en adelante se lee con los bloqueos tomados.
  let movementCount = 0;
  let layerCount = 0;
  let serialUnitsSold = 0;
  let orderCogs = 0n;
  if (consumeLines.length > 0) {
    const [lotRows, stock, ownReserved] = await Promise.all([
      inventoryRepo.listSaleAllocationLots(tx, consumeVariantIds),
      reservationsRepo.findVariantsStock(tx, consumeVariantIds),
      repo.sumLiveReservedByVariantOfOrder(tx, tenantId, input.id),
    ]);
    // Una reserva atada a un lote (una retención manual, RN-RES-06) es una promesa sobre ese
    // frasco: no se consume. Las de este pedido son por variante y no entran acá.
    const reservedOnLot = await reservationsRepo.sumLiveReservedByLot(
      tx,
      tenantId,
      lotRows.map((lot) => lot.lot_id),
    );

    const serialLines = consumeLines.filter((line) => line.serial_unit_id !== null);
    const serialUnitIds = serialLines.map((line) => line.serial_unit_id!);
    const [units, reservedByOthers] = await Promise.all([
      repo.findSerialUnitsForConfirmation(tx, tenantId, serialUnitIds),
      repo.listSerialUnitsReservedByOthers(tx, tenantId, serialUnitIds, input.id),
    ]);
    const unitById = new Map(units.map((unit) => [unit.id, unit]));
    const reservedElsewhere = new Set(reservedByOthers);
    for (const line of serialLines) {
      const unit = unitById.get(line.serial_unit_id!);
      if (!unit || unit.variant_id !== line.variant_id || unit.status !== "available") {
        throw toTRPCError(
          appError(
            "CONFLICT_SERIAL_UNIT_UNAVAILABLE",
            409,
            "Una de las unidades elegidas ya no está disponible para la venta. Elegí otra o sacala del pedido.",
            { serialUnitId: line.serial_unit_id, sku: variantOf(line).sku },
          ),
        );
      }
      if (reservedElsewhere.has(unit.id)) {
        throw toTRPCError(
          appError(
            "CONFLICT_SERIAL_UNIT_RESERVED",
            409,
            "Una de las unidades elegidas está reservada por otro pedido. Elegí otra o esperá a que se libere.",
            { serialUnitId: unit.id, sku: variantOf(line).sku },
          ),
        );
      }
    }

    const plan = planSaleConsumption({
      lines: consumeLines.map((line) => {
        const variant = variantOf(line);
        const unit = line.serial_unit_id === null ? undefined : unitById.get(line.serial_unit_id);
        return {
          lineId: line.id,
          variantId: line.variant_id,
          qty: toLineQuantity(line.qty.toNumber(), variant.uom),
          policy: variant.allocation_policy,
          // La unidad sin lote no se vende: no hay de dónde sacar ni a qué costo (vacío → rechazo del dominio).
          serialUnit: unit ? { id: unit.id, lotId: unit.lot_id ?? "" } : null,
        };
      }),
      lots: lotRows.map((lot) => {
        const variant = variantById.get(lot.variant_id)!;
        return {
          id: lot.lot_id,
          variantId: lot.variant_id,
          receivedAt: lot.received_at,
          expiryAt: lot.expiry_at,
          available: freeOfLot(
            lot.on_hand.toNumber(),
            reservedOnLot.get(lot.lot_id) ?? 0,
            variant.uom,
          ),
          unitCost: Money.pyg(lot.unit_landed_cost_pyg),
          status: "available" as const,
          variantType: variant.variant_type,
          uom: variant.uom,
        };
      }),
      // Lo que ESTE pedido puede tomar: el disponible de la variante más lo que él mismo
      // tiene reservado. La reserva de otro pedido no se consume aunque el lote tenga saldo.
      availability: consumeVariantIds.map((variantId) => ({
        variantId,
        available: toLineQuantity(
          (stock.get(variantId)?.available ?? 0) + (ownReserved.get(variantId) ?? 0),
          variantById.get(variantId)!.uom,
        ),
      })),
    });
    if (!plan.ok) {
      throw toTRPCError(
        consumptionFailure(
          plan.error,
          new Map(variants.map((variant) => [variant.id, variant.sku])),
          new Map(consumeLines.map((line) => [line.id, variantOf(line).sku])),
        ),
      );
    }

    // Escritura: leer, decidir, escribir. Una salida y una capa por capa de costo.
    for (const [index, consumed] of plan.value.lines.entries()) {
      const line = consumeLines[index]!;
      const variant = variantOf(line);
      for (const layer of consumed.layers) {
        await inventoryRepo.insertSaleMovementWithLayer(tx, {
          tenantId,
          lotId: layer.lotId,
          variantId: line.variant_id,
          serialUnitId: line.serial_unit_id,
          qty: layer.qty.value,
          uom: variant.uom,
          unitCostPyg: layer.unitCost.minor,
          totalCostPyg: layer.totalCost.minor,
          saleOrderId: input.id,
          occurredAt: now,
          createdBy: ctx.userId,
          note: `Venta ${before.code}, línea ${line.position + 1}`,
        });
        movementCount += 1;
        layerCount += 1;
      }
      if (line.serial_unit_id !== null) {
        if (!(await repo.markSerialUnitSold(tx, tenantId, line.serial_unit_id, line.id))) {
          throw toTRPCError(
            appError(
              "CONFLICT_SERIAL_UNIT_UNAVAILABLE",
              409,
              "Una de las unidades elegidas ya no está disponible para la venta. Elegí otra o sacala del pedido.",
              { serialUnitId: line.serial_unit_id, sku: variant.sku },
            ),
          );
        }
        serialUnitsSold += 1;
      }
    }
    await repo.setLinesCogs(
      tx,
      tenantId,
      plan.value.lines.map((consumed) => ({ id: consumed.lineId, cogsPyg: consumed.cogs.minor })),
    );
    orderCogs = plan.value.cogs.minor;
  }

  // 4. El consumo de verdad reemplaza a la promesa: se sueltan las reservas del pedido.
  // Sus variantes ya están en el bloqueo de arriba.
  const reservationsReleased = await releaseReservationsOf(
    tx,
    ctx,
    SALE_ORDER_REFERENCE,
    input.id,
    deps,
  );

  const updated = await repo.updateOrderStatus(tx, tenantId, input.id, before.status, {
    status: "paid",
    confirmedAt: now,
    cogsPyg: orderCogs,
  });
  if (!updated) throw toTRPCError(FORBIDDEN_ACTION);
  await repo.insertTransition(tx, {
    tenant_id: tenantId,
    sale_order_id: input.id,
    from_status: before.status,
    to_status: "paid",
    actor_id: ctx.userId,
    audience: ctx.audience,
    reason: input.reason ?? null,
    occurred_at: now,
  });

  // 5. Los decants bajo pedido: la orden nace con la venta cobrada (RN-FRA-01). No se
  // asienta su costo: se asienta al ejecutarla.
  const alreadyPlanned = await repo.listLinesWithActiveDecantOrder(
    tx,
    tenantId,
    decantLines.map((line) => line.id),
  );
  let decantOrdersCreated = 0;
  for (const line of decantLines) {
    if (alreadyPlanned.has(line.id)) continue;
    await createPlannedWorkOrder(
      tx,
      ctx,
      {
        saleOrderLineId: line.id,
        targetVariantId: line.variant_id,
        qtyUnits: line.qty.toNumber(),
      },
      deps,
    );
    decantOrdersCreated += 1;
  }

  // Sin costos: la auditoría la lee quien no puede ver el COGS (WP-B11g).
  await audit(
    tx,
    ctx,
    "sales.order.confirm",
    input.id,
    { status: before.status },
    {
      status: "paid",
      movements: movementCount,
      costLayers: layerCount,
      serialUnitsSold,
      reservationsReleased,
      decantOrdersCreated,
    },
  );

  const row = await repo.findOrder(tx, tenantId, input.id);
  if (!row) throw new Error("pedido confirmado no se pudo releer");
  return toSaleOrder(row, (await listOrderReservations(tx, tenantId, [input.id])).get(input.id));
}
