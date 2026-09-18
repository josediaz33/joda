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
 *
 * `seed/0001_seed_base.sql` solo carga el catálogo GLOBAL de `permissions`
 * (no es por tenant): define pero no invoca `app.seed_roles`,
 * `app.seed_chart_of_accounts` ni `app.seed_posting_rules` (ver
 * packages/db/README.md, "pnpm db:seed por sí solo..."). Un test que
 * necesite un tenant con roles reales (p. ej. la prueba de aislamiento RLS
 * de WP-B06) tiene que invocar esas funciones — o cargar
 * tests/smoke_business_flow.sql — dentro de su propio `beforeAll`, después
 * de `startTestDb()`. Esta función no lo hace por defecto: la mayoría de
 * los tests de integración no necesitan un tenant instanciado.
 */
export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer("postgres:16").start();
  const client = new Client({ connectionString: container.getConnectionUri() });

  try {
    await client.connect();
    await applyMigrations(client);
    await applySeeds(client);
  } catch (error) {
    // Si la migración o el seed fallan a mitad de camino, no dejamos el
    // contenedor huérfano esperando a que Ryuk lo recolecte: se cierra acá
    // mismo, porque quien llamó a startTestDb() nunca recibió un `stop()`
    // que invocar.
    await client.end().catch(() => {});
    await container.stop();
    throw error;
  }

  return {
    client,
    container,
    async stop() {
      await client.end();
      await container.stop();
    },
  };
}
