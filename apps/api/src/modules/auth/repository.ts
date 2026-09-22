import type { PrismaClient } from "@joda/db";
import type { TenantTx } from "../../db/withTenantTx.js";

// Acceso a datos de la sesión de personal (WP-C03). Dos lecturas usan
// `app.find_staff_login_by_email` / `app.find_staff_refresh_token`
// (packages/db/migrations/0011_staff_sessions.sql, SECURITY DEFINER) porque
// corren ANTES de que exista un `tenant_id` en contexto — el resto son
// escrituras Prisma normales, dentro de `withTenantTx`, una vez que
// `service.ts` ya conoce el tenant y RLS puede evaluar tenant_isolation
// como siempre.

export interface StaffLoginLookup {
  readonly staffUserId: string;
  readonly tenantId: string;
  readonly authSubject: string;
  readonly isActive: boolean;
  readonly mfaEnrolled: boolean;
}

export async function findStaffLoginByEmail(
  db: PrismaClient,
  email: string,
): Promise<StaffLoginLookup | null> {
  // La función toma `text`, no `citext` (packages/db/migrations/
  // 0012_fix_staff_login_lookup_param_type.sql): `joda_api` no tiene
  // `USAGE` sobre el schema `public`, así que ni un cast `::citext` en el
  // sitio de la consulta es viable acá. La comparación adentro de la
  // función sigue siendo case-insensitive contra `staff_users.email`.
  const rows = await db.$queryRaw<
    {
      id: string;
      tenant_id: string;
      auth_subject: string;
      is_active: boolean;
      mfa_enrolled: boolean;
    }[]
  >`SELECT * FROM app.find_staff_login_by_email(${email})`;
  const row = rows[0];
  if (!row) return null;
  return {
    staffUserId: row.id,
    tenantId: row.tenant_id,
    authSubject: row.auth_subject,
    isActive: row.is_active,
    mfaEnrolled: row.mfa_enrolled,
  };
}

export interface StaffRefreshTokenLookup {
  readonly tokenId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly consumedAt: Date | null;
  readonly staffUserId: string;
  readonly sessionRevokedAt: Date | null;
  readonly sessionExpiresAt: Date;
  /** epoch de `staff_sessions.mfa_verified_at` — `null` si ESTA sesión todavía no satisfizo el desafío TOTP (WP-C04). */
  readonly sessionMfaVerifiedAt: Date | null;
  readonly mfaEnrolled: boolean;
}

export async function findRefreshTokenByHash(
  db: PrismaClient,
  tokenHash: string,
): Promise<StaffRefreshTokenLookup | null> {
  const rows = await db.$queryRaw<
    {
      token_id: string;
      tenant_id: string;
      session_id: string;
      consumed_at: Date | null;
      staff_user_id: string;
      session_revoked_at: Date | null;
      session_expires_at: Date;
      session_mfa_verified_at: Date | null;
      mfa_enrolled: boolean;
    }[]
  >`SELECT * FROM app.find_staff_refresh_token(${tokenHash})`;
  const row = rows[0];
  if (!row) return null;
  return {
    tokenId: row.token_id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    consumedAt: row.consumed_at,
    staffUserId: row.staff_user_id,
    sessionRevokedAt: row.session_revoked_at,
    sessionExpiresAt: row.session_expires_at,
    sessionMfaVerifiedAt: row.session_mfa_verified_at,
    mfaEnrolled: row.mfa_enrolled,
  };
}

export async function createStaffSession(
  tx: TenantTx,
  input: { readonly tenantId: string; readonly staffUserId: string; readonly expiresAt: Date },
): Promise<{ readonly sessionId: string }> {
  const session = await tx.staff_sessions.create({
    data: {
      tenant_id: input.tenantId,
      staff_user_id: input.staffUserId,
      expires_at: input.expiresAt,
    },
    select: { id: true },
  });
  return { sessionId: session.id };
}

export async function insertRefreshToken(
  tx: TenantTx,
  input: { readonly tenantId: string; readonly sessionId: string; readonly tokenHash: string },
): Promise<{ readonly tokenId: string }> {
  const token = await tx.staff_refresh_tokens.create({
    data: { tenant_id: input.tenantId, session_id: input.sessionId, token_hash: input.tokenHash },
    select: { id: true },
  });
  return { tokenId: token.id };
}

/** Marca un token como usado y lo encadena al que lo reemplazó — nunca se lo actualiza "en su lugar" para volverlo válido de nuevo. */
export async function consumeRefreshToken(
  tx: TenantTx,
  input: {
    readonly tokenId: string;
    readonly replacedByTokenId: string;
    readonly consumedAt: Date;
  },
): Promise<void> {
  await tx.staff_refresh_tokens.update({
    where: { id: input.tokenId },
    data: { consumed_at: input.consumedAt, replaced_by: input.replacedByTokenId },
  });
}

export async function touchStaffSession(
  tx: TenantTx,
  input: { readonly sessionId: string; readonly lastUsedAt: Date },
): Promise<void> {
  await tx.staff_sessions.update({
    where: { id: input.sessionId },
    data: { last_used_at: input.lastUsedAt },
  });
}

export async function revokeStaffSession(
  tx: TenantTx,
  input: {
    readonly sessionId: string;
    readonly reason: "logout" | "reuse_detected";
    readonly revokedAt: Date;
  },
): Promise<void> {
  await tx.staff_sessions.update({
    where: { id: input.sessionId },
    data: { revoked_at: input.revokedAt, revoked_reason: input.reason },
  });
}

export interface StaffUserProfileRow {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
}

export async function getStaffUserProfile(
  tx: TenantTx,
  staffUserId: string,
): Promise<StaffUserProfileRow> {
  const row = await tx.staff_users.findUniqueOrThrow({
    where: { id: staffUserId },
    select: { id: true, email: true, full_name: true },
  });
  return { id: row.id, email: row.email, fullName: row.full_name };
}

// ---------------------------------------------------------------------
// Segundo factor (WP-C04, docs/security-spec.md §4.3). Estas, a diferencia
// de findStaffLoginByEmail/findRefreshTokenByHash, corren DENTRO de
// withTenantTx — el request ya trae una sesión de personal resuelta
// (ctx.userId/ctx.tenantId), así que RLS evalúa normalmente, sin necesitar
// una función SECURITY DEFINER.
// ---------------------------------------------------------------------
export interface StaffMfaSecretRow {
  readonly mfaEnrolled: boolean;
  /** El cifrado (adapters/mfaSecretCipher.ts) — `null` si nunca se llamó a auth.mfa.enroll. */
  readonly secretEncrypted: string | null;
}

export async function getStaffMfaSecret(
  tx: TenantTx,
  staffUserId: string,
): Promise<StaffMfaSecretRow> {
  const row = await tx.staff_users.findUniqueOrThrow({
    where: { id: staffUserId },
    select: { mfa_enrolled: true, mfa_secret_encrypted: true },
  });
  return { mfaEnrolled: row.mfa_enrolled, secretEncrypted: row.mfa_secret_encrypted };
}

/** Guarda el secreto generado por auth.mfa.enroll SIN inscribir todavía — mfa_enrolled sigue en false hasta confirmar el primer código. */
export async function setPendingMfaSecret(
  tx: TenantTx,
  input: { readonly staffUserId: string; readonly secretEncrypted: string },
): Promise<void> {
  await tx.staff_users.update({
    where: { id: input.staffUserId },
    data: { mfa_secret_encrypted: input.secretEncrypted },
  });
}

/** auth.mfa.confirmEnroll: inscribe al usuario Y satisface el desafío de ESTA sesión en la misma transacción — ya probó posesión del código. */
export async function recordMfaEnrollmentConfirmed(
  tx: TenantTx,
  input: { readonly staffUserId: string; readonly sessionId: string; readonly verifiedAt: Date },
): Promise<void> {
  await tx.staff_users.update({
    where: { id: input.staffUserId },
    data: { mfa_enrolled: true },
  });
  await tx.staff_sessions.update({
    where: { id: input.sessionId },
    data: { mfa_verified_at: input.verifiedAt },
  });
}

export async function markSessionMfaVerified(
  tx: TenantTx,
  input: { readonly sessionId: string; readonly verifiedAt: Date },
): Promise<void> {
  await tx.staff_sessions.update({
    where: { id: input.sessionId },
    data: { mfa_verified_at: input.verifiedAt },
  });
}

// ---------------------------------------------------------------------
// Permisos (WP-C05, docs/security-spec.md §2). Corre DENTRO de
// withTenantTx, igual que las lecturas de MFA de arriba: la sesión ya está
// resuelta, así que RLS evalúa `roles.tenant_isolation` normalmente al
// atravesar esa relación — `role_permissions`/`staff_user_roles` no tienen
// `tenant_id` propio (packages/db/migrations/0002_identity_rbac.sql), así
// que el aislamiento de tenant de esta consulta depende de tocar `roles`.
// ---------------------------------------------------------------------
export async function getGrantedPermissionCodes(
  tx: TenantTx,
  staffUserId: string,
): Promise<readonly string[]> {
  const rows = await tx.role_permissions.findMany({
    where: { roles: { staff_user_roles: { some: { staff_user_id: staffUserId } } } },
    select: { permission_code: true },
    distinct: ["permission_code"],
  });
  return rows.map((row) => row.permission_code);
}
