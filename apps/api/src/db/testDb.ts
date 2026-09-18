import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";

// packages/db/migrations y packages/db/seed son la única fuente de verdad
// del esquema (ADR-018) — este helper los aplica leyendo los mismos archivos
// que packages/db/scripts/lib/tasks.mjs, sin importar ese módulo: es un
// script .mjs interno de otro paquete, no parte de la superficie pública de
// @joda/db (que WP-C02 dejó acotada a src/client.ts, ver packages/db/README.md
// hallazgo 8). Duplicar este runner de ~20 líneas es más barato que atarse a
// un archivo interno ajeno.
const HERE = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(HERE, "../../../../packages/db");
const MIGRATIONS_DIR = join(DB_ROOT, "migrations");
const SEED_DIR = join(DB_ROOT, "seed");

function listSqlFilesSorted(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => join(dir, name));
}

function readSqlFile(path: string): string {
  // migrations/ y seed/ están escritos para `psql -f` y pueden llevar
  // metacomandos (`\echo`, `\set`) que el protocolo simple de `pg` no
  // entiende — se descartan acá, los archivos en disco no se tocan (mismo
  // criterio que packages/db/scripts/lib/sql-files.mjs).
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("\\"))
    .join("\n");
}

export interface TestDb {
  container: StartedPostgreSqlContainer;
  superuserClient: Client;
  connectionUri: string;
  stop(): Promise<void>;
}

/**
 * Levanta un Postgres 16 efímero y aplica migrations/ + seed/ reales —
 * incluido seed/0002_seed_joda_api_credential.sql (WP-C02), que deja
 * `joda_api` con password conocida. Quien llame se conecta como `joda_api`
 * con esa password, nunca con el superusuario del contenedor.
 */
export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer("postgres:16").start();
  const connectionUri = container.getConnectionUri();
  const superuserClient = new Client({ connectionString: connectionUri });

  try {
    await superuserClient.connect();
    for (const file of listSqlFilesSorted(MIGRATIONS_DIR)) {
      await superuserClient.query(readSqlFile(file));
    }
    for (const file of listSqlFilesSorted(SEED_DIR)) {
      await superuserClient.query(readSqlFile(file));
    }
  } catch (error) {
    await superuserClient.end().catch(() => {});
    await container.stop();
    throw error;
  }

  return {
    container,
    superuserClient,
    connectionUri,
    async stop() {
      await superuserClient.end();
      await container.stop();
    },
  };
}

/**
 * URL de conexión como `joda_api`, con la password que deja
 * seed/0002_seed_joda_api_credential.sql. `connection_limit=1` fuerza al
 * pool interno de Prisma a una única conexión física — necesario para poder
 * probar que dos transacciones consecutivas no comparten el contexto de
 * sesión que el pool recicla (docs/api-conventions.md §8.1).
 */
export function jodaApiConnectionUrl(
  container: StartedPostgreSqlContainer,
  params: Record<string, string> = {},
): string {
  const query = new URLSearchParams({ connection_limit: "1", ...params }).toString();
  return `postgresql://joda_api:joda_api@${container.getHost()}:${container.getPort()}/${container.getDatabase()}?${query}`;
}
