import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { applyMigrations, applySeeds } from "../../scripts/lib/tasks.mjs";

export interface TestDb {
  client: Client;
  container: StartedPostgreSqlContainer;
  stop(): Promise<void>;
}

/**
 * Levanta un Postgres 16 efímero vía Testcontainers, aplica migrations/ y
 * seed/ (los mismos archivos y el mismo runner que `pnpm db:reset`, ver
 * scripts/lib/tasks.mjs) y devuelve un cliente ya conectado.
 *
 * Se llama UNA vez por archivo de test, en `beforeAll` — nunca dentro de un
 * `it()`. Recrear el contenedor por test es lo que hace que una corrida
 * tarde minutos en vez de segundos (docs/testing-strategy.md §3, WP-B05).
 */
export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer("postgres:16").start();
  const client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  await applyMigrations(client);
  await applySeeds(client);

  return {
    client,
    container,
    async stop() {
      await client.end();
      await container.stop();
    },
  };
}
