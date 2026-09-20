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
    { id: string; tenant_id: string; auth_subject: string; is_active: boolean }[]
  >`SELECT * FROM app.find_staff_login_by_email(${email})`;
  const row = rows[0];
  if (!row) return null;
  return {
    staffUserId: row.id,
    tenantId: row.tenant_id,
    authSubject: row.auth_subject,
    isActive: row.is_active,
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
