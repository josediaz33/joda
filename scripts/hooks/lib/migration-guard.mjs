// Lógica pura del guarda de edición de migraciones
// (scripts/hooks/block-migration-edit.mjs). Separada en un módulo
// importable para poder testearla sin tocar el filesystem — ver
// migration-guard.test.mjs. El chequeo de existsSync() sigue en el hook:
// es I/O real, no pertenece acá.
import { toPosixPath } from "../_read-hook-input.mjs";

const MIGRATION_PATTERN = /(^|\/)packages\/db\/migrations\/[^/]+\.sql$/i;

/** ¿La ruta (con "/" o "\", absoluta o relativa) cae dentro de packages/db/migrations/*.sql? */
export function isMigrationFilePath(filePath) {
  return MIGRATION_PATTERN.test(toPosixPath(filePath));
}
