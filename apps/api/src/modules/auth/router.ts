import {
  staffLoginInput,
  staffLogoutOutput,
  staffSessionProfile,
  staffSessionRefreshOutput,
} from "@joda/contracts";
import { appError, toTRPCError } from "../../middleware/errorMapper.js";
import { procedure, router } from "../../trpc/trpc.js";
import {
  clearStaffSessionCookie,
  readStaffSessionCookie,
  setStaffSessionCookie,
} from "./cookie.js";
import { toStaffSessionProfile } from "./mappers.js";
import { login, logout, refresh, type AuthServiceDeps } from "./service.js";

// auth.session.{login,refresh,logout} (WP-C03, docs/api-conventions.md §2:
// módulo "auth", recurso "session"). Ninguno declara `meta.permission`
// (docs/api-conventions.md §9) — no por descuido, sino porque los tres son
// el mecanismo POR EL QUE se obtiene una sesión, no una acción que requiera
// una ya existente. El mismo matiz que dejó abierto la revisión cruzada de
// WP-C01 para `example.ping` (docs/backlog.md): quien implemente WP-C05
// tiene que decidir si el chequeo "todo procedimiento declara permiso"
// exceptúa este router entero o si login/refresh/logout necesitan su propio
// tipo de procedimiento (`publicProcedure`/`sessionProcedure`) que quede
// afuera de esa regla por construcción.
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
      login: procedure
        .input(staffLoginInput)
        .output(staffSessionProfile)
        .mutation(async ({ input, ctx }) => {
          const result = await login(requireDeps(deps), input);
          if (!result.ok) throw toTRPCError(GENERIC_LOGIN_ERROR);

          setStaffSessionCookie(ctx.res, result.value.cookie, result.value.expiresAt);
          return toStaffSessionProfile(result.value.profile);
        }),

      // Lee la cookie del pedido, no un id que el cliente podría mandar
      // aparte — la rotación tiene que operar sobre el token que
      // efectivamente llegó firmado (modules/auth/cookie.ts).
      refresh: procedure.output(staffSessionRefreshOutput).mutation(async ({ ctx }) => {
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
      logout: procedure.output(staffLogoutOutput).mutation(async ({ ctx }) => {
        const activeSession =
          ctx.audience === "staff" && ctx.sessionId && ctx.tenantId && ctx.userId
            ? { sessionId: ctx.sessionId, tenantId: ctx.tenantId, staffUserId: ctx.userId }
            : null;

        await logout(requireDeps(deps), activeSession);
        clearStaffSessionCookie(ctx.res);
        return { ok: true };
      }),
    }),
  });
}

export type AuthRouter = ReturnType<typeof createAuthRouter>;
