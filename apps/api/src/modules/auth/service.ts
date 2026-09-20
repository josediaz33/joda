import {
  decideRefreshOutcome,
  err,
  ok,
  type Clock,
  type Result,
  type StaffAuthProvider,
} from "@joda/domain";
import type { PrismaClient } from "@joda/db";
import type { Redis } from "ioredis";
import { generateRefreshSecret, hashRefreshSecret } from "../../adapters/secureToken.js";
import { withTenantTx } from "../../db/withTenantTx.js";
import type { StaffSessionCookieValue } from "./cookie.js";
import {
  consumeRefreshToken,
  createStaffSession,
  findRefreshTokenByHash,
  findStaffLoginByEmail,
  getStaffUserProfile,
  insertRefreshToken,
  revokeStaffSession,
  touchStaffSession,
  type StaffUserProfileRow,
} from "./repository.js";
import {
  deleteCachedStaffSession,
  getCachedStaffSession,
  setCachedStaffSession,
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
}

/** Ventana ABSOLUTA de 8 h (docs/security-spec.md §1): no se extiende al rotar. */
const SESSION_WINDOW_MS = 8 * 60 * 60 * 1000;

export type LoginError = { readonly code: "INVALID_CREDENTIALS" };

export interface LoginResult {
  readonly profile: StaffUserProfileRow;
  readonly cookie: StaffSessionCookieValue;
  readonly expiresAt: Date;
}

export async function login(
  deps: AuthServiceDeps,
  credentials: { readonly email: string; readonly password: string },
): Promise<Result<LoginResult, LoginError>> {
  // Las dos corren en paralelo, siempre las dos — nunca "si no existe el
  // email, ni te molestes en llamar al proveedor": eso sería justo la
  // asimetría de tiempo de respuesta que docs/security-spec.md §5.1 pide
  // evitar entre "usuario inexistente" y "contraseña incorrecta".
  const [lookup, authResult] = await Promise.all([
    findStaffLoginByEmail(deps.db, credentials.email),
    deps.authProvider.verifyPassword(credentials),
  ]);

  if (!authResult.ok) return err({ code: "INVALID_CREDENTIALS" });
  if (!lookup || !lookup.isActive || lookup.authSubject !== authResult.value.authSubject) {
    return err({ code: "INVALID_CREDENTIALS" });
  }

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

  await setCachedStaffSession(deps.redis, sessionId, {
    userId: lookup.staffUserId,
    tenantId: lookup.tenantId,
    audience: "staff",
  });

  return ok({ profile, cookie: { sessionId, secret }, expiresAt });
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
 */
export async function resolveRequestSession(
  deps: AuthServiceDeps,
  cookie: StaffSessionCookieValue,
): Promise<ResolvedStaffSession | null> {
  const cached = await getCachedStaffSession(deps.redis, cookie.sessionId);
  if (cached) {
    return { ...cached, sessionId: cookie.sessionId };
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

  const resolved: ResolvedStaffSession = {
    userId: lookup.staffUserId,
    tenantId: lookup.tenantId,
    audience: "staff",
    sessionId: lookup.sessionId,
  };
  await setCachedStaffSession(deps.redis, lookup.sessionId, resolved);
  return resolved;
}
