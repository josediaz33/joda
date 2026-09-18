// Instancia de tRPC de apps/api, con contexto real (docs/api-conventions.md
// §1: "apps/api arma su propia instancia de tRPC con contexto", a diferencia
// de la de packages/contracts/src/example/ping.ts, que no tiene contexto
// porque solo prueba que el patrón compila — WP-A11).
import { initTRPC } from "@trpc/server";
import { isApiError, isPgError, mapPgError, toTRPCError } from "../middleware/errorMapper.js";
import type { RequestContext } from "./context.js";

export const t = initTRPC.context<RequestContext>().create({
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
          apiError?.code ?? (error.code === "INTERNAL_SERVER_ERROR" ? "INTERNAL" : shape.data.code),
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

export const router = t.router;
export const procedure = t.procedure.use(catchPgErrors);
