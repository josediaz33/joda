import { buildTotpEnrollmentUri, err, ok, type Result, type StaffMfaStatus } from "@joda/domain";
import { decryptMfaSecret, encryptMfaSecret } from "../../adapters/mfaSecretCipher.js";
import { computeValidTotpCodes, generateTotpSecretBase32 } from "../../adapters/totp.js";
import { withTenantTx } from "../../db/withTenantTx.js";
import { delay } from "./bruteForceGuard.js";
import {
  checkMfaBruteForceGuard,
  recordFailedMfaAttempt,
  resetMfaAttempts,
} from "./mfaBruteForceGuard.js";
import {
  getStaffMfaSecret,
  getStaffUserProfile,
  markSessionMfaVerified,
  recordMfaEnrollmentConfirmed,
  setPendingMfaSecret,
} from "./repository.js";
import { setCachedStaffSession } from "./sessionCache.js";
import type { ActiveStaffSession, AuthServiceDeps } from "./service.js";

// Inscripción y verificación de TOTP (WP-C04, docs/security-spec.md §4.3),
// sobre una sesión de personal YA autenticada por contraseña
// (modules/auth/service.ts, WP-C03) — este archivo nunca verifica
// contraseñas ni crea sesiones, solo cambia el estado de segundo factor de
// una que ya existe.
const MFA_ISSUER = "JODA Parfums";

async function cacheSatisfiedSession(
  deps: AuthServiceDeps,
  session: ActiveStaffSession,
): Promise<void> {
  await setCachedStaffSession(deps.redis, session.sessionId, {
    userId: session.staffUserId,
    tenantId: session.tenantId,
    audience: "staff",
    mfaStatus: "satisfied",
  });
}

export type MfaEnrollError = { readonly code: "ALREADY_ENROLLED" };

export interface MfaEnrollResult {
  /** Base32, para que quien no pueda escanear el QR lo tipee a mano. Se muestra una sola vez — no se puede volver a pedir. */
  readonly secret: string;
  readonly otpauthUri: string;
}

/** auth.mfa.enroll: genera y guarda un secreto PENDIENTE — mfa_enrolled sigue en false hasta auth.mfa.confirmEnroll. */
export async function enrollMfa(
  deps: AuthServiceDeps,
  session: ActiveStaffSession,
): Promise<Result<MfaEnrollResult, MfaEnrollError>> {
  return withTenantTx(
    deps.db,
    {
      userId: session.staffUserId,
      tenantId: session.tenantId,
      audience: "staff",
      sessionId: session.sessionId,
    },
    async (tx) => {
      const current = await getStaffMfaSecret(tx, session.staffUserId);
      if (current.mfaEnrolled) return err({ code: "ALREADY_ENROLLED" });

      const profile = await getStaffUserProfile(tx, session.staffUserId);
      const secret = generateTotpSecretBase32();
      await setPendingMfaSecret(tx, {
        staffUserId: session.staffUserId,
        secretEncrypted: encryptMfaSecret(secret, deps.mfaEncryptionKey),
      });

      return ok({
        secret,
        otpauthUri: buildTotpEnrollmentUri({
          secretBase32: secret,
          accountEmail: profile.email,
          issuer: MFA_ISSUER,
        }),
      });
    },
  );
}

export type MfaConfirmEnrollError =
  | { readonly code: "ENROLLMENT_NOT_STARTED" }
  | { readonly code: "INVALID_CODE" }
  | { readonly code: "LOCKED" };

type ConfirmOutcome =
  | { readonly kind: "not_started" }
  | { readonly kind: "invalid_code" }
  | { readonly kind: "confirmed" };

/** auth.mfa.confirmEnroll: primer código válido → inscribe Y satisface el desafío de ESTA sesión (ya probó posesión). */
export async function confirmMfaEnrollment(
  deps: AuthServiceDeps,
  session: ActiveStaffSession,
  code: string,
  clientIp: string,
): Promise<Result<{ readonly mfaStatus: StaffMfaStatus }, MfaConfirmEnrollError>> {
  const guard = await checkMfaBruteForceGuard(deps.redis, clientIp, session.sessionId);
  if (guard.locked) return err({ code: "LOCKED" });
  await delay(guard.delayMs);

  const now = deps.clock.now();

  const outcome = await withTenantTx(
    deps.db,
    {
      userId: session.staffUserId,
      tenantId: session.tenantId,
      audience: "staff",
      sessionId: session.sessionId,
    },
    async (tx): Promise<ConfirmOutcome> => {
      const current = await getStaffMfaSecret(tx, session.staffUserId);
      if (current.mfaEnrolled || !current.secretEncrypted) return { kind: "not_started" };

      const secret = decryptMfaSecret(current.secretEncrypted, deps.mfaEncryptionKey);
      if (!computeValidTotpCodes(secret, now.getTime()).includes(code)) {
        return { kind: "invalid_code" };
      }

      await recordMfaEnrollmentConfirmed(tx, {
        staffUserId: session.staffUserId,
        sessionId: session.sessionId,
        verifiedAt: now,
      });
      return { kind: "confirmed" };
    },
  );

  if (outcome.kind === "not_started") return err({ code: "ENROLLMENT_NOT_STARTED" });
  if (outcome.kind === "invalid_code") {
    await recordFailedMfaAttempt(deps.redis, clientIp, session.sessionId);
    return err({ code: "INVALID_CODE" });
  }

  await resetMfaAttempts(deps.redis, clientIp, session.sessionId);
  await cacheSatisfiedSession(deps, session);
  return ok({ mfaStatus: "satisfied" });
}

export type MfaVerifyError =
  | { readonly code: "NOT_ENROLLED" }
  | { readonly code: "INVALID_CODE" }
  | { readonly code: "LOCKED" };

type VerifyOutcome =
  | { readonly kind: "not_enrolled" }
  | { readonly kind: "invalid_code" }
  | { readonly kind: "verified" };

/** auth.mfa.verify: el desafío que TODA sesión de un usuario ya inscripto tiene que pasar — sin esto, el segundo factor solo importaría la primera vez. */
export async function verifyMfaChallenge(
  deps: AuthServiceDeps,
  session: ActiveStaffSession,
  code: string,
  clientIp: string,
): Promise<Result<{ readonly mfaStatus: StaffMfaStatus }, MfaVerifyError>> {
  const guard = await checkMfaBruteForceGuard(deps.redis, clientIp, session.sessionId);
  if (guard.locked) return err({ code: "LOCKED" });
  await delay(guard.delayMs);

  const now = deps.clock.now();

  const outcome = await withTenantTx(
    deps.db,
    {
      userId: session.staffUserId,
      tenantId: session.tenantId,
      audience: "staff",
      sessionId: session.sessionId,
    },
    async (tx): Promise<VerifyOutcome> => {
      const current = await getStaffMfaSecret(tx, session.staffUserId);
      if (!current.mfaEnrolled || !current.secretEncrypted) return { kind: "not_enrolled" };

      const secret = decryptMfaSecret(current.secretEncrypted, deps.mfaEncryptionKey);
      if (!computeValidTotpCodes(secret, now.getTime()).includes(code)) {
        return { kind: "invalid_code" };
      }

      await markSessionMfaVerified(tx, { sessionId: session.sessionId, verifiedAt: now });
      return { kind: "verified" };
    },
  );

  if (outcome.kind === "not_enrolled") return err({ code: "NOT_ENROLLED" });
  if (outcome.kind === "invalid_code") {
    await recordFailedMfaAttempt(deps.redis, clientIp, session.sessionId);
    return err({ code: "INVALID_CODE" });
  }

  await resetMfaAttempts(deps.redis, clientIp, session.sessionId);
  await cacheSatisfiedSession(deps, session);
  return ok({ mfaStatus: "satisfied" });
}
