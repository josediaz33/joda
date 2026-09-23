import { z } from "zod";
import { currencySchema, paginationInputSchema, paginatedOutputSchema } from "./shared/index.js";

const uuid = z.uuid();
const nonnegativeMinor = z.string().regex(/^\d+$/);
const positiveQuantity = z.string().regex(/^(?:[1-9]\d*(?:\.\d{1,3})?|0\.(?!0{1,3}$)\d{1,3})$/);
const poStatus = z.enum([
  "draft",
  "pending_approval",
  "approved",
  "sent",
  "partially_received",
  "received",
  "cancelled",
]);
const freightMethod = z.enum(["by_value", "by_unit", "by_volume", "manual"]);

export const supplierSchema = z
  .object({
    id: uuid,
    code: z.string(),
    name: z.string(),
    country: z.string().nullable(),
    defaultCurrency: currencySchema,
    paymentTermsDays: z.number().int(),
    leadTimeDays: z.number().int().nullable(),
    isActive: z.boolean(),
    notes: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type SupplierDto = z.infer<typeof supplierSchema>;
export const createSupplierInput = z
  .object({
    code: z.string().trim().min(1),
    name: z.string().trim().min(1),
    country: z.string().length(2).nullable().optional(),
    defaultCurrency: currencySchema,
    paymentTermsDays: z.number().int().nonnegative(),
    leadTimeDays: z.number().int().nonnegative().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();
export const updateSupplierInput = createSupplierInput
  .partial()
  .extend({ id: uuid, isActive: z.boolean().optional() })
  .strict();
export const supplierByIdInput = z.object({ id: uuid }).strict();
export const listSuppliersInput = paginationInputSchema
  .extend({ isActive: z.boolean().optional() })
  .strict();
export const listSuppliersOutput = paginatedOutputSchema(supplierSchema);

export const purchaseOrderLineSchema = z
  .object({
    id: uuid,
    variantId: uuid,
    qtyOrdered: z.string(),
    qtyReceived: z.string(),
    uom: z.enum(["unit", "ml"]),
    unitPriceMinor: nonnegativeMinor,
    destination: z.string().nullable(),
    position: z.number().int(),
  })
  .strict();
export const purchaseOrderTransitionSchema = z
  .object({
    id: z.string(),
    fromStatus: poStatus.nullable(),
    toStatus: poStatus,
    actorId: uuid.nullable(),
    reason: z.string().nullable(),
    occurredAt: z.iso.datetime(),
  })
  .strict();
export const purchaseOrderSchema = z
  .object({
    id: uuid,
    supplierId: uuid,
    code: z.string(),
    status: poStatus,
    currency: currencySchema,
    fxRateToPyg: z.string().nullable(),
    freightMinor: nonnegativeMinor,
    customsMinor: nonnegativeMinor,
    otherCostsMinor: nonnegativeMinor,
    freightMethod,
    expectedAt: z.string().nullable(),
    notes: z.string().nullable(),
    createdBy: uuid,
    approvedBy: uuid.nullable(),
    approvedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    lines: z.array(purchaseOrderLineSchema),
    transitions: z.array(purchaseOrderTransitionSchema),
  })
  .strict();
export type PurchaseOrderDto = z.infer<typeof purchaseOrderSchema>;
export const createPurchaseOrderInput = z
  .object({
    supplierId: uuid,
    code: z.string().trim().min(1),
    currency: currencySchema,
    fxRateToPyg: z
      .string()
      .regex(/^(?!0+(?:\.0+)?$)\d+(?:\.\d{1,8})?$/)
      .nullable()
      .optional(),
    freightMinor: nonnegativeMinor.optional(),
    customsMinor: nonnegativeMinor.optional(),
    otherCostsMinor: nonnegativeMinor.optional(),
    freightMethod: freightMethod.optional(),
    expectedAt: z.iso.date().nullable().optional(),
    notes: z.string().nullable().optional(),
    lines: z
      .array(
        z
          .object({
            variantId: uuid,
            qtyOrdered: positiveQuantity,
            uom: z.enum(["unit", "ml"]),
            unitPriceMinor: nonnegativeMinor,
            destination: z.string().nullable().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export const purchaseOrderByIdInput = z.object({ id: uuid }).strict();
export const listPurchaseOrdersInput = paginationInputSchema
  .extend({ supplierId: uuid.optional(), status: poStatus.optional() })
  .strict();
export const listPurchaseOrdersOutput = paginatedOutputSchema(purchaseOrderSchema);
export const transitionPurchaseOrderInput = z
  .object({
    id: uuid,
    toStatus: z.enum(["pending_approval", "draft", "sent", "cancelled"]),
    reason: z.string().trim().min(1).nullable().optional(),
  })
  .strict();
export const approvePurchaseOrderInput = z
  .object({ id: uuid, reason: z.string().trim().min(1).nullable().optional() })
  .strict();

export type CreateSupplierInput = z.infer<typeof createSupplierInput>;
export type UpdateSupplierInput = z.infer<typeof updateSupplierInput>;
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderInput>;
export type TransitionPurchaseOrderInput = z.infer<typeof transitionPurchaseOrderInput>;
