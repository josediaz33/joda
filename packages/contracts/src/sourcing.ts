// Esquemas del módulo sourcing (WP-C16, RF-SRC-01…05,
// packages/db/migrations/0005_procurement.sql "Sourcing: simulación pura",
// 0032_write_permissions_sourcing_scenarios.sql, docs/domain-rules.md
// RN-SRC-01…03). packages/contracts no depende de packages/domain (frontera
// de tipos independiente, ver el comentario de catalog.ts): los enums de acá
// repiten los mismos literales que 0001_foundation.sql, no se importan de
// ningún lado — tampoco de los otros módulos de este paquete (market.ts
// define su propio freightMethod por la misma razón).
//
// Sin esquema público: sourcing_scenarios y sus líneas son costo y margen de
// proveedor puro (docs/security-spec.md §2.1, "el vendedor no ve costos") —
// no hay audiencia pública para este módulo, igual que market.ts.
//
// RF-SRC-05 (convertir un escenario en orden de compra) no tiene endpoint
// todavía: apps/api está fuera de alcance de WP-C16 (ver WP-C16b,
// docs/backlog.md). convertSourcingScenarioInput/Output quedan definidos
// contract-first para que C16b los implemente contra una forma ya acordada,
// no para que algo los consuma hoy.
import { z } from "zod";
import { idSchema } from "./shared/id.js";
import { currencySchema, pygAmountSchema } from "./shared/money.js";
import { paginatedOutputSchema, paginationInputSchema } from "./shared/pagination.js";

const MAX_MINOR = "9223372036854775807";
function fitsUnsignedInteger(value: string, maximum: string): boolean {
  const digits = value.replace(/^0+/, "") || "0";
  return digits.length < maximum.length || (digits.length === maximum.length && digits <= maximum);
}
const nonnegativeMinor = z
  .string()
  .regex(/^\d+$/)
  .refine((value) => fitsUnsignedInteger(value, MAX_MINOR));
// qty numeric(14,3) CHECK (qty > 0) — mismo patrón que positiveQuantity de market.ts.
const positiveQuantity = z
  .string()
  .regex(/^(?:[1-9]\d*(?:\.\d{1,3})?|0\.(?!0{1,3}$)\d{1,3})$/)
  .refine((value) => value.split(".")[0]!.length <= 11);
// fx_rate numeric(18,8), estrictamente positivo (RN-COS-01: un fx <= 0 no tiene sentido).
const positiveFxRate = z
  .string()
  .regex(/^(?!0+(?:\.0+)?$)\d+(?:\.\d{1,8})?$/)
  .refine((value) => value.split(".")[0]!.replace(/^0+/, "").length <= 10);
// numeric(7,3): hasta 4 dígitos enteros, con signo (una línea en pérdida es un margen negativo legítimo, RN-SRC-02).
const marginPct = z.string().regex(/^-?\d{1,4}(\.\d{1,3})?$/);
// Percentage de packages/domain es [0, 1] (RN-SRC-01/03) — acá se valida la misma forma, sin importar el tipo.
const ratio = z.number().finite().min(0).max(1);

const freightMethodSchema = z.enum(["by_value", "by_unit", "by_volume", "manual"]);
export type FreightMethod = z.infer<typeof freightMethodSchema>;

// Mismos literales que packages/db/migrations/0001_foundation.sql (CREATE
// TYPE vat_rate) — repetidos a propósito, no importados de catalog.ts (ver
// el comentario de arriba). Sin alias de tipo exportado: catalog.ts ya
// exporta el `VatRate` público del paquete: dos tipos con el mismo nombre
// desde dos módulos distintos rompen el barrel (`index.ts`) con un error de
// ambigüedad.
const vatRateSchema = z.enum(["iva_10", "iva_5", "exenta"]);

export const sourcingScenarioLineSchema = z
  .object({
    id: idSchema,
    scenarioId: idSchema,
    supplierId: idSchema.nullable(),
    variantId: idSchema,
    variantLabel: z.string().nullable(),
    qty: positiveQuantity,
    unitPriceMinor: nonnegativeMinor,
    currency: currencySchema,
    fxAssumed: positiveFxRate,
    leadTimeDays: z.number().int().nonnegative().nullable(),
    projectedLandedPyg: pygAmountSchema,
    projectedPricePyg: pygAmountSchema,
    projectedMarginPct: marginPct.nullable(),
  })
  .strict();
export type SourcingScenarioLineDto = z.infer<typeof sourcingScenarioLineSchema>;

export const sourcingAssumptionsSchema = z
  .object({
    freightTotalMinor: nonnegativeMinor,
    /** RN-SRC-01: tiene que coincidir con la moneda de las líneas, o el costo puesto no se puede sumar. */
    freightCurrency: currencySchema,
    freightMethod: freightMethodSchema,
    tariffRate: ratio,
  })
  .strict();
export type SourcingAssumptions = z.infer<typeof sourcingAssumptionsSchema>;

export const sourcingScenarioSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    assumptions: sourcingAssumptionsSchema,
    convertedToPurchaseOrderId: idSchema.nullable(),
    createdBy: idSchema,
    createdAt: z.iso.datetime(),
    lines: z.array(sourcingScenarioLineSchema),
  })
  .strict();
export type SourcingScenarioDto = z.infer<typeof sourcingScenarioSchema>;

// Línea de entrada al crear un escenario — separada de sourcingScenarioLineSchema
// (esa es la fila ya persistida, con projectedLandedPyg/projectedMarginPct
// calculados). Exportada aparte para que un formulario de vista previa
// (apps/admin) la reuse en vez de copiar sus reglas (.claude/rules/frontend.md:
// "los formularios usan los esquemas Zod de packages/contracts").
export const createSourcingScenarioLineInput = z
  .object({
    supplierId: idSchema.nullable().optional(),
    variantId: idSchema,
    variantLabel: z.string().trim().min(1).max(1).nullable().optional(),
    qty: positiveQuantity,
    unitPriceMinor: nonnegativeMinor,
    currency: currencySchema,
    fxAssumed: positiveFxRate,
    leadTimeDays: z.number().int().nonnegative().nullable().optional(),
    /** Resuelta por el llamador (catálogo, o la tasa por defecto del tenant) — RN-SRC-02. */
    vatRate: vatRateSchema,
    /** Precio de venta proyectado, por unidad, bruto (con IVA incluido). */
    projectedPricePyg: pygAmountSchema,
  })
  .strict();
export type CreateSourcingScenarioLineInput = z.infer<typeof createSourcingScenarioLineInput>;

export const createSourcingScenarioInput = z
  .object({
    name: z.string().trim().min(1),
    assumptions: sourcingAssumptionsSchema,
    lines: z.array(createSourcingScenarioLineInput).min(1),
  })
  .strict();
export type CreateSourcingScenarioInput = z.infer<typeof createSourcingScenarioInput>;

export const sourcingScenarioByIdInput = z.object({ id: idSchema }).strict();
export const removeSourcingScenarioOutput = z.object({ ok: z.literal(true) }).strict();
export const listSourcingScenariosInput = paginationInputSchema.strict();
export const listSourcingScenariosOutput = paginatedOutputSchema(sourcingScenarioSchema);

// RF-SRC-05 · contract-first, sin endpoint todavía (WP-C16b decide la forma
// final). `converted_to_po_id` es de la CABEZA del escenario (una sola FK),
// así que convertir filtra por `variantLabel` cuando el escenario compara
// más de una alternativa. La opción no elegida no se borra como EFECTO de
// convertir — pero el escenario SÍ admite DELETE manual completo (a
// diferencia de purchase_orders/suppliers/etc.): docs/security-spec.md
// dice que un escenario "es una simulación, no historial de costo ni plata
// recibida, y no tiene estado con el que desactivarlo" (migración 0032).
// Corrección de la revisión cruzada: una versión anterior de este
// comentario decía "nunca se borra", citando security-spec.md para lo
// contrario de lo que dice.
export const convertSourcingScenarioInput = z
  .object({
    scenarioId: idSchema,
    /** Qué alternativa convertir, si el escenario compara más de una. Si todas las líneas comparten la misma (o no tienen), se omite. */
    variantLabel: z.string().trim().min(1).max(1).optional(),
    supplierId: idSchema,
    code: z.string().trim().min(1),
    expectedAt: z.iso.date().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();
export type ConvertSourcingScenarioInput = z.infer<typeof convertSourcingScenarioInput>;

export const convertSourcingScenarioOutput = z.object({ purchaseOrderId: idSchema }).strict();
