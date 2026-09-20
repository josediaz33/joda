import { Redis } from "ioredis";

// Cliente Redis de runtime (WP-C03): caché de la sesión de personal de 15
// min (apps/api/src/modules/auth/sessionCache.ts). ioredis conecta al
// construirse (no es lazy por defecto) — un Redis caído se nota al
// arrancar el proceso, no en el primer request que lo necesite.
export function createRedisClient(url: string): Redis {
  return new Redis(url);
}
