// Decisión del middleware de idempotencia general (docs/api-conventions.md
// §5, WP-C06) — DISTINTO del mecanismo de payment_events para webhooks
// (docs/api-conventions.md §5.1): esa es otra tabla, con otro ciclo de vida,
// no comparte esta decisión. No es una regla de negocio de perfumería (por
// eso no cita un RN-XXX-nn, docs/testing-strategy.md §2.2) — es la misma
// separación que decidePermissionAccess (authorization.ts) y
// decideRefreshOutcome (refreshToken.ts): la DECISIÓN vive acá, pura;
// apps/api/src/db/withIdempotentTx.ts solo la ejecuta, dentro de la misma
// transacción que el efecto.
export interface IdempotencyRecord<TResponse> {
  readonly requestHash: string;
  readonly response: TResponse;
  readonly statusCode: number;
}

export type IdempotencyOutcome<TResponse> =
  /** No hay clave previa: el llamador ejecuta el efecto y lo persiste. */
  | { readonly kind: "run" }
  /** Mismo `(tenant_id, scope, key)` y mismo hash de cuerpo: se devuelve la respuesta guardada, sin reprocesar. */
  | { readonly kind: "replay"; readonly response: TResponse; readonly statusCode: number }
  /** Mismo `(tenant_id, scope, key)` con un cuerpo distinto: reuso de clave. */
  | { readonly kind: "conflict" };

/**
 * `existing` ya llegó resuelto por `(tenant_id, scope, key)` — esta función
 * no sabe nada de Postgres ni de cómo se buscó, solo decide qué hacer con lo
 * que se encontró (o no).
 */
export function decideIdempotencyOutcome<TResponse>(input: {
  readonly existing: IdempotencyRecord<TResponse> | null;
  readonly requestHash: string;
}): IdempotencyOutcome<TResponse> {
  const { existing, requestHash } = input;

  if (existing === null) return { kind: "run" };
  if (existing.requestHash !== requestHash) return { kind: "conflict" };
  return { kind: "replay", response: existing.response, statusCode: existing.statusCode };
}
