import type { StaffMfaStatus } from "@joda/domain";
import type { Redis } from "ioredis";

// Caché del "token de acceso" de 15 min (docs/security-spec.md §4.2): no es
// un artefacto separado que viaje al cliente, es exactamente esto — la
// sesión resuelta, guardada en Redis para que un request autenticado no
// tenga que ir a Postgres. Cuando esta entrada no está (venció, o nunca
// existió), apps/api/src/trpc/context.ts recurre a la validación lenta
// contra `staff_refresh_tokens` (repository.ts).
const ACCESS_TTL_SECONDS = 15 * 60;

// Literal "staff", no el `Audience` de trpc/context.ts: ese archivo importa
// de este módulo (WP-C03 resuelve el contexto acá), así que importar en el
// otro sentido crearía un ciclo. Toda sesión de este módulo es de personal
// por definición (ADR-015) — `context.ts` asigna este literal al `Audience`
// más amplio (`"staff" | "customer" | "system"`) sin conversión.
export interface CachedStaffSession {
  readonly userId: string;
  readonly tenantId: string;
  readonly audience: "staff";
  /** WP-C04: se guarda ya resuelto para que el camino rápido no tenga que recalcularlo. */
  readonly mfaStatus: StaffMfaStatus;
}

function cacheKey(sessionId: string): string {
  return `staff-session:${sessionId}`;
}

export async function getCachedStaffSession(
  redis: Redis,
  sessionId: string,
): Promise<CachedStaffSession | null> {
  const raw = await redis.get(cacheKey(sessionId));
  if (raw === null) return null;
  return JSON.parse(raw) as CachedStaffSession;
}

export async function setCachedStaffSession(
  redis: Redis,
  sessionId: string,
  value: CachedStaffSession,
): Promise<void> {
  await redis.set(cacheKey(sessionId), JSON.stringify(value), "EX", ACCESS_TTL_SECONDS);
}

export async function deleteCachedStaffSession(redis: Redis, sessionId: string): Promise<void> {
  await redis.del(cacheKey(sessionId));
}
