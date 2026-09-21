import { createHmac, randomBytes } from "node:crypto";

// TOTP (RFC 6238, sobre HMAC-based One-Time Password de RFC 4226) para el
// segundo factor de personal (WP-C04, docs/security-spec.md §4.3). Vive en
// apps/api, no en packages/domain: la generación del secreto (aleatoriedad)
// y el cálculo del código (HMAC-SHA1) son impurezas prohibidas ahí — mismo
// criterio que apps/api/src/adapters/secureToken.ts ya aplica al token de
// refresco. La decisión pura que SÍ depende de este cálculo
// (packages/domain/src/security/totp.ts, `resolveStaffMfaStatus`) recibe el
// resultado ya comparado, no el secreto.
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
/** 160 bits — la longitud que RFC 4226 §4 recomienda para el secreto compartido. */
const TOTP_SECRET_BYTES = 20;

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

function base32Decode(secret: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of secret.toUpperCase().replace(/=+$/, "")) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue; // separadores/espacios que algunas apps insertan al mostrar el secreto
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Secreto compartido, codificado base32 (el formato que las apps autenticadoras esperan). */
export function generateTotpSecretBase32(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

function computeTotpCodeForCounter(secretBase32: string, counter: bigint): string {
  const key = base32Decode(secretBase32);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);

  const hmac = createHmac("sha1", key).update(counterBuffer).digest();
  // `readUInt8` en vez de `hmac[i]`: con `noUncheckedIndexedAccess` el índice
  // devuelve `number | undefined` aunque el offset esté matemáticamente
  // acotado a 0-15 (0x0f) sobre un digest SHA1 de 20 bytes — `readUInt8`
  // sigue siendo `number` y de paso revienta en runtime si algún día deja de
  // estarlo, en vez de calcular con un `undefined` silencioso.
  const offset = hmac.readUInt8(hmac.length - 1) & 0x0f;
  const binCode =
    ((hmac.readUInt8(offset) & 0x7f) << 24) |
    ((hmac.readUInt8(offset + 1) & 0xff) << 16) |
    ((hmac.readUInt8(offset + 2) & 0xff) << 8) |
    (hmac.readUInt8(offset + 3) & 0xff);

  return (binCode % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, "0");
}

/**
 * Todos los códigos que cuentan como válidos AHORA, tolerando reloj
 * desincronizado: `driftSteps` pasos de 30 s para atrás y para adelante del
 * actual (con el default, una ventana de 90 s en total). Ni el dominio ni
 * el servicio deciden esta tolerancia — es parte de CÓMO se calcula el
 * código, no de qué hacer con el resultado.
 */
export function computeValidTotpCodes(
  secretBase32: string,
  nowMs: number,
  driftSteps = 1,
): readonly string[] {
  const currentCounter = BigInt(Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));
  const codes: string[] = [];
  for (let delta = -driftSteps; delta <= driftSteps; delta++) {
    codes.push(computeTotpCodeForCounter(secretBase32, currentCounter + BigInt(delta)));
  }
  return codes;
}
