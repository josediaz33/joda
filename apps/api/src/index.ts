// Esqueleto de WP-A02, con tRPC montado desde WP-C01 (docs/api-conventions.md
// §1). Las capas modules/router-service-repository-domain llegan junto con
// el primer módulo de negocio real — WP-C03 (auth) es el primero.
import fastifyCookie from "@fastify/cookie";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import type { ObjectStorage } from "@joda/domain";
import Fastify from "fastify";
import { createRedisClient } from "./adapters/redisClient.js";
import { createSupabasePasswordProvider } from "./adapters/staffAuth/supabasePasswordProvider.js";
import {
  assertLocalDiskStorageAllowedInProduction,
  createLocalDiskStorage,
} from "./adapters/storage/localDiskStorage.js";
import { systemClock } from "./adapters/systemClock.js";
import { loadEnv } from "./config/env.js";
import { assertRlsNotBypassed, createPrismaClient } from "./db/client.js";
import type { AuthServiceDeps } from "./modules/auth/service.js";
import { registerMediaHttpRoutes } from "./modules/media/httpRoutes.js";
import { buildMediaServer } from "./mediaServer.js";
import { buildCreateContext } from "./trpc/context.js";
import { createAppRouter, type AppRouter } from "./trpc/router.js";

export interface MediaServerConfig {
  readonly storage: ObjectStorage | null;
  readonly mediaPublicBaseUrl: string | null;
}

/**
 * `authDeps`/`sessionCookieSecret` en `null` es el camino de
 * apps/api/src/trpc/router.test.ts (WP-C01): prueba el esqueleto de ejemplo
 * sin levantar Postgres ni Redis. `sessionCookieSecret` va aparte de
 * `AuthServiceDeps` a propósito — ningún caso de uso de modules/auth/service.ts
 * lo necesita (firmar la cookie es responsabilidad del plugin de Fastify,
 * apps/api/src/modules/auth/cookie.ts nunca ve el secreto directo), solo
 * hace falta acá, al registrar `@fastify/cookie`. `mediaConfig` sigue el
 * mismo criterio (WP-C09): sin almacenamiento configurado, el proceso
 * arranca igual — solo la ruta de subida de medios devuelve un 500 claro
 * si alguien la usa (modules/media/httpRoutes.ts, `requireStorage`).
 */
export function buildServer(
  authDeps: AuthServiceDeps | null = null,
  sessionCookieSecret: string | null = null,
  mediaConfig: MediaServerConfig = { storage: null, mediaPublicBaseUrl: null },
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

  registerMediaHttpRoutes(app, {
    db: authDeps?.db ?? null,
    authDeps,
    storage: mediaConfig.storage,
    mediaPublicBaseUrl: mediaConfig.mediaPublicBaseUrl,
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

  const authDeps: AuthServiceDeps = {
    db,
    redis,
    authProvider,
    clock: systemClock,
    // WP-C04: 64 caracteres hex → 32 bytes (AES-256-GCM), validado por
    // config/env.ts. adapters/mfaSecretCipher.ts nunca recibe el string crudo.
    mfaEncryptionKey: Buffer.from(env.MFA_ENCRYPTION_KEY, "hex"),
  };

  // WP-C09: mismo criterio que assertRlsNotBypassed — un adaptador que no
  // debería llegar a producción no arranca el proceso en silencio.
  assertLocalDiskStorageAllowedInProduction(process.env.NODE_ENV);
  // Reusa SESSION_SECRET para firmar `storage.signedUrl()` — ninguna ruta de
  // este WP la invoca todavía (nada sirve contenido privado; las derivadas
  // públicas de catálogo van sin firmar, mediaServer.ts). Cuando exista una
  // ruta real que sirva contenido privado con URL firmada (revisión cruzada
  // del PR #48: RF-CAT-09 es publicar/despublicar, no esto — todavía no hay
  // un WP puntual para "servir borrador con URL firmada"), separar el
  // secreto en su propia MEDIA_SIGNING_SECRET — mismo criterio que
  // MFA_ENCRYPTION_KEY frente a SESSION_SECRET (WP-C04): un secreto por
  // propósito, no compartido, en cuanto el propósito sea real.
  const storage = createLocalDiskStorage({
    rootDir: env.MEDIA_STORAGE_DIR,
    publicBaseUrl: env.MEDIA_PUBLIC_BASE_URL,
    signingSecret: env.SESSION_SECRET,
  });

  const app = buildServer(authDeps, env.SESSION_SECRET, {
    storage,
    mediaPublicBaseUrl: env.MEDIA_PUBLIC_BASE_URL,
  });

  // Segundo proceso Fastify, en el HOST de MEDIA_PUBLIC_BASE_URL — nunca el
  // mismo host que `app` (env.ts ya lo validó al cargar `env`).
  // docs/security-spec.md §5: "servidos desde dominio distinto al del
  // admin". mediaServer.ts documenta por qué.
  const mediaServer = buildMediaServer(env.MEDIA_STORAGE_DIR);
  const mediaPort = Number(new URL(env.MEDIA_PUBLIC_BASE_URL).port || 80);

  try {
    await assertRlsNotBypassed(db);
    // WP-M18: `HOST` (opcional) acota la interfaz; sin él, 0.0.0.0 como siempre.
    const host = env.HOST ?? "0.0.0.0";
    await app.listen({ port: env.PORT ?? 3333, host });
    await mediaServer.listen({ port: mediaPort, host });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  void main();
}
