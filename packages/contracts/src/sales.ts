// Ventas de mostrador (WP-C17; RF-VTA-01…03, docs/api-conventions.md §3 y §7).
//
// Un solo DTO, el administrativo: el storefront no lee pedidos desde acá (su
// checkout es del bloque G). Y ese DTO no lleva el costo de lo vendido
// (`cogs_pyg`, del pedido y de cada línea): el vendedor tiene
// `sales.order:read` y no tiene permiso para ver costos (WP-B11f/B11g,
// migración 0037). El costo se agrega a una proyección propia, con su permiso,
// cuando se decida qué ve cada rol de una venta.
import { z } from "zod";
import { paginatedOutputSchema, paginationInputSchema, pygAmountSchema } from "./shared/index.js";

const uuid = z.uuid();

/** Importe en guaraníes que entra a la API: entero no negativo, hasta 15 dígitos (bajo 2^53, así el dominio no pierde precisión). */
const pygInput = z.string().regex(/^(0|[1-9]\d{0,14})$/);

/** Unidades vendidas: un entero positivo. Para un decant, cantidad de decants, no de ml. */
const wholeQuantity = z.string().regex(/^[1-9]\d{0,5}$/);

export const MAX_SALE_ORDER_LINES = 100;
export const MAX_SALE_ORDER_NOTES_LENGTH = 1000;
export const MAX_TRANSITION_REASON_LENGTH = 500;

const saleOrderStatus = z.enum([
  "draft",
  "awaiting_payment",
  "paid",
  "preparing",
  "ready",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
]);

export const saleOrderLineSchema = z
  .object({
    id: uuid,
    variantId: uuid,
    serialUnitId: uuid.nullable(),
    qty: z.string(),
    uom: z.enum(["unit", "ml"]),
    unitPricePyg: pygAmountSchema,
    /** La parte del descuento del pedido que le toca a la línea; la suma de todas es el descuento del pedido. */
    discountPyg: pygAmountSchema,
    /** Lo que el cliente paga por la línea: `qty × unitPricePyg − discountPyg`. Es la base del IVA y del margen. */
    lineTotalPyg: pygAmountSchema,
    vatRate: z.enum(["iva_10", "iva_5", "exenta"]),
    vatPyg: pygAmountSchema,
    position: z.number().int(),
  })
  .strict();

export const saleOrderTransitionSchema = z
  .object({
    id: z.string(),
    fromStatus: saleOrderStatus.nullable(),
    toStatus: saleOrderStatus,
    actorId: uuid.nullable(),
    audience: z.enum(["staff", "customer", "system"]),
    reason: z.string().nullable(),
    occurredAt: z.iso.datetime(),
  })
  .strict();

export const saleOrderSchema = z
  .object({
    id: uuid,
    channelId: uuid,
    customerId: uuid.nullable(),
    code: z.string(),
    status: saleOrderStatus,
    subtotalPyg: pygAmountSchema,
    discountPyg: pygAmountSchema,
    shippingPyg: pygAmountSchema,
    totalPyg: pygAmountSchema,
    vat10Pyg: pygAmountSchema,
    vat5Pyg: pygAmountSchema,
    exemptPyg: pygAmountSchema,
    notes: z.string().nullable(),
    placedAt: z.iso.datetime().nullable(),
    confirmedAt: z.iso.datetime().nullable(),
    cancelledAt: z.iso.datetime().nullable(),
    createdBy: uuid.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    lines: z.array(saleOrderLineSchema),
    transitions: z.array(saleOrderTransitionSchema),
  })
  .strict();
export type SaleOrderDto = z.infer<typeof saleOrderSchema>;

/**
 * El precio de cada línea NO viaja: sale de la variante, en el servidor. Lo que
 * el cliente aporta es qué se vende, cuántas unidades y, para un reloj, cuál
 * unidad. `totalPyg` es el total que el cliente mostró en pantalla: si no
 * coincide con el que calcula el servidor (RN-VTA-01), se rechaza.
 */
export const createSaleOrderInput = z
  .object({
    channelId: uuid,
    customerId: uuid.nullable().optional(),
    discountPyg: pygInput.optional(),
    totalPyg: pygInput.optional(),
    notes: z.string().trim().min(1).max(MAX_SALE_ORDER_NOTES_LENGTH).nullable().optional(),
    lines: z
      .array(
        z
          .object({
            variantId: uuid,
            qty: wholeQuantity,
            serialUnitId: uuid.nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_SALE_ORDER_LINES),
  })
  .strict();
export type CreateSaleOrderInput = z.infer<typeof createSaleOrderInput>;

export const saleOrderByIdInput = z.object({ id: uuid }).strict();
export const removeSaleOrderOutput = z.object({ ok: z.literal(true) }).strict();

export const listSaleOrdersInput = paginationInputSchema
  .extend({ status: saleOrderStatus.optional(), customerId: uuid.optional() })
  .strict();
export const listSaleOrdersOutput = paginatedOutputSchema(saleOrderSchema);

/**
 * Solo las transiciones que no tocan inventario ni cobro (RN-VTA-02): pasar a
 * `awaiting_payment` y cancelar (un pedido con órdenes de fraccionamiento sin
 * cancelar no se cancela). Cobrar es de WP-C19; devolver, de WP-C21.
 */
export const transitionSaleOrderInput = z
  .object({
    id: uuid,
    toStatus: z.enum(["awaiting_payment", "cancelled"]),
    reason: z.string().trim().min(1).max(MAX_TRANSITION_REASON_LENGTH).nullable().optional(),
  })
  .strict();
export type TransitionSaleOrderInput = z.infer<typeof transitionSaleOrderInput>;
