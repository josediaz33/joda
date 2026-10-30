import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DEV_DATA_DIR, TOTP_SECRETS_PATH } from "./config.mjs";

// TOTP (RFC 6238 sobre RFC 4226: HMAC-SHA1, paso de 30 s, 6 dígitos) para los
// usuarios de prueba. Es el mismo cálculo que apps/api/src/adapters/totp.ts,
// reescrito acá a propósito: `apps/*` no se importan entre sí y estos scripts
// tampoco dependen de código de la API. Si alguno de los dos cálculos se
// desviara, el login de los usuarios de prueba fallaría en el acto.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

/** @param {string} secret */
export function base32Decode(secret) {
  let bits = 0;
  let value = 0;
  /** @type {number[]} */
  const bytes = [];
  for (const char of secret.toUpperCase().replace(/=+$/, "")) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * @param {string} secretBase32
 * @param {number} nowMs
 * @returns {string} el código vigente en `nowMs`
 */
export function totpCode(secretBase32, nowMs) {
  const counter = BigInt(Math.floor(nowMs / 1000 / STEP_SECONDS));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const hmac = createHmac("sha1", base32Decode(secretBase32)).update(counterBuffer).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

/** Segundos que le quedan al código vigente. */
export function secondsLeft(nowMs) {
  return STEP_SECONDS - (Math.floor(nowMs / 1000) % STEP_SECONDS);
}

/**
 * Los secretos los genera la API al inscribir el segundo factor (auth.mfa.enroll)
 * y se guardan acá, en `.data/dev/` (ignorado por git): al azar por máquina, no
 * hay un secreto de desarrollo común a todas las instalaciones.
 *
 * @returns {Record<string, string>}
 */
export function readTotpSecrets(path = TOTP_SECRETS_PATH) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * @param {Record<string, string>} secrets
 */
export function writeTotpSecrets(secrets, path = TOTP_SECRETS_PATH) {
  mkdirSync(DEV_DATA_DIR, { recursive: true });
  writeFileSync(path, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows: los permisos POSIX no aplican; el archivo queda en una carpeta del repo del usuario.
  }
}
