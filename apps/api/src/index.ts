// Esqueleto de WP-A02, con tRPC montado desde WP-C01 (docs/api-conventions.md
// §1). Las capas modules/router-service-repository-domain llegan junto con
// el primer módulo de negocio real (WP-C08 en adelante) — acá todavía no hay
// lógica de negocio ni acceso a datos.
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import Fastify from "fastify";
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
  const port = Number(process.env.PORT ?? 3333);

  try {
    await app.listen({ port, host: "0.0.0.0" });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  void main();
}
