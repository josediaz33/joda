// Segundo factor de personal — TOTP (WP-C04, docs/security-spec.md §4.3).
// El cálculo del código en sí (HMAC-SHA1 sobre el secreto) es criptografía,
// prohibida acá (.claude/rules/domain.md, packages/domain/src/index.ts:
// "ni fs/path/crypto") — vive en apps/api/src/adapters/totp.ts. Lo que sí
// es cálculo puro, y por eso vive acá:
//
// 1. `resolveStaffMfaStatus`: la decisión de en qué estado explícito queda
//    una sesión de personal dado lo que ya se sabe de la base — la misma
//    idea que `security/refreshToken.ts` (decideRefreshOutcome) aplicada al
//    segundo factor en vez de a la rotación de tokens. La trampa de WP-C04
//    es justamente modelar esto como un estado explícito, no como una
//    excepción atrapada en cada ruta (docs/runbooks/prompts-playbook.md,
//    Sesión 24).
// 2. `buildTotpEnrollmentUri`: el `otpauth://` que una app autenticadora
//    (Google Authenticator, 1Password, ...) lee para agregar la cuenta — es
//    formateo de texto sobre datos ya conocidos, sin I/O.

/**
 * Estado de la sesión de personal frente al segundo factor.
 * - `pending_enrollment`: el usuario nunca inscribió TOTP. Solo puede
 *   completar la inscripción (docs/security-spec.md §4.3, criterio de
 *   aceptación de WP-C04).
 * - `pending_verification`: el usuario YA está inscripto, pero ESTA sesión
 *   (este login) todavía no presentó un código válido. Sin esto, el segundo
 *   factor dejaría de tener efecto después de la primera inscripción.
 * - `satisfied`: la sesión puede usar cualquier procedimiento.
 */
export type StaffMfaStatus = "pending_enrollment" | "pending_verification" | "satisfied";

export function resolveStaffMfaStatus(input: {
  readonly mfaEnrolled: boolean;
  /** epoch ms en que ESTA sesión satisfizo el desafío TOTP, o `null` si todavía no. */
  readonly sessionVerifiedAt: number | null;
}): StaffMfaStatus {
  if (!input.mfaEnrolled) return "pending_enrollment";
  if (input.sessionVerifiedAt === null) return "pending_verification";
  return "satisfied";
}

/**
 * `otpauth://totp/<issuer>:<cuenta>?secret=...&issuer=...&algorithm=SHA1&digits=6&period=30` —
 * formato estándar (Key URI Format de Google Authenticator) que cualquier
 * app TOTP interpreta para renderizar el QR de inscripción. `secretBase32`
 * ya viene generado por el adaptador (apps/api/src/adapters/totp.ts); acá
 * solo se arma el string.
 */
export function buildTotpEnrollmentUri(input: {
  readonly secretBase32: string;
  readonly accountEmail: string;
  readonly issuer: string;
}): string {
  const label = `${input.issuer}:${input.accountEmail}`;
  const params = new URLSearchParams({
    secret: input.secretBase32,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
