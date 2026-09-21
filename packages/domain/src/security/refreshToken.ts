// Decisión de rotación de refresco de sesión de personal (docs/security-spec.md
// §4.2, WP-C03). No es una regla de negocio del dominio de perfumería (por
// eso no cita un RN-XXX-nn, docs/testing-strategy.md §2.2) — es una
// convención de seguridad, pero la decisión en sí (¿roto, rechazo, marco
// reúso?) es exactamente el tipo de cosa que "el dominio calcula, el
// servicio orquesta" (docs/api-conventions.md §1.1): no queríamos que
// apps/api/src/modules/auth/service.ts tuviera esta rama de tres casos
// mezclada con las consultas a Postgres y Redis.
//
// Epoch-ms, no `Date` (patrón "Vencimiento futuro como epoch-ms",
// docs/engineering-principles.md Parte III; .claude/rules/domain.md prohíbe
// construir un `Date` acá) — quien orquesta (apps/api) ya trae `now` como
// número desde su propio Clock.
export interface RefreshTokenLookup {
  /** epoch ms — `null` si esta fila todavía no se consumió en ninguna rotación. */
  readonly consumedAt: number | null;
}

export interface StaffSessionLookup {
  /** epoch ms — `null` si la sesión nunca se revocó explícitamente. */
  readonly revokedAt: number | null;
  /** epoch ms — vencimiento absoluto de 8 h, fijo desde el login. */
  readonly expiresAt: number;
}

export type RefreshOutcome =
  /** Camino feliz: el token presentado es el vigente de una sesión viva. */
  | { readonly kind: "rotate" }
  /**
   * El token presentado ya estaba marcado `consumed_at`: alguien lo está
   * reusando. Quien orquesta revoca TODA la familia (`staff_sessions.revoked_at`),
   * no solo este token — es el criterio de aceptación de WP-C03.
   */
  | { readonly kind: "reuse_detected" }
  /** Token o sesión inexistentes, sesión ya revocada, o ventana de 8 h vencida. */
  | { readonly kind: "invalid" };

/**
 * `token`/`session` en `null` significa "no encontrado" — la búsqueda ya
 * pasó por `app.find_staff_refresh_token` (packages/db/migrations/
 * 0011_staff_sessions.sql) antes de llegar acá; esta función no sabe nada
 * de Postgres, solo recibe el resultado ya traducido.
 */
export function decideRefreshOutcome(input: {
  readonly token: RefreshTokenLookup | null;
  readonly session: StaffSessionLookup | null;
  readonly now: number;
}): RefreshOutcome {
  const { token, session, now } = input;

  if (token === null || session === null) return { kind: "invalid" };
  if (session.revokedAt !== null) return { kind: "invalid" };
  if (session.expiresAt <= now) return { kind: "invalid" };
  // El orden importa: un reúso sobre una sesión ya vencida/revocada es
  // "invalid" sin más (arriba), no un reúso nuevo que reportar.
  if (token.consumedAt !== null) return { kind: "reuse_detected" };

  return { kind: "rotate" };
}
