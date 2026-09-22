// Instancia de tRPC de apps/api, con contexto real (docs/api-conventions.md
// §1: "apps/api arma su propia instancia de tRPC con contexto", a diferencia
// de la de packages/contracts/src/example/ping.ts, que no tiene contexto
// porque solo prueba que el patrón compila — WP-A11).
import { initTRPC } from "@trpc/server";
import type { PermissionCode } from "@joda/contracts";
import { decidePermissionAccess } from "@joda/domain";
import {
  appError,
  isApiError,
  isPgError,
  mapPgError,
  toTRPCError,
} from "../middleware/errorMapper.js";
import type { RequestContext } from "./context.js";

// `mfaExempt` (WP-C04, docs/security-spec.md §4.3): declarado por los pocos
// procedimientos que una sesión de personal con el segundo factor pendiente
// SÍ puede usar (auth.session.refresh/logout, auth.mfa.*) — todo lo demás
// queda bloqueado por `enforceMfaGate` de abajo, automáticamente, sin que
// cada router nuevo tenga que acordarse de nada.
//
// `permission`/`permissionExempt` (WP-C05, docs/api-conventions.md §9): todo
// procedimiento de negocio declara `permission`, el código exacto que exige
// `enforcePermissionGate`. `permissionExempt: true` es SOLO para el puñado
// de procedimientos que son el mecanismo de autenticación en sí
// (auth.session.*, auth.mfa.*, mismo criterio que `mfaExempt`) o scaffolding
// de transporte sin permiso de negocio real (example.*, WP-C01) — nunca para
// un procedimiento de negocio nuevo. `router.permissions.test.ts` recorre
// TODO el router y falla si algún procedimiento no declara ni una cosa ni la
// otra.
export interface ProcedureMeta {
  readonly mfaExempt?: boolean;
  readonly permission?: PermissionCode;
  readonly permissionExempt?: boolean;
}

export const t = initTRPC
  .context<RequestContext>()
  .meta<ProcedureMeta>()
  .create({
    errorFormatter(opts) {
      const { shape, error, ctx } = opts;
      const apiError = isApiError(error.cause) ? error.cause : undefined;

      // Un error sin ApiError adjunto y sin código tRPC reconocido (es decir,
      // un bug real, no un CHECK/UNIQUE/FK traducido) nunca expone su mensaje
      // original — puede contener detalles internos. docs/api-conventions.md
      // §4.4: "ningún mensaje de PostgreSQL llega al usuario, ni siquiera
      // traducido a medias" se generaliza acá a cualquier error no traducido.
      const message =
        apiError?.message ??
        (error.code === "INTERNAL_SERVER_ERROR"
          ? "Ocurrió un error interno. Intentá de nuevo en unos minutos."
          : shape.message);

      return {
        ...shape,
        message,
        data: {
          ...shape.data,
          appCode:
            apiError?.code ??
            (error.code === "INTERNAL_SERVER_ERROR" ? "INTERNAL" : shape.data.code),
          details: apiError?.details,
          requestId: ctx?.requestId ?? null,
        },
      };
    },
  });

// Middleware global: si algo debajo de un procedimiento deja escapar un
// error de Postgres crudo (ERRCODE de cinco caracteres) sin haberlo
// traducido, lo traduce acá — una sola vez, no en cada repository. Cuando
// WP-C02 conecte apps/api a Postgres de verdad, cualquier error que ese
// cliente tire pasa por este mismo camino sin que el módulo que lo lanzó
// tenga que acordarse de llamar a mapPgError.
//
// `next()` de tRPC v11 NO relanza el error del resolver como excepción de
// JS: internamente lo atrapa y lo devuelve como `{ ok: false, error }` (ver
// `callRecursive` en @trpc/server) para poder acumular metadata de
// middleware sin usar control de flujo por excepción. Por eso esto no es un
// `try/catch` alrededor de `next()` — hay que inspeccionar el resultado. El
// error original crudo sobrevive en `error.cause` (getTRPCErrorFromUnknown
// lo adjunta sin envolver si ya es un Error, que es el caso de cualquier
// error real de `pg`).
const catchPgErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && isPgError(result.error.cause)) {
    throw toTRPCError(mapPgError(result.error.cause));
  }
  return result;
});

// docs/security-spec.md §4.3, criterio de aceptación de WP-C04: "un usuario
// de personal sin segundo factor inscripto puede autenticarse con
// contraseña, pero solo puede acceder a la pantalla de inscripción" — y,
// simétricamente (ver packages/domain/src/security/totp.ts), un usuario YA
// inscripto necesita satisfacer el desafío TOTP en CADA sesión nueva antes
// de usar cualquier otra cosa. `ctx.mfaStatus` ya llega resuelto
// (trpc/context.ts, `resolveRequestSession`) — acá solo se decide bloquear
// o no, una sola vez, para TODO procedimiento futuro, no ruta por ruta (la
// trampa explícita de la Sesión 24 del playbook: modelar esto como un
// estado de sesión, no como una excepción atrapada en cada handler).
// Exportados (no solo `const` de módulo) porque modules/media/httpRoutes.ts
// (WP-C09, docs/api-conventions.md §1, excepción documentada) reimplementa
// este mismo gate fuera de tRPC — mismos mensajes, sin duplicar el texto.
export const MFA_ENROLLMENT_REQUIRED_ERROR = appError(
  "UNAUTHENTICATED_MFA_ENROLLMENT_REQUIRED",
  401,
  "Tenés que inscribir un segundo factor antes de continuar.",
);

export const MFA_VERIFICATION_REQUIRED_ERROR = appError(
  "UNAUTHENTICATED_MFA_VERIFICATION_REQUIRED",
  401,
  "Ingresá el código de tu segundo factor antes de continuar.",
);

// `ctx.mfaStatus === null` deja pasar — pero NO significa "autorizado", solo
// "no aplica": es lo que trae toda request sin sesión de personal (audiencia
// distinta de "staff", o directamente sin cookie), incluida una anónima. Este
// gate resuelve exclusivamente el segundo factor de una sesión que YA existe
// (docs/security-spec.md §4.3); exigir que EXISTA sesión para empezar es
// responsabilidad de `enforcePermissionGate`, más abajo (WP-C05) — un
// procedimiento de negocio no autenticado devuelve 404 ahí, no acá.
const enforceMfaGate = t.middleware(({ ctx, meta, next }) => {
  if (ctx.mfaStatus === null || ctx.mfaStatus === "satisfied" || meta?.mfaExempt) {
    return next();
  }
  throw toTRPCError(
    ctx.mfaStatus === "pending_enrollment"
      ? MFA_ENROLLMENT_REQUIRED_ERROR
      : MFA_VERIFICATION_REQUIRED_ERROR,
  );
});

// docs/security-spec.md §3.2 / ADR-016, "Capa 2 — defensa principal". La
// DECISIÓN (¿granted, 404 o 403?) vive en packages/domain
// (`decidePermissionAccess`, WP-C05) — acá solo se ejecuta: se lee
// `ctx.grantedPermissions` (ya resuelto por `trpc/context.ts` con su propio
// caché de 60 s, `modules/auth/permissionCache.ts`), nunca se hace I/O
// desde este middleware.
//
// Un procedimiento sin `permission` NI `permissionExempt` es un bug de
// configuración, no un caso de negocio — "falla en el arranque, no en
// producción" (docs/api-conventions.md §9) es lo que prueba
// `router.permissions.test.ts` recorriendo el router entero; este 500 es la
// red de más abajo, por si ese test no corrió.
// Exportados por el mismo motivo que los dos de arriba — modules/media/httpRoutes.ts.
export const NOT_FOUND_ERROR = appError("NOT_FOUND", 404, "No encontrado.");
export const FORBIDDEN_ERROR = appError(
  "FORBIDDEN_INSUFFICIENT_PERMISSION",
  403,
  "No tenés permiso para realizar esta acción.",
);
const MISSING_PERMISSION_DECLARATION_ERROR = appError(
  "INTERNAL",
  500,
  "Ocurrió un error interno. Intentá de nuevo en unos minutos.",
);

const enforcePermissionGate = t.middleware(({ ctx, meta, next }) => {
  if (meta?.permissionExempt) return next();
  if (!meta?.permission) throw toTRPCError(MISSING_PERMISSION_DECLARATION_ERROR);

  const outcome = decidePermissionAccess({
    hasStaffSession: ctx.grantedPermissions !== null,
    requiredPermission: meta.permission,
    grantedPermissions: ctx.grantedPermissions ?? new Set(),
  });

  if (outcome.kind === "granted") return next();
  throw toTRPCError(outcome.httpStatus === 404 ? NOT_FOUND_ERROR : FORBIDDEN_ERROR);
});

export const router = t.router;
// docs/api-conventions.md §9: "staffProcedure verifica audiencia y permiso
// en el middleware" — `enforceMfaGate` corre ANTES que `enforcePermissionGate`
// a propósito: una sesión con el segundo factor pendiente no debería
// enterarse de si el módulo que pidió existe o no (404 vs. 403) antes de
// terminar de autenticarse.
export const staffProcedure = t.procedure
  .use(catchPgErrors)
  .use(enforceMfaGate)
  .use(enforcePermissionGate);
