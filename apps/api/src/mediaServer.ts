// Segundo proceso Fastify, en un HOST distinto al de index.ts
// (docs/security-spec.md §5, fila "Carga de archivos": "servidos desde
// dominio distinto al del admin" — WP-C09). No registra @fastify/cookie ni
// tRPC: no tiene forma de leer la cookie de sesión de personal
// (__Host-joda_a es host-only, un navegador nunca se la manda a otro host)
// ni le hace falta — sirve exactamente el subárbol público de derivados
// (MEDIA_DERIVATIVE_KEY_PREFIX, packages/domain/src/catalog/media.ts),
// nunca originals/ (privado, ni root le llega).
//
// La defensa de fondo no es este servidor: es que apps/api/src/modules/media/
// reprocesa TODO con sharp a AVIF/WebP (WP-C09) — lo que esto sirve siempre
// es una imagen, sea lo que sea que alguien haya subido. Este archivo agrega
// Content-Type fijo por extensión (nunca lo que reporte el filesystem) y
// X-Content-Type-Options: nosniff como cinturón y tirantes.
import fastifyStatic from "@fastify/static";
import { MEDIA_DERIVATIVE_KEY_PREFIX } from "@joda/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { extname, join } from "node:path";

const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".webp": "image/webp",
};

/** `mediaStorageDir` es la MISMA raíz que usa LocalDiskStorage (adapters/storage/localDiskStorage.ts) — este server solo puede ver su subcarpeta MEDIA_DERIVATIVE_KEY_PREFIX, nunca originals/. */
export function buildMediaServer(mediaStorageDir: string): FastifyInstance {
  const app = Fastify({ logger: true });

  app.register(fastifyStatic, {
    root: join(mediaStorageDir, MEDIA_DERIVATIVE_KEY_PREFIX),
    prefix: `/${MEDIA_DERIVATIVE_KEY_PREFIX}/`,
    allowedPath: (pathName) =>
      Object.prototype.hasOwnProperty.call(CONTENT_TYPE_BY_EXTENSION, extname(pathName)),
    setHeaders: (reply, filePath) => {
      const contentType = CONTENT_TYPE_BY_EXTENSION[extname(filePath)];
      if (contentType) reply.header("Content-Type", contentType);
      reply.header("X-Content-Type-Options", "nosniff");
    },
  });

  return app;
}
