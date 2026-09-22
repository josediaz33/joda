// Cursor opaco de paginación (docs/api-conventions.md §6: "El cursor es
// opaco: base64 de (orden, id). El cliente no lo interpreta"). Acá alcanza
// con envolver el `id` de la última fila: cada procedimiento de listado usa
// SIEMPRE su propio `orderBy` fijo del lado del servidor (nunca uno que el
// cliente elija), así que el cursor NATIVO de Prisma (`cursor: { id }, skip:
// 1`) ya resuelve la posición correcta dentro de ese orden compuesto sin
// necesitar el valor de orden viajando aparte — agregarlo solo duplicaría un
// dato que el cliente nunca lee ni puede alterar.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

/** `null` ante cualquier cursor corrupto o ajeno — el caller lo trata como VALIDATION_INVALID_CURSOR, nunca como "sin más páginas". */
export function decodeCursor(raw: string): string | null {
  let id: string;
  try {
    id = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  return UUID_PATTERN.test(id) ? id : null;
}
