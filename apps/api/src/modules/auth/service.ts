import {
  decideRefreshOutcome,
  err,
  ok,
  resolveStaffMfaStatus,
  type Clock,
  type Result,
  type StaffAuthProvider,
  type StaffMfaStatus,
} from "@joda/domain";
import type { PrismaClient } from "@joda/db";
import type { Redis } from "ioredis";
import { generateRefreshSecret, hashRefreshSecret } from "../../adapters/secureToken.js";
import { withTenantTx } from "../../db/withTenantTx.js";
import {
  checkBruteForceGuard,
  delay,
  recordFailedLoginAttempt,
  resetLoginAttempts,
} from "./bruteForceGuard.js";
import type { StaffSessionCookieValue } from "./cookie.js";
import {
  consumeRefreshToken,
  createStaffSession,
  findRefreshTokenByHash,
  findStaffLoginByEmail,
  getGrantedPermissionCodes,
  getStaffUserProfile,
  insertRefreshToken,
  revokeStaffSession,
  touchStaffSession,
  type StaffUserProfileRow,
} from "./repository.js";
import { getCachedPermissions, setCachedPermissions } from "./permissionCache.js";
import {
  deleteCachedStaffSession,
  getCachedStaffSession,
  setCachedStaffSession,
  type CachedStaffSession,
} from "./sessionCache.js";

// Orquestación de la sesión de personal (WP-C03, docs/security-spec.md §4).
// "Leer, decidir, escribir" (docs/api-conventions.md §1.1): la DECISIÓN de
// qué hacer con un refresco presentado vive en
// packages/domain/src/security/refreshToken.ts (`decideRefreshOutcome`),
// pura; acá solo se leen los datos que esa función necesita y se ejecuta lo
// que decide.
export interface AuthServiceDeps {
  readonly db: PrismaClient;
  readonly redis: Redis;
  readonly authProvider: StaffAuthProvider;
  readonly clock: Clock;
  /** WP-C04: 32 bytes (AES-256-GCM) — cifra/descifra el secreto TOTP (adapters/mfaSecretCipher.ts). Nunca login/refresh/logout, solo modules/auth/mfaService.ts. */
  readonly mfaEncryptionKey: Buffer;
}

/** Ventana ABSOLUTA de 8 h (docs/security-spec.md §1): no se extiende al rotar. */
const SESSION_WINDOW_MS = 8 * 60 * 60 * 1000;

export type LoginError = { readonly code: "INVALID_CREDENTIALS" } | { readonly code: "LOCKED" };

export interface LoginResult {
  readonly profile: StaffUserProfileRow;
  readonly cookie: StaffSessionCookieValue;
  readonly expiresAt: Date;
  readonly mfaStatus: StaffMfaStatus;
}

/**
 * `clientIp` identifica el intento para el guardia de fuerza bruta
 * (docs/security-spec.md §5.1, `bruteForceGuard.ts`) — nunca para decidir
 * si la credencial es válida, eso lo sigue resolviendo únicamente
 * `authProvider`/`findStaffLoginByEmail`.
 */
export async function login(
  deps: AuthServiceDeps,
  credentials: { readonly email: string; readonly password: string },
  clientIp: string,
): Promise<Result<LoginResult, LoginError>> {
  const guard = await checkBruteForceGuard(deps.redis, clientIp, credentials.email);
  if (guard.locked) return err({ code: "LOCKED" });
  await delay(guard.delayMs);

  // Las dos corren en paralelo, siempre las dos — nunca "si no existe el
  // email, ni te molestes en llamar al proveedor": eso sería justo la
  // asimetría de tiempo de respuesta que docs/security-spec.md §5.1 pide
  // evitar entre "usuario inexistente" y "contraseña incorrecta".
  const [lookup, authResult] = await Promise.all([
    findStaffLoginByEmail(deps.db, credentials.email),
    deps.authProvider.verifyPassword(credentials),
  ]);

  if (
    !authResult.ok ||
    !lookup ||
    !lookup.isActive ||
    lookup.authSubject !== authResult.value.authSubject
  ) {
    await recordFailedLoginAttempt(deps.redis, clientIp, credentials.email);
    return err({ code: "INVALID_CREDENTIALS" });
  }

  await resetLoginAttempts(deps.redis, clientIp, credentials.email);

  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + SESSION_WINDOW_MS);
  const secret = generateRefreshSecret();
  const tokenHash = hashRefreshSecret(secret);

  const { sessionId, profile } = await withTenantTx(
    deps.db,
    { userId: lookup.staffUserId, tenantId: lookup.tenantId, audience: "staff" },
    async (tx) => {
      const session = await createStaffSession(tx, {
        tenantId: lookup.tenantId,
        staffUserId: lookup.staffUserId,
        expiresAt,
      });
      await insertRefreshToken(tx, {
        tenantId: lookup.tenantId,
        sessionId: session.sessionId,
        tokenHash,
      });
      const profile = await getStaffUserProfile(tx, lookup.staffUserId);
      return { sessionId: session.sessionId, profile };
    },
  );

  // WP-C04: una sesión recién creada NUNCA nace "satisfied" — ni para un
  // usuario ya inscripto. Si naciera satisfecha, el segundo factor dejaría
  // de tener efecto después de la primera inscripción (docs/security-spec.md
  // §4.3, trampa de WP-C04).
  const mfaStatus = resolveStaffMfaStatus({
    mfaEnrolled: lookup.mfaEnrolled,
    sessionVerifiedAt: null,
  });

  await setCachedStaffSession(deps.redis, sessionId, {
    userId: lookup.staffUserId,
    tenantId: lookup.tenantId,
    audience: "staff",
    mfaStatus,
  });

  return ok({ profile, cookie: { sessionId, secret }, expiresAt, mfaStatus });
}

export type RefreshError = { readonly code: "SESSION_INVALID" | "REUSE_DETECTED" };

export interface RefreshResult {
  readonly cookie: StaffSessionCookieValue;
  readonly expiresAt: Date;
}

export async function refresh(
  deps: AuthServiceDeps,
  presented: StaffSessionCookieValue,
): Promise<Result<RefreshResult, RefreshError>> {
  const tokenHash = hashRefreshSecret(presented.secret);
  const lookup = await findRefreshTokenByHash(deps.db, tokenHash);
  const now = deps.clock.now();

  const outcome = decideRefreshOutcome({
    token: lookup && { consumedAt: lookup.consumedAt?.getTime() ?? null },
    session: lookup && {
      revokedAt: lookup.sessionRevokedAt?.getTime() ?? null,
      expiresAt: lookup.sessionExpiresAt.getTime(),
    },
    now: now.getTime(),
  });

  if (outcome.kind === "invalid" || !lookup) {
    return err({ code: "SESSION_INVALID" });
  }

  if (outcome.kind === "reuse_detected") {
    await withTenantTx(
      deps.db,
      { userId: lookup.staffUserId, tenantId: lookup.tenantId, audience: "staff" },
      (tx) =>
        revokeStaffSession(tx, {
          sessionId: lookup.sessionId,
          reason: "reuse_detected",
          revokedAt: now,
        }),
    );
    await deleteCachedStaffSession(deps.redis, lookup.sessionId);
    return err({ code: "REUSE_DETECTED" });
  }

  const newSecret = generateRefreshSecret();
  const newTokenHash = hashRefreshSecret(newSecret);

  await withTenantTx(
    deps.db,
    { userId: lookup.staffUserId, tenantId: lookup.tenantId, audience: "staff" },
    async (tx) => {
      const newToken = await insertRefreshToken(tx, {
        tenantId: lookup.tenantId,
        sessionId: lookup.sessionId,
        tokenHash: newTokenHash,
      });
      await consumeRefreshToken(tx, {
        tokenId: lookup.tokenId,
        replacedByTokenId: newToken.tokenId,
        consumedAt: now,
      });
      await touchStaffSession(tx, { sessionId: lookup.sessionId, lastUsedAt: now });
    },
  );

  await setCachedStaffSession(deps.redis, lookup.sessionId, {
    userId: lookup.staffUserId,
    tenantId: lookup.tenantId,
    audience: "staff",
    // Rotar el token de refresco NO satisface el desafío TOTP (WP-C04) —
    // son dos mecanismos distintos. `mfa_verified_at` de la sesión no
    // cambia con un refresh; solo lo cambian auth.mfa.verify/confirmEnroll.
    mfaStatus: resolveStaffMfaStatus({
      mfaEnrolled: lookup.mfaEnrolled,
      sessionVerifiedAt: lookup.sessionMfaVerifiedAt?.getTime() ?? null,
    }),
  });

  return ok({
    cookie: { sessionId: lookup.sessionId, secret: newSecret },
    expiresAt: lookup.sessionExpiresAt,
  });
}

export interface ActiveStaffSession {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly staffUserId: string;
}

/** Idempotente: cerrar sesión sobre una cookie ya inválida no es un error, no hace nada. */
export async function logout(
  deps: AuthServiceDeps,
  session: ActiveStaffSession | null,
): Promise<void> {
  if (!session) return;

  const now = deps.clock.now();
  await withTenantTx(
    deps.db,
    { userId: session.staffUserId, tenantId: session.tenantId, audience: "staff" },
    (tx) =>
      revokeStaffSession(tx, { sessionId: session.sessionId, reason: "logout", revokedAt: now }),
  );
  await deleteCachedStaffSession(deps.redis, session.sessionId);
}

export interface ResolvedStaffSession {
  readonly userId: string;
  readonly tenantId: string;
  readonly audience: "staff";
  readonly sessionId: string;
  readonly mfaStatus: StaffMfaStatus;
  /** WP-C05: nunca se guarda dentro del caché de sesión de 15 min — tiene su propio TTL de 60 s (permissionCache.ts), más corto a propósito. */
  readonly grantedPermissions: ReadonlySet<string>;
}

/**
 * Resuelve el set de permisos del usuario, SIEMPRE con su propio caché de
 * 60 s (permissionCache.ts) — nunca a partir del caché de sesión de 15 min,
 * cuyo hit/miss no tiene relación con cuándo cambió un rol. Se llama en
 * cada resolución de sesión (WP-C05, docs/security-spec.md §3.2), no solo
 * cuando el procedimiento efectivamente exige un permiso: es el mismo costo
 * que ya paga `mfaStatus` (WP-C04) por resolverse siempre, no por ruta.
 */
async function resolveGrantedPermissions(
  deps: AuthServiceDeps,
  session: { readonly userId: string; readonly tenantId: string },
): Promise<ReadonlySet<string>> {
  const cached = await getCachedPermissions(deps.redis, session.userId);
  if (cached) return new Set(cached);

  const codes = await withTenantTx(
    deps.db,
    { userId: session.userId, tenantId: session.tenantId, audience: "staff" },
    (tx) => getGrantedPermissionCodes(tx, session.userId),
  );
  await setCachedPermissions(deps.redis, session.userId, codes);
  return new Set(codes);
}

/**
 * Resuelve la sesión de CUALQUIER request (no solo auth.session.refresh):
 * camino rápido por Redis: sin ir a Postgres. Camino lento (caché vencido)
 * valida el secreto contra `staff_refresh_tokens` — y si encuentra un reúso,
 * revoca la familia ACÁ TAMBIÉN, no solo cuando el cliente llama a
 * auth.session.refresh explícito. Lo que el camino lento NUNCA hace es
 * rotar el token: eso cambiaría `staff_refresh_tokens` como efecto
 * secundario de resolver el contexto de una `query`, que por convención
 * nunca escribe (docs/api-conventions.md §2) — solo recalienta el caché de
 * 15 min con el mismo secreto, todavía vigente.
 *
 * RIESGO RESIDUAL, a propósito, sin resolver acá: "rotativo" (docs/
 * security-spec.md §4.2) describe el camino de `auth.session.refresh`, no
 * este. Si el cliente nunca llama a `refresh` explícito — nada en este
 * archivo lo fuerza a hacerlo periódicamente — el mismo secreto sigue
 * siendo válido por las 8 h enteras de la sesión sin rotar nunca, y una
 * copia de ese secreto (XSS, log, lo que sea) tampoco dispara
 * `reuse_detected` mientras ni el original ni la copia pasen por
 * `refresh`: los dos siguen autenticando en paralelo por el camino lento,
 * indistinguibles entre sí. La detección de reúso de este WP cubre el
 * camino de rotación explícita, no la ventana completa de 8 h. Cerrar esto
 * necesita que algo del lado cliente (el admin, todavía sin construir)
 * llame a `refresh` con cadencia menor a 15 min — no hay WP que lo declare
 * todavía.
 */
export async function resolveRequestSession(
  deps: AuthServiceDeps,
  cookie: StaffSessionCookieValue,
): Promise<ResolvedStaffSession | null> {
  const cached = await getCachedStaffSession(deps.redis, cookie.sessionId);
  if (cached) {
    const grantedPermissions = await resolveGrantedPermissions(deps, cached);
    return { ...cached, sessionId: cookie.sessionId, grantedPermissions };
  }

  const tokenHash = hashRefreshSecret(cookie.secret);
  const lookup = await findRefreshTokenByHash(deps.db, tokenHash);
  if (!lookup || lookup.sessionId !== cookie.sessionId) return null;

  const now = deps.clock.now();
  const outcome = decideRefreshOutcome({
    token: { consumedAt: lookup.consumedAt?.getTime() ?? null },
    session: {
      revokedAt: lookup.sessionRevokedAt?.getTime() ?? null,
      expiresAt: lookup.sessionExpiresAt.getTime(),
    },
    now: now.getTime(),
  });

  if (outcome.kind === "invalid") return null;

  if (outcome.kind === "reuse_detected") {
    await withTenantTx(
      deps.db,
      { userId: lookup.staffUserId, tenantId: lookup.tenantId, audience: "staff" },
      (tx) =>
        revokeStaffSession(tx, {
          sessionId: lookup.sessionId,
          reason: "reuse_detected",
          revokedAt: now,
        }),
    );
    await deleteCachedStaffSession(deps.redis, lookup.sessionId);
    return null;
  }

  // No se cachea `grantedPermissions` acá adentro: `cacheable` es
  // exactamente la forma de CachedStaffSession (TTL 15 min). Mezclar los
  // permisos en esa misma entrada les pegaría el TTL largo, contradiciendo
  // los 60 s de permissionCache.ts.
  const cacheable: CachedStaffSession = {
    userId: lookup.staffUserId,
    tenantId: lookup.tenantId,
    audience: "staff",
    mfaStatus: resolveStaffMfaStatus({
      mfaEnrolled: lookup.mfaEnrolled,
      sessionVerifiedAt: lookup.sessionMfaVerifiedAt?.getTime() ?? null,
    }),
  };
  await setCachedStaffSession(deps.redis, lookup.sessionId, cacheable);

  const grantedPermissions = await resolveGrantedPermissions(deps, {
    userId: lookup.staffUserId,
    tenantId: lookup.tenantId,
  });
  return { ...cacheable, sessionId: lookup.sessionId, grantedPermissions };
}
