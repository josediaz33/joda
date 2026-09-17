import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { listSqlFilesSorted, readSqlFile } from "./sql-files.mjs";

// packages/db/scripts/lib/tasks.mjs -> packages/db
const dbRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const migrationsDir = join(dbRoot, "migrations");
const seedDir = join(dbRoot, "seed");
const testsDir = join(dbRoot, "tests");

/**
 * Aplica migrations/*.sql en orden de nombre de archivo (ADR-018: el SQL es
 * la fuente de verdad, sin tabla de versiones — el orden lo da el nombre).
 * Cada archivo se manda como un único lote: si no abre su propia
 * transacción, el protocolo simple de libpq lo ejecuta como una sola
 * transacción implícita, así que un error a mitad de archivo no deja
 * objetos a medio crear.
 */
export async function applyMigrations(client) {
  for (const file of listSqlFilesSorted(migrationsDir)) {
    console.log(`[db:migrate] ${file}`);
    await client.query(readSqlFile(file));
  }
}

/** Aplica seed/*.sql en orden. Cada archivo es idempotente por diseño (ON
 * CONFLICT DO NOTHING, CREATE OR REPLACE FUNCTION) — correrlo dos veces no
 * duplica filas.
 */
export async function applySeeds(client) {
  for (const file of listSqlFilesSorted(seedDir)) {
    console.log(`[db:seed] ${file}`);
    await client.query(readSqlFile(file));
  }
}

/**
 * Deja la base en blanco para volver a migrar desde cero. Borra los
 * esquemas en vez de la base entera: DROP DATABASE exige desconectarse de
 * la base que se quiere borrar (no se puede hacer con la misma conexión), y
 * una credencial contra Postgres administrado (Supabase, RDS) rara vez
 * tiene permiso para crear/borrar bases, pero sí para manejar sus propios
 * esquemas.
 */
export async function resetSchema(client) {
  console.log("[db:reset] DROP SCHEMA app, public — empezando de cero");
  await client.query(`
    DROP SCHEMA IF EXISTS app CASCADE;
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
  `);
}

export function testFile(name) {
  return join(testsDir, name);
}
