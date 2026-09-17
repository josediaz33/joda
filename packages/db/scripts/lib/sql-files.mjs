import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * migrations/, seed/ y tests/ están escritos para correr con `psql -f`, y
 * algunos usan metacomandos de psql (\echo, \set) que documentan el flujo
 * para quien los lee a mano (ver packages/db/README.md). El servidor de
 * Postgres no los entiende — no son SQL, son directivas del cliente psql —
 * así que cualquier línea que empiece con `\` se descarta antes de mandar
 * el archivo por este driver. Los archivos en disco no se tocan.
 */
export function stripPsqlMetaCommands(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("\\"))
    .join("\n");
}

export function listSqlFilesSorted(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => join(dir, name));
}

export function readSqlFile(path) {
  return stripPsqlMetaCommands(readFileSync(path, "utf8"));
}
