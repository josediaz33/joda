// Esquemas del módulo medios (WP-C09, RF-CAT-08). A diferencia del resto de
// packages/contracts, el endpoint que consume `uploadProductMediaFields` NO
// es un procedimiento tRPC (docs/api-conventions.md §1 documenta la
// excepción): la carga es multipart, no JSON, así que viaja como campos de
// formulario junto al archivo, no como body de una mutation. El esquema
// igual vive acá — sigue siendo la frontera de validación de esos campos
// (.claude/rules/contracts.md: "todo esquema lleva .strict()"), y
// `adminMediaSchema` es la forma exacta que la ruta devuelve.
import { z } from "zod";
import { idSchema } from "./shared/id.js";

export const mediaDerivativeFormatSchema = z.enum(["avif", "webp"]);
export type MediaDerivativeFormat = z.infer<typeof mediaDerivativeFormatSchema>;

export const uploadProductMediaFields = z
  .object({
    productId: idSchema,
    variantId: idSchema.optional(),
    altText: z.string().min(1).max(500).optional(),
    position: z.coerce.number().int().min(0).optional(),
  })
  .strict();
export type UploadProductMediaFields = z.infer<typeof uploadProductMediaFields>;

export const mediaDerivativeSchema = z
  .object({
    width: z.number().int().positive(),
    format: mediaDerivativeFormatSchema,
    url: z.string().url(),
  })
  .strict();
export type MediaDerivative = z.infer<typeof mediaDerivativeSchema>;

// Sin `sha256` ni `bucket`/`objectKey` acá a propósito: son detalle de
// almacenamiento (docs/api-conventions.md §7, mismo criterio que "costos,
// proveedores y márgenes jamás en un DTO público" — acá no hay DTO público
// todavía, pero tampoco hace falta exponer el layout interno del bucket a
// quien consume la API administrativa; `derivatives[].url` alcanza para
// mostrar la imagen).
export const adminMediaSchema = z
  .object({
    id: idSchema,
    productId: idSchema,
    variantId: idSchema.nullable(),
    altText: z.string().nullable(),
    position: z.number().int(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    bytes: z.number().int().positive(),
    mimeType: z.string(),
    derivatives: z.array(mediaDerivativeSchema),
    createdAt: z.string(),
  })
  .strict();
export type AdminMedia = z.infer<typeof adminMediaSchema>;
