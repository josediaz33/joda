// Esquemas del módulo inventario (WP-C10, docs/api-conventions.md §2:
// `inventory.stock.available`, `inventory.adjustment.create`; RF-INV-03…05).
// Reusa uomSchema de catalog.ts — una sola fuente para ese enum, no una
// copia — y moneySchema/pygAmountSchema de shared/money.ts (el costo del
// lote en su moneda de compra y en guaraníes son cosas distintas, RN-COS-01).
import { z } from "zod";
import { uomSchema } from "./catalog.js";
import { idSchema } from "./shared/id.js";
import { moneySchema, pygAmountSchema } from "./shared/money.js";
import { MAX_PAGE_SIZE, paginatedOutputSchema } from "./shared/pagination.js";

export const lotStatusSchema = z.enum([
  "available",
  "open_for_decant",
  "quarantine",
  "damaged",
  "depleted",
]);
export type LotStatus = z.infer<typeof lotStatusSchema>;

// Mismos once valores que el `CREATE TYPE movement_type` de
// packages/db/migrations/0001_foundation.sql — GLOSARIO.md "Movimiento".
export const movementTypeSchema = z.enum([
  "purchase_receipt",
  "sale",
  "return_in",
  "return_out",
  "decant_consumption",
  "decant_yield",
  "bom_consumption",
  "waste",
  "adjustment",
  "transfer_in",
  "transfer_out",
]);
export type MovementType = z.infer<typeof movementTypeSchema>;

// `inventory_movements.id`/`movement_cost_allocations.id` son `bigint`
// identity (packages/db/migrations/0004_inventory.sql), no uuid — idSchema
// no aplica (shared/id.ts documenta esa exclusión explícitamente). Viaja
// como string por el mismo motivo que el dinero (docs/api-conventions.md
// §3): un bigint no sobrevive JSON.stringify y puede superar
// Number.MAX_SAFE_INTEGER. Siempre no negativo (GENERATED ALWAYS AS
// IDENTITY empieza en 1), a diferencia de pygAmountSchema.
export const movementIdSchema = z
  .string()
  .regex(/^\d+$/, "movementId debe ser un entero positivo en formato string");
export type MovementId = z.infer<typeof movementIdSchema>;

// ---------------------------------------------------------------------
// Saldo — RF-INV-03, "consultar el saldo disponible por variante,
// descontando reservas vivas". Sourced de app.v_stock_available
// (packages/db/migrations/0009_invariants.sql): `available` ya sale
// descontado — hoy da lo mismo que `onHand` porque WP-C18 (reservas TTL)
// todavía no puebla stock_reservations, pero la cuenta ya está bien armada
// para cuando exista, sin tocar este contrato.
// ---------------------------------------------------------------------
export const stockAvailabilitySchema = z
  .object({
    variantId: idSchema,
    onHand: z.number(),
    reserved: z.number(),
    available: z.number(),
  })
  .strict();
export type StockAvailability = z.infer<typeof stockAvailabilitySchema>;

export const stockAvailabilityInput = z.object({ variantId: idSchema }).strict();
export type StockAvailabilityInput = z.infer<typeof stockAvailabilityInput>;

// ---------------------------------------------------------------------
// Lote — admin únicamente: costo puesto y proveedor jamás en un DTO
// público (.claude/rules/contracts.md). Sin publicLot: el storefront no
// necesita este nivel de detalle, lee vistas de catálogo (docs/data-model.md
// §7), no lotes.
// ---------------------------------------------------------------------
export const adminLotSchema = z
  .object({
    id: idSchema,
    variantId: idSchema,
    lotCode: z.string().nullable(),
    batchCode: z.string().nullable(),
    parentLotId: idSchema.nullable(),
    status: lotStatusSchema,
    uom: uomSchema,
    qtyInitial: z.number(),
    onHand: z.number(),
    unitCost: moneySchema,
    fxRateToPyg: z.number().positive(),
    landedCostPyg: pygAmountSchema,
    unitLandedCostPyg: pygAmountSchema,
    manufacturedAt: z.string().nullable(),
    expiryAt: z.string().nullable(),
    openedAt: z.string().nullable(),
    receivedAt: z.string(),
  })
  .strict();
export type AdminLot = z.infer<typeof adminLotSchema>;

// ---------------------------------------------------------------------
// Movimiento — RF-INV-05, "con su costo y referencia de origen".
// ---------------------------------------------------------------------
export const adminMovementSchema = z
  .object({
    id: movementIdSchema,
    lotId: idSchema,
    variantId: idSchema,
    serialUnitId: idSchema.nullable(),
    qty: z.number(),
    uom: uomSchema,
    movementType: movementTypeSchema,
    totalCostPyg: pygAmountSchema.nullable(),
    referenceType: z.string().nullable(),
    referenceId: idSchema.nullable(),
    occurredAt: z.string(),
    createdBy: idSchema.nullable(),
    note: z.string().nullable(),
  })
  .strict();
export type AdminMovement = z.infer<typeof adminMovementSchema>;

// Historial completo de un lote (RF-INV-05) — sin paginación cursor
// (docs/api-conventions.md §6): es una colección acotada bajo un padre
// específico, mismo criterio que `catalog.bom.list` (packages/contracts/src/catalog.ts),
// no un listado global.
export const lotHistoryInput = z.object({ lotId: idSchema }).strict();
export type LotHistoryInput = z.infer<typeof lotHistoryInput>;

export const lotHistoryOutput = z
  .object({ lot: adminLotSchema, movements: z.array(adminMovementSchema) })
  .strict();
export type LotHistory = z.infer<typeof lotHistoryOutput>;

// ---------------------------------------------------------------------
// Ajuste — RF-INV-04, "motivo obligatorio y usuario responsable" (el
// usuario responsable sale de la sesión, `ctx.userId` vía `created_by`; no
// se acepta como campo del input — asignarlo desde el cliente permitiría
// atribuir un ajuste a otra persona). `qty` con signo: positivo halló más
// stock que el proyectado, negativo halló menos (GLOSARIO.md "Movimiento").
// Sin `uom`: la deriva el lote existente (`inventory.stock:adjust` no puede
// cambiar la unidad de un lote, RN-LOT-01) — aceptarla del cliente abriría
// la puerta a un mismatch que hoy es simplemente imposible de pedir.
// ---------------------------------------------------------------------
// `Quantity.ml` (packages/domain/src/shared/quantity.ts) admite hasta 3
// decimales — este `.refine()` adelanta ese mismo límite acá, para un 400
// claro en vez de dejar que el service golpee contra la excepción de
// dominio (que asume un bug del llamador, no un typo del usuario en un
// formulario). Un lote `unit` es más estricto todavía (entero, sin
// decimales) pero ESO no se puede validar en la frontera: qué `uom` tiene
// el lote es un hecho de la base que este esquema no conoce sin una
// consulta — lo valida el service, que ya leyó el lote (RN-LOT-01).
const QTY_DECIMAL_SCALE = 1000;
const QTY_DECIMAL_EPSILON = 1e-9;

export const createAdjustmentInput = z
  .object({
    lotId: idSchema,
    qty: z
      .number()
      .finite()
      .refine((value) => value !== 0, "qty no puede ser cero")
      .refine(
        (value) =>
          Math.abs(value * QTY_DECIMAL_SCALE - Math.round(value * QTY_DECIMAL_SCALE)) <
          QTY_DECIMAL_EPSILON,
        "qty admite hasta 3 decimales",
      ),
    reason: z.string().trim().min(1, "El motivo del ajuste es obligatorio"),
  })
  .strict();
export type CreateAdjustmentInput = z.infer<typeof createAdjustmentInput>;

// ---------------------------------------------------------------------
// Apertura de frasco — RF-INV-08, RN-LOT-02, ADR-009 (WP-C11). Una
// CONVERSIÓN entre lotes, no un cambio de estado: el input es solo el lote
// sellado. Nada más se acepta del cliente — el volumen sale del producto y
// el granel de destino de la única variante `bulk` del mismo producto
// (índice único parcial de 0028), no de quien llama.
//
// Abre UNA unidad. Si el lote nació con más de una (`qty_initial` > 1), la
// apertura separa primero esa unidad en su propio lote de una unidad
// (caso borde 21) y abre ese: `openedSealedLot` es el lote que quedó
// `open_for_decant` (el original si tenía una sola unidad, el lote
// separado si tenía varias) y `sourceLot` es el original, ya sin la unidad
// — `null` cuando no hubo separación.
// ---------------------------------------------------------------------
export const openLotInput = z.object({ lotId: idSchema }).strict();
export type OpenLotInput = z.infer<typeof openLotInput>;

export const openLotOutput = z
  .object({
    sourceLot: adminLotSchema.nullable(),
    openedSealedLot: adminLotSchema,
    bulkLot: adminLotSchema,
    movements: z.array(adminMovementSchema),
  })
  .strict();
export type OpenLotOutput = z.infer<typeof openLotOutput>;

// ---------------------------------------------------------------------
// Unidades serializadas — RF-INV-10 (WP-C12): número de serie único por
// tenant, garantía y trazabilidad de venta. Admin únicamente. `variantId` NO
// es un campo de entrada del alta: lo deriva el servidor del lote (la
// unidad es de la variante de su lote, RN-SER-04); aceptarlo del cliente
// permitiría declarar otra distinta.
// ---------------------------------------------------------------------
// Mismos siete valores que el `CREATE TYPE serial_status` de
// packages/db/migrations/0001_foundation.sql.
export const serialStatusSchema = z.enum([
  "available",
  "reserved",
  "sold",
  "quarantine",
  "damaged",
  "returned",
  "refurbished",
]);
export type SerialStatus = z.infer<typeof serialStatusSchema>;

export const adminSerializedUnitSchema = z
  .object({
    id: idSchema,
    variantId: idSchema,
    lotId: idSchema.nullable(),
    serialNumber: z.string(),
    status: serialStatusSchema,
    // `date` de Postgres: AAAA-MM-DD, sin hora ni zona.
    warrantyUntil: z.string().nullable(),
    // Vínculo con la línea de venta: lo llena la confirmación de la venta
    // (WP-C19, RN-VTA-04); hasta entonces es siempre null.
    soldOrderLineId: idSchema.nullable(),
    notes: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();
export type AdminSerializedUnit = z.infer<typeof adminSerializedUnitSchema>;

export const createSerializedUnitInput = z
  .object({
    lotId: idSchema,
    serialNumber: z.string().trim().min(1, "El número de serie es obligatorio").max(100),
    warrantyUntil: z.iso.date().nullable().optional(),
    notes: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .strict();
export type CreateSerializedUnitInput = z.infer<typeof createSerializedUnitInput>;

// Se consulta por UNO de tres criterios: un número de serie exacto, un lote
// o una variante. Sin ninguno sería un listado de todas las unidades del
// tenant, y con dos, ambiguo.
export const listSerializedUnitsInput = z
  .object({
    serialNumber: z.string().trim().min(1).max(100).optional(),
    lotId: idSchema.optional(),
    variantId: idSchema.optional(),
    status: serialStatusSchema.optional(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  })
  .strict()
  .refine(
    (input) =>
      [input.serialNumber, input.lotId, input.variantId].filter((value) => value !== undefined)
        .length === 1,
    {
      message: "Indicá exactamente uno: serialNumber, lotId o variantId.",
      path: ["serialNumber"],
    },
  );
export type ListSerializedUnitsInput = z.infer<typeof listSerializedUnitsInput>;

export const listSerializedUnitsOutput = paginatedOutputSchema(adminSerializedUnitSchema);
export type ListSerializedUnitsOutput = z.infer<typeof listSerializedUnitsOutput>;

// Trazabilidad: la unidad y todos los movimientos que la mencionan
// (`inventory_movements.serial_unit_id`), con su costo. Hoy vacío hasta que
// exista la venta (WP-C19) o la devolución.
export const serializedUnitHistoryInput = z.object({ serialUnitId: idSchema }).strict();
export type SerializedUnitHistoryInput = z.infer<typeof serializedUnitHistoryInput>;

export const serializedUnitHistoryOutput = z
  .object({ unit: adminSerializedUnitSchema, movements: z.array(adminMovementSchema) })
  .strict();
export type SerializedUnitHistory = z.infer<typeof serializedUnitHistoryOutput>;
