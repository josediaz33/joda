import {
  mfaActionOutput,
  permissionCode,
  mfaConfirmEnrollInput,
  mfaEnrollOutput,
  mfaVerifyInput,
  staffLoginInput,
  staffLogoutOutput,
  staffSessionProfile,
  staffSessionCurrentOutput,
  staffSessionRefreshOutput,
} from "@joda/contracts";
import { appError, toTRPCError } from "../../middleware/errorMapper.js";
import { router, staffProcedure } from "../../trpc/trpc.js";
import { LOCKOUT_WINDOW_SECONDS } from "./bruteForceGuard.js";
import {
  clearStaffSessionCookie,
  readStaffSessionCookie,
  setStaffSessionCookie,
} from "./cookie.js";
import { toStaffSessionProfile } from "./mappers.js";
import { confirmMfaEnrollment, enrollMfa, verifyMfaChallenge } from "./mfaService.js";
import { MFA_LOCKOUT_WINDOW_SECONDS } from "./mfaBruteForceGuard.js";
import {
  login,
  getCurrentStaffProfile,
  logout,
  refresh,
  type ActiveStaffSession,
  type AuthServiceDeps,
} from "./service.js";
import type { RequestContext } from "../../trpc/context.js";

// auth.session.{login,refresh,logout} (WP-C03, docs/api-conventions.md §2:
// módulo "auth", recurso "session"). Los tres declaran `permissionExempt:
// true` (WP-C05, trpc/trpc.ts) — no por descuido, sino porque son el
// mecanismo POR EL QUE se obtiene una sesión, no una acción que requiera una
// ya existente: exigirles un permiso de negocio sería circular.
const GENERIC_LOGIN_ERROR = appError(
  "UNAUTHENTICATED_INVALID_CREDENTIALS",
  401,
  "Email o contraseña incorrectos.",
);

const SESSION_EXPIRED_ERROR = appError(
  "UNAUTHENTICATED_SESSION_EXPIRED",
  401,
  "La sesión venció o no es válida. Iniciá sesión de nuevo.",
);

const SESSION_REUSE_ERROR = appError(
  "UNAUTHENTICATED_SESSION_REUSE_DETECTED",
  401,
  "Se detectó un uso sospechoso de la sesión. Iniciá sesión de nuevo.",
);

// docs/security-spec.md §5.1 ("bloqueo temporal a los 10 intentos") +
// docs/api-conventions.md §4.2 (familia RATE_LIMITED → 429).
const LOCKED_ERROR = appError(
  "RATE_LIMITED_LOGIN_LOCKED",
  429,
  "Demasiados intentos. Esperá unos minutos antes de volver a intentar.",
);

// auth.mfa.* (WP-C04, docs/security-spec.md §4.3).
const NO_SESSION_ERROR = appError(
  "UNAUTHENTICATED_SESSION_EXPIRED",
  401,
  "La sesión venció o no es válida. Iniciá sesión de nuevo.",
);

const MFA_ALREADY_ENROLLED_ERROR = appError(
  "CONFLICT_MFA_ALREADY_ENROLLED",
  409,
  "Esta cuenta ya tiene un segundo factor inscripto.",
);

const MFA_ENROLLMENT_NOT_STARTED_ERROR = appError(
  "CONFLICT_MFA_ENROLLMENT_NOT_STARTED",
  409,
  "Todavía no iniciaste la inscripción del segundo factor.",
);

const MFA_NOT_ENROLLED_ERROR = appError(
  "CONFLICT_MFA_NOT_ENROLLED",
  409,
  "Esta cuenta todavía no tiene un segundo factor inscripto.",
);

const MFA_INVALID_CODE_ERROR = appError(
  "UNAUTHENTICATED_MFA_INVALID_CODE",
  401,
  "El código ingresado no es válido.",
);

const MFA_LOCKED_ERROR = appError(
  "RATE_LIMITED_MFA_LOCKED",
  429,
  "Demasiados intentos. Esperá unos minutos antes de volver a intentar.",
);

/**
 * auth.mfa.* necesita una sesión de personal concreta — a diferencia de
 * auth.session.login (todavía no hay sesión) y auth.session.logout
 * (tolerante a no tenerla), acá "sin sesión" es un 401 real: no hay nada
 * que inscribir o verificar. `enforceMfaGate` (trpc/trpc.ts) ya deja pasar
 * estos procedimientos con `ctx.mfaStatus` en `pending_enrollment` o
 * `pending_verification` — nunca con `ctx.audience` distinto de "staff".
 */
function requireActiveSession(ctx: RequestContext): ActiveStaffSession {
  if (ctx.audience === "staff" && ctx.sessionId && ctx.tenantId && ctx.userId) {
    return { sessionId: ctx.sessionId, tenantId: ctx.tenantId, staffUserId: ctx.userId };
  }
  throw toTRPCError(NO_SESSION_ERROR);
}

/**
 * `deps === null` solo pasa en apps/api/src/trpc/router.test.ts (WP-C01),
 * que levanta `buildServer()` sin Postgres ni Redis para probar el esqueleto
 * de ejemplo — nunca ejercita auth.session.*. Si algún día lo hiciera sin
 * pasar `deps`, esto falla con un 500 claro en vez de un `TypeError` opaco
 * sobre `deps.db`.
 */
function requireDeps(deps: AuthServiceDeps | null): AuthServiceDeps {
  if (deps === null) {
    throw toTRPCError(
      appError("INTERNAL", 500, "El servidor no tiene la sesión de personal configurada."),
    );
  }
  return deps;
}

export function createAuthRouter(deps: AuthServiceDeps | null) {
  return router({
    session: router({
      // El admin restaura el estado después de recargar sin leer la cookie
      // httpOnly. Disponible también mientras MFA está pendiente, para que
      // el cliente muestre exclusivamente la inscripción o el desafío.
      current: staffProcedure
        .meta({ mfaExempt: true, permissionExempt: true })
        .output(staffSessionCurrentOutput)
        .query(async ({ ctx }) => {
          const session = requireActiveSession(ctx);
          if (ctx.mfaStatus === null) throw toTRPCError(NO_SESSION_ERROR);
          const profile = await getCurrentStaffProfile(requireDeps(deps), session);
          return {
            profile: toStaffSessionProfile(profile, ctx.mfaStatus),
            permissions:
              ctx.mfaStatus === "satisfied"
                ? permissionCode.array().parse([...(ctx.grantedPermissions ?? [])])
                : [],
          };
        }),
      login: staffProcedure
        .meta({ permissionExempt: true })
        .input(staffLoginInput)
        .output(staffSessionProfile)
        .mutation(async ({ input, ctx }) => {
          const result = await login(requireDeps(deps), input, ctx.req.ip);
          if (!result.ok) {
            if (result.error.code === "LOCKED") {
              ctx.res.header("Retry-After", String(LOCKOUT_WINDOW_SECONDS));
              throw toTRPCError(LOCKED_ERROR);
            }
            throw toTRPCError(GENERIC_LOGIN_ERROR);
          }

          setStaffSessionCookie(ctx.res, result.value.cookie, result.value.expiresAt);
          return toStaffSessionProfile(result.value.profile, result.value.mfaStatus);
        }),

      // Lee la cookie del pedido, no un id que el cliente podría mandar
      // aparte — la rotación tiene que operar sobre el token que
      // efectivamente llegó firmado (modules/auth/cookie.ts). `mfaExempt`:
      // una sesión con el segundo factor pendiente sigue necesitando poder
      // refrescar su token de 8 h mientras completa la inscripción/desafío.
      refresh: staffProcedure
        .meta({ mfaExempt: true, permissionExempt: true })
        .output(staffSessionRefreshOutput)
        .mutation(async ({ ctx }) => {
          const cookie = readStaffSessionCookie(ctx.req);
          if (!cookie) throw toTRPCError(SESSION_EXPIRED_ERROR);

          const result = await refresh(requireDeps(deps), cookie);
          if (!result.ok) {
            clearStaffSessionCookie(ctx.res);
            throw toTRPCError(
              result.error.code === "REUSE_DETECTED" ? SESSION_REUSE_ERROR : SESSION_EXPIRED_ERROR,
            );
          }

          setStaffSessionCookie(ctx.res, result.value.cookie, result.value.expiresAt);
          return { ok: true };
        }),

      // Idempotente y tolerante: cerrar sesión sin una sesión válida no es
      // un error (docs/security-spec.md no exige lo contrario, y un cliente
      // reintentando un logout que ya se aplicó no debería ver un 401).
      // `mfaExempt`: salir tiene que funcionar sin importar en qué estado de
      // MFA haya quedado atascada la sesión.
      logout: staffProcedure
        .meta({ mfaExempt: true, permissionExempt: true })
        .output(staffLogoutOutput)
        .mutation(async ({ ctx }) => {
          const activeSession =
            ctx.audience === "staff" && ctx.sessionId && ctx.tenantId && ctx.userId
              ? { sessionId: ctx.sessionId, tenantId: ctx.tenantId, staffUserId: ctx.userId }
              : null;

          await logout(requireDeps(deps), activeSession);
          clearStaffSessionCookie(ctx.res);
          return { ok: true };
        }),
    }),

    // auth.mfa.{enroll,confirmEnroll,verify} (WP-C04, docs/api-conventions.md
    // §2: módulo "auth", recurso "mfa"). Los tres declaran `mfaExempt: true`
    // a propósito: SON el mecanismo por el que una sesión sale de
    // `pending_enrollment`/`pending_verification` — y `permissionExempt:
    // true` (WP-C05) por la misma razón que auth.session.login: completar el
    // segundo factor no es una acción de negocio con un permiso propio.
    mfa: router({
      enroll: staffProcedure
        .meta({ mfaExempt: true, permissionExempt: true })
        .output(mfaEnrollOutput)
        .mutation(async ({ ctx }) => {
          const session = requireActiveSession(ctx);
          const result = await enrollMfa(requireDeps(deps), session);
          if (!result.ok) throw toTRPCError(MFA_ALREADY_ENROLLED_ERROR);
          return result.value;
        }),

      confirmEnroll: staffProcedure
        .meta({ mfaExempt: true, permissionExempt: true })
        .input(mfaConfirmEnrollInput)
        .output(mfaActionOutput)
        .mutation(async ({ ctx, input }) => {
          const session = requireActiveSession(ctx);
          const result = await confirmMfaEnrollment(
            requireDeps(deps),
            session,
            input.code,
            ctx.req.ip,
          );
          if (!result.ok) {
            if (result.error.code === "LOCKED") {
              ctx.res.header("Retry-After", String(MFA_LOCKOUT_WINDOW_SECONDS));
              throw toTRPCError(MFA_LOCKED_ERROR);
            }
            throw toTRPCError(
              result.error.code === "ENROLLMENT_NOT_STARTED"
                ? MFA_ENROLLMENT_NOT_STARTED_ERROR
                : MFA_INVALID_CODE_ERROR,
            );
          }
          return result.value;
        }),

      verify: staffProcedure
        .meta({ mfaExempt: true, permissionExempt: true })
        .input(mfaVerifyInput)
        .output(mfaActionOutput)
        .mutation(async ({ ctx, input }) => {
          const session = requireActiveSession(ctx);
          const result = await verifyMfaChallenge(
            requireDeps(deps),
            session,
            input.code,
            ctx.req.ip,
          );
          if (!result.ok) {
            if (result.error.code === "LOCKED") {
              ctx.res.header("Retry-After", String(MFA_LOCKOUT_WINDOW_SECONDS));
              throw toTRPCError(MFA_LOCKED_ERROR);
            }
            throw toTRPCError(
              result.error.code === "NOT_ENROLLED"
                ? MFA_NOT_ENROLLED_ERROR
                : MFA_INVALID_CODE_ERROR,
            );
          }
          return result.value;
        }),
    }),
  });
}

export type AuthRouter = ReturnType<typeof createAuthRouter>;
