// Paginación por cursor, no por offset (docs/api-conventions.md §6): el
// offset se degrada y produce resultados inconsistentes cuando se insertan
// filas entre páginas. El cursor es opaco para el cliente — acá solo se
// valida que sea un string, no se interpreta su contenido.
import { z } from "zod";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export const paginationInputSchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  })
  .strict();

export type PaginationInput = z.infer<typeof paginationInputSchema>;

// Nunca `total`: obligaría a un COUNT(*) costoso en toda consulta paginada
// (docs/api-conventions.md §6). Un listado que el usuario necesita contar
// (reportes) usa un procedimiento `count` aparte, fuera de este esquema.
export function paginatedOutputSchema<ItemSchema extends z.ZodTypeAny>(itemSchema: ItemSchema) {
  return z
    .object({
      items: z.array(itemSchema),
      nextCursor: z.string().nullable(),
    })
    .strict();
}
