import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { IdempotencyRequest } from "../db/withIdempotentTx.js";

/** docs/api-conventions.md §5. Fastify normaliza los nombres de header a minúsculas en `req.headers`. */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/** `scope` de `idempotency_keys` para toda mutación de tRPC — distinto del de webhooks (§5.1, otra tabla). */
export const API_IDEMPOTENCY_SCOPE = "api";

export function readIdempotencyKeyHeader(req: FastifyRequest): string | null {
  const value = req.headers[IDEMPOTENCY_KEY_HEADER];
  const key = Array.isArray(value) ? value[0] : value;
  return key && key.length > 0 ? key : null;
}

/**
 * Serializa `input` con las claves ordenadas para que el hash no cambie por
 * el orden en que el cliente serializó el JSON — dos cuerpos
 * semánticamente iguales tienen que dar el mismo hash.
 */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashIdempotencyRequestBody(input: unknown): string {
  return createHash("sha256").update(canonicalize(input)).digest("hex");
}

/**
 * Arma el `IdempotencyRequest` que consume `withIdempotentTx` a partir del
 * header de la petición y el input ya validado por Zod — `null` si el
 * cliente no mandó `Idempotency-Key` (docs/api-conventions.md §5: la
 * cabecera es opcional, no un middleware global sobre toda mutación).
 */
export function buildIdempotencyRequest(
  req: FastifyRequest,
  input: unknown,
): IdempotencyRequest | null {
  const key = readIdempotencyKeyHeader(req);
  if (key === null) return null;
  return { scope: API_IDEMPOTENCY_SCOPE, key, requestHash: hashIdempotencyRequestBody(input) };
}
