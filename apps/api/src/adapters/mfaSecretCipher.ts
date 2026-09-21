import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Cifrado del secreto TOTP de personal en reposo (WP-C04, docs/security-spec.md
// §4.3 y §6: "el secreto TOTP no es un dato más — tratalo con el mismo
// cuidado que un password"). A diferencia del token de refresco
// (adapters/secureToken.ts, SHA-256 de un solo sentido: solo hace falta
// COMPARAR), este secreto hay que poder recuperarlo para calcular el código
// vigente (adapters/totp.ts) — un hash no sirve acá, tiene que ser
// reversible. AES-256-GCM: cifrado autenticado, así que un `staff_users`
// filtrado sin la clave (MFA_ENCRYPTION_KEY, fuera de esta base) no alcanza
// para derivar el secreto NI para alterarlo sin que `decryptMfaSecret`
// lo note (`setAuthTag` rechaza un texto cifrado modificado).
const ALGORITHM = "aes-256-gcm";
/** 96 bits — el tamaño de IV que NIST SP 800-38D recomienda para GCM. */
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/** `key`: exactamente 32 bytes (AES-256) — `Buffer.from(env.MFA_ENCRYPTION_KEY, "hex")`. */
export function encryptMfaSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // iv ‖ authTag ‖ ciphertext, todo en un único valor de texto — mismo
  // criterio que `staff_sessions`: una columna, no tres, para lo que
  // siempre viaja junto.
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptMfaSecret(encoded: string, key: Buffer): string {
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, IV_BYTES);
  const authTag = raw.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + AUTH_TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
