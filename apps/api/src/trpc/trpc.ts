// Instancia de tRPC de apps/api, con contexto real (docs/api-conventions.md
// §1: "apps/api arma su propia instancia de tRPC con contexto", a diferencia
// de la de packages/contracts/src/example/ping.ts, que no tiene contexto
// porque solo prueba que el patrón compila — WP-A11).
import { initTRPC } from "@trpc/server";
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
// cada router nuevo tenga que acordarse de nada. El mismo punto de
// extensión que WP-C05 va a usar para agregar `permission`
// (docs/api-conventions.md §9) — no se inventa esa forma acá, se deja lugar.
export interface ProcedureMeta {
  readonly mfaExempt?: boolean;
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
const MFA_ENROLLMENT_REQUIRED_ERROR = appError(
  "UNAUTHENTICATED_MFA_ENROLLMENT_REQUIRED",
  401,
  "Tenés que inscribir un segundo factor antes de continuar.",
);

const MFA_VERIFICATION_REQUIRED_ERROR = appError(
  "UNAUTHENTICATED_MFA_VERIFICATION_REQUIRED",
  401,
  "Ingresá el código de tu segundo factor antes de continuar.",
);

// `ctx.mfaStatus === null` deja pasar — pero NO significa "autorizado", solo
// "no aplica": es lo que trae toda request sin sesión de personal (audiencia
// distinta de "staff", o directamente sin cookie), incluida una anónima. Este
// gate resuelve exclusivamente el segundo factor de una sesión que YA existe
// (docs/security-spec.md §4.3); exigir que EXISTA sesión para empezar es un
// requisito distinto y todavía sin dueño — WP-C05 (permisos), pendiente en
// docs/backlog.md. Quien agregue un módulo de negocio nuevo no puede asumir
// que este middleware ya cubre "necesita estar autenticado": hoy no lo hace.
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

export const router = t.router;
export const procedure = t.procedure.use(catchPgErrors).use(enforceMfaGate);
