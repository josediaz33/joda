import type { Redis } from "ioredis";

// Fuerza bruta sobre auth.session.login (docs/security-spec.md §5.1:
// "Límite de tasa + retardo progresivo. Bloqueo temporal a los 10
// intentos."). Acotado a este único endpoint — el límite de tasa GENERAL
// de docs/api-conventions.md §11 ("Autenticación: 5/min por IP + usuario",
// con la misma cabecera `Retry-After`) es una pieza de infraestructura
// transversal a TODOS los endpoints, todavía sin dueño en ningún WP; no se
// construye acá.
//
// La clave combina IP y email (misma dimensión que la tabla de §11): un
// atacante que prueba muchas contraseñas contra un email desde una IP fija
// se bloquea sin arriesgar bloquear a un usuario legítimo que además esté
// fallando su propio login desde otra IP.
const LOCKOUT_THRESHOLD = 10;
export const LOCKOUT_WINDOW_SECONDS = 15 * 60;
const DELAY_STEP_MS = 250;
const MAX_PROGRESSIVE_DELAY_MS = 5000;

function attemptsKey(ip: string, email: string): string {
  return `login-attempts:${ip}:${email.toLowerCase()}`;
}

export interface BruteForceCheck {
  /** `true` a partir del intento 10 dentro de la ventana — auth.session.login lo rechaza con 429 sin llamar al proveedor. */
  readonly locked: boolean;
  /** Retardo progresivo (ms) a esperar ANTES de verificar la contraseña, incluso sin llegar al bloqueo. */
  readonly delayMs: number;
}

export async function checkBruteForceGuard(
  redis: Redis,
  ip: string,
  email: string,
): Promise<BruteForceCheck> {
  const raw = await redis.get(attemptsKey(ip, email));
  const attempts = raw ? Number(raw) : 0;
  return {
    locked: attempts >= LOCKOUT_THRESHOLD,
    delayMs: Math.min(attempts * DELAY_STEP_MS, MAX_PROGRESSIVE_DELAY_MS),
  };
}

/** Un `INCR` con `EXPIRE` en el primer intento: la ventana de 15 min arranca en el primer fallo, no se extiende con cada uno. */
export async function recordFailedLoginAttempt(
  redis: Redis,
  ip: string,
  email: string,
): Promise<void> {
  const key = attemptsKey(ip, email);
  const attempts = await redis.incr(key);
  if (attempts === 1) {
    await redis.expire(key, LOCKOUT_WINDOW_SECONDS);
  }
}

export async function resetLoginAttempts(redis: Redis, ip: string, email: string): Promise<void> {
  await redis.del(attemptsKey(ip, email));
}

export function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
