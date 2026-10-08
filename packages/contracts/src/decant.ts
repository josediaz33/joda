// Esquemas del módulo de fraccionamiento (WP-C13, RF-FRA-01…06,
// docs/domain-rules.md RN-FRA, ADR-010). Admin únicamente: una orden habla de
// granel y de insumos y su ejecución devuelve el COGS, que jamás sale en un
// DTO público (.claude/rules/contracts.md).
//
// El decant tiene DOS momentos y son dos mutaciones, no una (RN-FRA-01):
// `plan` (el compromiso: crea la orden `pending`, sin consumir nada) y
// `execute` (alguien llena el vial: movimientos definitivos con la merma
// REAL). Entre las dos, `start` (pending → in_progress, RN-EST-03).
import { z } from "zod";
import { uomSchema } from "./catalog.js";
import { adminMovementSchema } from "./inventory.js";
import { idSchema } from "./shared/id.js";
import { pygAmountSchema } from "./shared/money.js";

// Mismos cuatro valores que el `CREATE TYPE decant_wo_status` de
// packages/db/migrations/0001_foundation.sql y que `DecantWoStatus` de
// packages/domain/src/decant/workOrder.ts.
export const decantWorkOrderStatusSchema = z.enum(["pending", "in_progress", "done", "cancelled"]);
export type DecantWorkOrderStatus = z.infer<typeof decantWorkOrderStatusSchema>;

export const adminDecantWorkOrderSchema = z
  .object({
    id: idSchema,
    // Nullable en la base (una orden de antes de C19, o una de producción para
    // stock, RF-FRA-10); `plan` la exige siempre: sin venta, el líquido que
    // se consume no tiene a quién cargarle el costo.
    saleOrderId: idSchema.nullable(),
    sourceLotId: idSchema,
    targetVariantId: idSchema,
    qtyUnits: z.number().int().positive(),
    mlPerUnit: z.number().positive(),
    mlExpected: z.number().positive(),
    wasteExpected: z.number().nonnegative(),
    wasteActual: z.number().nonnegative().nullable(),
    status: decantWorkOrderStatusSchema,
    executedBy: idSchema.nullable(),
    executedAt: z.string().nullable(),
    createdAt: z.string(),
    createdBy: idSchema.nullable(),
  })
  .strict();
export type AdminDecantWorkOrder = z.infer<typeof adminDecantWorkOrderSchema>;

// `Quantity.ml` (packages/domain/src/shared/quantity.ts) admite hasta 3
// decimales: este `.refine()` adelanta ese límite acá para un 400 claro en
// vez de dejar que el service golpee contra la excepción de dominio (mismo
// criterio que `createAdjustmentInput` en inventory.ts).
const ML_SCALE = 1000;
const ML_SCALE_EPSILON = 1e-9;

// ---------------------------------------------------------------------
// Planificación — RF-FRA-01, RN-FRA-02. `saleOrderId` es OBLIGATORIO: sin una
// venta que se lleve el costo ni un lote de decant que reciba el líquido, la
// ejecución consumiría granel, merma e insumos "a ningún lado". Producir para
// stock (RF-FRA-10) es otro flujo y necesita el movimiento `decant_yield`.
//
// El granel de origen lo elige el servidor: el lote `bulk` en
// `open_for_decant` de apertura más antigua que alcance para la orden
// completa. `sourceLotId` es opcional para que el admin elija otro; nunca se
// abre un frasco desde acá.
// ---------------------------------------------------------------------
export const planDecantInput = z
  .object({
    saleOrderId: idSchema,
    targetVariantId: idSchema,
    qtyUnits: z.number().int().positive(),
    sourceLotId: idSchema.optional(),
  })
  .strict();
export type PlanDecantInput = z.infer<typeof planDecantInput>;

export const decantBomLineSchema = z
  .object({
    componentVariantId: idSchema,
    qty: z.number().positive(),
    uom: uomSchema,
    isOptional: z.boolean(),
  })
  .strict();
export type DecantBomLine = z.infer<typeof decantBomLineSchema>;

export const planDecantOutput = z
  .object({
    order: adminDecantWorkOrderSchema,
    // Lo que la orden compromete del granel: líquido más merma esperada
    // (RN-FRA-02). Informativo: C13 no reserva (la reserva es de WP-C18).
    mlToReserve: z.number().positive(),
    bom: z.array(decantBomLineSchema),
  })
  .strict();
export type PlanDecantOutput = z.infer<typeof planDecantOutput>;

// ---------------------------------------------------------------------
// Inicio — RN-EST-03, pending → in_progress. Evita que dos personas tomen la
// misma orden y deja la orden `in_progress` si la ejecución falla (caso borde
// 2): el rollback de una sola transacción ya la deja ahí.
// ---------------------------------------------------------------------
export const startDecantInput = z.object({ workOrderId: idSchema }).strict();
export type StartDecantInput = z.infer<typeof startDecantInput>;

// ---------------------------------------------------------------------
// Ejecución — RF-FRA-02, RF-FRA-05, RN-FRA-03. `wasteActual` es OBLIGATORIO:
// sin la merma real la orden no pasa a `done`. Cero es una declaración válida
// (el `CHECK` de la base admite `waste_actual >= 0`); lo que no se admite es
// no declararla. El ejecutor y el momento salen de la sesión y del reloj del
// servidor, no del cliente: aceptarlos permitiría atribuir una ejecución a
// otra persona.
// ---------------------------------------------------------------------
export const executeDecantInput = z
  .object({
    workOrderId: idSchema,
    wasteActual: z
      .number()
      .finite()
      .nonnegative()
      .refine(
        (value) => Math.abs(value * ML_SCALE - Math.round(value * ML_SCALE)) < ML_SCALE_EPSILON,
        "wasteActual admite hasta 3 decimales",
      ),
  })
  .strict();
export type ExecuteDecantInput = z.infer<typeof executeDecantInput>;

export const executeDecantOutput = z
  .object({
    order: adminDecantWorkOrderSchema,
    movements: z.array(adminMovementSchema),
    // RN-FRA-04: COGS = líquido + merma + insumos, en guaraníes enteros.
    cogs: pygAmountSchema,
    costBreakdown: z
      .object({
        liquid: pygAmountSchema,
        waste: pygAmountSchema,
        supplies: pygAmountSchema,
      })
      .strict(),
    // Insumos opcionales que faltaron y se ejecutó sin ellos (caso borde 4).
    skippedOptionalComponentIds: z.array(idSchema),
  })
  .strict();
export type ExecuteDecantOutput = z.infer<typeof executeDecantOutput>;

// ---------------------------------------------------------------------
// Cola de órdenes — RF-FRA-06: pendientes de ejecución (`pending` e
// `in_progress`), agrupadas por frasco de origen.
// ---------------------------------------------------------------------
export const listDecantOrdersInput = z
  .object({ status: z.enum(["pending", "in_progress"]).optional() })
  .strict();
export type ListDecantOrdersInput = z.infer<typeof listDecantOrdersInput>;

export const decantQueueGroupSchema = z
  .object({
    sourceLotId: idSchema,
    sourceLotCode: z.string().nullable(),
    // Apertura del frasco: el orden de las agrupaciones (la más antigua primero).
    openedAt: z.string().nullable(),
    // Saldo del granel y lo que sus órdenes abiertas comprometen (líquido más
    // merma esperada). Sin reservas todavía (WP-C18), dos órdenes pueden
    // comprometer el mismo granel: acá se ve si el frasco alcanza para su cola.
    onHandMl: z.number(),
    committedMl: z.number(),
    orders: z.array(adminDecantWorkOrderSchema),
  })
  .strict();
export type DecantQueueGroup = z.infer<typeof decantQueueGroupSchema>;

export const listDecantOrdersOutput = z
  .object({ groups: z.array(decantQueueGroupSchema) })
  .strict();
export type ListDecantOrdersOutput = z.infer<typeof listDecantOrdersOutput>;
