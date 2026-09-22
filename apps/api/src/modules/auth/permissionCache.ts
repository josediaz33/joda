import type { Redis } from "ioredis";

// Caché de permisos resueltos (WP-C05, docs/security-spec.md §3.2): TTL
// 60 s, deliberadamente más corto que el caché de sesión de 15 min
// (sessionCache.ts) — revocar un rol tiene que tener efecto en un minuto, no
// cuando venza el token de acceso. Clave por userId, no por sessionId: el
// permiso es del USUARIO, no de una sesión concreta — dos sesiones del mismo
// usuario (dos dispositivos) comparten la misma entrada.
const PERMISSION_TTL_SECONDS = 60;

function cacheKey(userId: string): string {
  return `staff-permissions:${userId}`;
}

export async function getCachedPermissions(
  redis: Redis,
  userId: string,
): Promise<readonly string[] | null> {
  const raw = await redis.get(cacheKey(userId));
  if (raw === null) return null;
  return JSON.parse(raw) as readonly string[];
}

export async function setCachedPermissions(
  redis: Redis,
  userId: string,
  codes: readonly string[],
): Promise<void> {
  await redis.set(cacheKey(userId), JSON.stringify(codes), "EX", PERMISSION_TTL_SECONDS);
}
