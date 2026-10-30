import { createHmac, timingSafeEqual } from "node:crypto";

// JWT HS256 mínimo para las dos claves del Auth local (WP-M18): la clave
// anónima (rol `anon`) y la de servicio (rol `service_role`), firmadas con
// GOTRUE_JWT_SECRET igual que las de un proyecto de Supabase. No es una
// biblioteca de JWT: firma y verifica ESE formato y nada más.

/** @param {unknown} value */
function encodePart(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * @param {string} signingInput
 * @param {string} secret
 */
function signature(signingInput, secret) {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

/**
 * @param {{ secret: string; role: "anon" | "service_role"; issuedAtSeconds: number; ttlSeconds: number }} options
 */
export function signLocalJwt({ secret, role, issuedAtSeconds, ttlSeconds }) {
  const header = encodePart({ alg: "HS256", typ: "JWT" });
  const payload = encodePart({
    iss: "joda-local",
    role,
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + ttlSeconds,
  });
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${signature(signingInput, secret)}`;
}

/**
 * ¿La firma de este JWT corresponde a `secret` y el rol y la vigencia son los
 * esperados? Sirve para decidir si una clave que ya estaba en `.env.local`
 * sigue valiendo o hay que firmar una nueva.
 *
 * @param {string} token
 * @param {{ secret: string; role: string; nowSeconds: number }} expected
 */
export function isValidLocalJwt(token, { secret, role, nowSeconds }) {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [header, payload, given] = /** @type {[string, string, string]} */ (parts);
  const expectedSignature = Buffer.from(signature(`${header}.${payload}`, secret));
  const givenSignature = Buffer.from(given);
  if (
    expectedSignature.length !== givenSignature.length ||
    !timingSafeEqual(expectedSignature, givenSignature)
  ) {
    return false;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims.role === role && typeof claims.exp === "number" && claims.exp > nowSeconds;
  } catch {
    return false;
  }
}
