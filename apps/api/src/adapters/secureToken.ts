import { createHash, randomBytes } from "node:crypto";

// Generación y hash del secreto de refresco de sesión de personal (WP-C03,
// docs/security-spec.md §4.2). Vive en apps/api, no en packages/domain: la
// aleatoriedad y el hashing son I/O/impurezas que el dominio tiene prohibido
// tocar directo (.claude/rules/domain.md) — el dominio solo recibe el
// resultado ya calculado (packages/domain/src/security/refreshToken.ts).

/** 256 bits de entropía, codificados base64url — nunca se persiste crudo. */
export function generateRefreshSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * SHA-256 del secreto, lo único que `staff_refresh_tokens.token_hash` guarda
 * (packages/db/migrations/0011_staff_sessions.sql). Determinístico: buscar
 * por hash es una igualdad, no hace falta un hash lento tipo bcrypt — este
 * secreto ya tiene 256 bits de entropía, a diferencia de una contraseña
 * humana que un atacante podría intentar adivinar por fuerza bruta offline.
 */
export function hashRefreshSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
