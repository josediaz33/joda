// Esqueleto de WP-A02, con tRPC montado desde WP-C01 (docs/api-conventions.md
// §1). Las capas modules/router-service-repository-domain llegan junto con
// el primer módulo de negocio real (WP-C08 en adelante) — acá todavía no hay
// lógica de negocio ni acceso a datos.
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import Fastify from "fastify";
import { loadEnv } from "./config/env.js";
import { assertRlsNotBypassed, createPrismaClient } from "./db/client.js";
import { createContext } from "./trpc/context.js";
import { appRouter, type AppRouter } from "./trpc/router.js";

export function buildServer() {
  const app = Fastify({ logger: true });

  app.get("/", async () => ({
    app: "@joda/api",
    mensaje: "hola mundo",
  }));

  app.register(fastifyTRPCPlugin<AppRouter>, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext,
    },
  });

  return app;
}

async function main() {
  const app = buildServer();

  try {
    // WP-C02 (docs/security-spec.md §3.1): sin DATABASE_URL_API el proceso no
    // arranca, y arranca solo después de confirmar que esa credencial no
    // elude RLS. Todavía no hay ningún procedimiento que use este cliente —
    // lo conecta y lo valida el primer módulo de negocio real (bloque C en
    // adelante) vía withTenantTx (src/db/withTenantTx.ts); esta verificación
    // es la red de seguridad que corre desde ya, en cada arranque.
    const env = loadEnv();
    const db = createPrismaClient(env.DATABASE_URL_API);
    await assertRlsNotBypassed(db);

    await app.listen({ port: env.PORT ?? 3333, host: "0.0.0.0" });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  void main();
}
