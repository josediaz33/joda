// Esqueleto de WP-A02: servidor Fastify mínimo para que el pipeline de CI
// tenga algo que tipar, lintear, testear y construir. El contexto de
// petición, el router tRPC y las capas de docs/api-conventions.md llegan en
// WP-C01 — acá no hay lógica de negocio ni acceso a datos.
import Fastify from "fastify";

export function buildServer() {
  const app = Fastify({ logger: true });

  app.get("/", async () => ({
    app: "@joda/api",
    mensaje: "hola mundo",
  }));

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
