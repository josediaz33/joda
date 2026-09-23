// Lógica pura del guarda de edición de migraciones
// (scripts/hooks/block-migration-edit.mjs). Separada en un módulo
// importable para poder testearla sin tocar el filesystem del repo real —
// ver migration-guard.test.mjs, que arma su propio repo git temporal.
import { execFileSync } from "node:child_process";
import { toPosixPath } from "../_read-hook-input.mjs";

const MIGRATION_PATTERN = /(^|\/)(packages\/db\/migrations\/[^/]+\.sql)$/i;

/** ¿La ruta (con "/" o "\", absoluta o relativa) cae dentro de packages/db/migrations/*.sql? */
export function isMigrationFilePath(filePath) {
  return MIGRATION_PATTERN.test(toPosixPath(filePath));
}

/**
 * Extrae la ruta relativa al repo ("packages/db/migrations/xxx.sql") de un
 * path de migración, sin importar si llegó absoluto o con backslashes de
 * Windows. Devuelve null si filePath no matchea — llamar solo después de
 * confirmar isMigrationFilePath(filePath).
 */
export function migrationRepoRelativePath(filePath) {
  const match = MIGRATION_PATTERN.exec(toPosixPath(filePath));
  return match ? match[2] : null;
}

const MAIN_UNRESOLVABLE = /invalid object name 'main'|unknown revision|bad revision 'main'/i;

/**
 * ¿relativePath (ej. "packages/db/migrations/0001_foundation.sql") existe
 * en la rama `main`? Consulta el árbol de git de `main` directamente vía
 * `git cat-file -e`, no el filesystem ni el checkout actual — da el mismo
 * resultado sin importar en qué rama esté parado quien corre esto.
 *
 * CONTRIBUTING.md §6 / ADR-018 prohíben editar una migración ya APLICADA
 * — aplicada significa fusionada a `main` y corrida en algún entorno
 * real, no "existe como archivo en el árbol de trabajo actual". El proxy
 * mecánico anterior (existsSync del archivo en disco) bloqueaba también
 * editar una migración nueva de una rama sin fusionar todavía, que sí es
 * correcto poder editar — un guarda más estricto que la regla que
 * implementa empuja a bypasearlo, que es peor que no tenerlo (revisión
 * cruzada de PR #50, WP-B08).
 *
 * Si no se puede resolver la rama `main` en este checkout (clon
 * superficial sin esa rama fetcheada, o un repo que todavía no la tiene),
 * no hay forma de saber si el archivo ya está aplicado — tira, en vez de
 * asumir que no lo está: fallar CERRADO es más seguro para este guarda
 * que fallar abierto en silencio.
 */
export function existsInMainBranch(relativePath, { cwd = process.cwd() } = {}) {
  if (!relativePath) return false;
  try {
    execFileSync("git", ["cat-file", "-e", `main:${relativePath}`], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    return true;
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    if (MAIN_UNRESOLVABLE.test(stderr)) {
      throw new Error(
        `No se pudo resolver la rama 'main' en ${cwd} para verificar si ${relativePath} ya está ` +
          "aplicada (CONTRIBUTING.md §6, ADR-018). Asegurate de tener 'main' fetcheada localmente " +
          "(git fetch origin main:main).",
      );
    }
    return false;
  }
}
