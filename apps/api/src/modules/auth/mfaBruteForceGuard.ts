import type { Redis } from "ioredis";

// Fuerza bruta sobre auth.mfa.confirmEnroll/auth.mfa.verify (WP-C04,
// docs/security-spec.md §5.1: "límite de tasa + retardo progresivo, bloqueo
// temporal a los 10 intentos" — generalizado acá del login a cualquier
// credencial que se prueba por intentos). Un código TOTP de 6 dígitos tiene
// solo un millón de combinaciones, mucho menos entropía que una contraseña:
// sin esto, alguien con una sesión válida pero sin el segundo factor podría
// simplemente probar códigos hasta acertar uno.
//
// Archivo separado de bruteForceGuard.ts (no una generalización de sus
// funciones) a propósito: la clave es otra dimensión — (IP, sessionId), no
// (IP, email), porque acá ya existe una sesión concreta que satisfacer, no
// un login que todavía no se sabe a quién pertenece — y bruteForceGuard.ts
// ya tiene su propia cobertura de tests que este cambio no necesita tocar.
const LOCKOUT_THRESHOLD = 10;
export const MFA_LOCKOUT_WINDOW_SECONDS = 15 * 60;
const DELAY_STEP_MS = 250;
const MAX_PROGRESSIVE_DELAY_MS = 5000;

function attemptsKey(ip: string, sessionId: string): string {
  return `mfa-attempts:${ip}:${sessionId}`;
}

export interface MfaBruteForceCheck {
  /** `true` a partir del intento 10 dentro de la ventana — se rechaza con 429 sin siquiera calcular los códigos válidos. */
  readonly locked: boolean;
  /** Retardo progresivo (ms) a esperar ANTES de verificar el código, incluso sin llegar al bloqueo. */
  readonly delayMs: number;
}

export async function checkMfaBruteForceGuard(
  redis: Redis,
  ip: string,
  sessionId: string,
): Promise<MfaBruteForceCheck> {
  const raw = await redis.get(attemptsKey(ip, sessionId));
  const attempts = raw ? Number(raw) : 0;
  return {
    locked: attempts >= LOCKOUT_THRESHOLD,
    delayMs: Math.min(attempts * DELAY_STEP_MS, MAX_PROGRESSIVE_DELAY_MS),
  };
}

/** Un `INCR` con `EXPIRE` en el primer intento: la ventana de 15 min arranca en el primer fallo, no se extiende con cada uno. */
export async function recordFailedMfaAttempt(
  redis: Redis,
  ip: string,
  sessionId: string,
): Promise<void> {
  const key = attemptsKey(ip, sessionId);
  const attempts = await redis.incr(key);
  if (attempts === 1) {
    await redis.expire(key, MFA_LOCKOUT_WINDOW_SECONDS);
  }
}

export async function resetMfaAttempts(redis: Redis, ip: string, sessionId: string): Promise<void> {
  await redis.del(attemptsKey(ip, sessionId));
}
