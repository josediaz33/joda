// Esqueleto de WP-A02, con tRPC montado desde WP-C01 (docs/api-conventions.md
// §1). Las capas modules/router-service-repository-domain llegan junto con
// el primer módulo de negocio real — WP-C03 (auth) es el primero.
import fastifyCookie from "@fastify/cookie";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import Fastify from "fastify";
import { createRedisClient } from "./adapters/redisClient.js";
import { createSupabasePasswordProvider } from "./adapters/staffAuth/supabasePasswordProvider.js";
import { systemClock } from "./adapters/systemClock.js";
import { loadEnv } from "./config/env.js";
import { assertRlsNotBypassed, createPrismaClient } from "./db/client.js";
import type { AuthServiceDeps } from "./modules/auth/service.js";
import { buildCreateContext } from "./trpc/context.js";
import { createAppRouter, type AppRouter } from "./trpc/router.js";

/**
 * `authDeps`/`sessionCookieSecret` en `null` es el camino de
 * apps/api/src/trpc/router.test.ts (WP-C01): prueba el esqueleto de ejemplo
 * sin levantar Postgres ni Redis. `sessionCookieSecret` va aparte de
 * `AuthServiceDeps` a propósito — ningún caso de uso de modules/auth/service.ts
 * lo necesita (firmar la cookie es responsabilidad del plugin de Fastify,
 * apps/api/src/modules/auth/cookie.ts nunca ve el secreto directo), solo
 * hace falta acá, al registrar `@fastify/cookie`.
 */
export function buildServer(
  authDeps: AuthServiceDeps | null = null,
  sessionCookieSecret: string | null = null,
) {
  const app = Fastify({ logger: true });

  app.register(fastifyCookie, sessionCookieSecret ? { secret: sessionCookieSecret } : {});

  app.get("/", async () => ({
    app: "@joda/api",
    mensaje: "hola mundo",
  }));

  app.register(fastifyTRPCPlugin<AppRouter>, {
    prefix: "/trpc",
    trpcOptions: {
      router: createAppRouter(authDeps),
      createContext: buildCreateContext(authDeps),
    },
  });

  return app;
}

async function main() {
  const env = loadEnv();

  // WP-C02 (docs/security-spec.md §3.1): sin DATABASE_URL_API el proceso no
  // arranca, y arranca solo después de confirmar que esa credencial no
  // elude RLS.
  const db = createPrismaClient(env.DATABASE_URL_API);
  const redis = createRedisClient(env.REDIS_URL);
  const authProvider = createSupabasePasswordProvider({
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
  });

  const authDeps: AuthServiceDeps = { db, redis, authProvider, clock: systemClock };

  const app = buildServer(authDeps, env.SESSION_SECRET);

  try {
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
