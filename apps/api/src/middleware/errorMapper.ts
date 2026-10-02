// Traduce errores de PostgreSQL a errores de API en español, con código
// estable (docs/api-conventions.md §4.4). Nadie más traduce: un handler que
// atrapa un error de Postgres y arma su propio mensaje es exactamente lo que
// esta pieza existe para evitar.
//
// `PgError` es una forma ESTRUCTURAL, no el tipo `DatabaseError` del driver
// `pg` — apps/api todavía no tiene una conexión real a Postgres (eso es
// WP-C02); cuando la tenga, sea vía `pg` o vía Prisma, lo único que hace
// falta pasar acá es el ERRCODE de cinco caracteres (SQLSTATE) y el mensaje
// crudo. Decisión deliberada: este archivo no depende de qué cliente de base
// termine usando C02.
import { TRPCError } from "@trpc/server";

export interface PgError {
  code?: string;
  message?: string;
  detail?: string;
  constraint?: string;
}

const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

export function isPgError(error: unknown): error is PgError {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && SQLSTATE_PATTERN.test(code);
}

export interface ApiError {
  code: string;
  message: string;
  httpStatus: number;
  details?: Record<string, unknown>;
}

export function appError(
  code: string,
  httpStatus: number,
  message: string,
  details?: Record<string, unknown>,
): ApiError {
  return details ? { code, httpStatus, message, details } : { code, httpStatus, message };
}

// Familias de docs/api-conventions.md §4.2: un CHECK/UNIQUE/FK roto es
// CONFLICT_* (409, "estado incompatible"), no VALIDATION_* (eso es un 400 de
// entrada mal formada, que ya rechaza Zod antes de llegar a la base).
// Una FK puede romperse al INSERTAR (el registro referenciado no existe) o al
// BORRAR (algo todavía lo referencia con RESTRICT). El mensaje genérico solo
// describe lo primero; una FK que se rompe al borrar a propósito, para que
// borrar no pierda nada en silencio, tiene el suyo, por el nombre de la
// restricción (`PgError.constraint`).
const FOREIGN_KEY_MESSAGES: Record<string, ApiError> = {
  // customer_deposits.sale_order_id es RESTRICT desde WP-B11d (0034): una seña
  // existe antes del cobro, y borrar el borrador la desenganchaba en silencio.
  customer_deposits_sale_order_id_fkey: appError(
    "CONFLICT_ORDER_HAS_DEPOSIT",
    409,
    "No se puede borrar el pedido porque tiene una seña asociada. Desvinculá la seña del pedido y volvé a intentarlo.",
  ),
};

function mapForeignKeyViolation(error: PgError): ApiError {
  const specific = error.constraint ? FOREIGN_KEY_MESSAGES[error.constraint] : undefined;
  return (
    specific ??
    appError("CONFLICT_FOREIGN_KEY", 409, "El registro referenciado no existe o fue eliminado.")
  );
}

const PG_ERROR_MAP: Record<string, (error: PgError) => ApiError> = {
  "23514": () =>
    appError("CONFLICT_CHECK_VIOLATION", 409, "Los datos no cumplen una restricción del sistema."),
  "23505": () => appError("CONFLICT_DUPLICATE", 409, "Ya existe un registro con esos datos."),
  "23503": mapForeignKeyViolation,
  "2F004": () =>
    appError(
      "CONFLICT_IMMUTABLE_LEDGER",
      409,
      "Este registro es de solo lectura y no se puede modificar.",
    ),
};

// Un ERRCODE sin mapeo explícito es INTERNAL, 500 — nunca se intenta
// adivinar el mensaje a partir del texto crudo de Postgres (AGENTS.md §
// Seguridad, docs/api-conventions.md §4.4: "ningún mensaje de PostgreSQL
// llega al usuario, ni siquiera traducido a medias").
export function mapPgError(error: PgError): ApiError {
  const mapper = error.code ? PG_ERROR_MAP[error.code] : undefined;
  if (mapper) return mapper(error);
  return appError("INTERNAL", 500, "Ocurrió un error interno. Intentá de nuevo en unos minutos.");
}

// httpStatus (docs/api-conventions.md §4.2) → código nativo de tRPC. Los
// números coinciden exactamente con JSONRPC2_TO_HTTP_CODE de @trpc/server:
// eso es lo que hace que el adapter de Fastify use este mismo httpStatus
// como código HTTP real de la respuesta, sin necesitar `responseMeta`.
const HTTP_STATUS_TO_TRPC_CODE = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "TOO_MANY_REQUESTS",
  500: "INTERNAL_SERVER_ERROR",
  502: "BAD_GATEWAY",
} as const;

type TrpcErrorCode = (typeof HTTP_STATUS_TO_TRPC_CODE)[keyof typeof HTTP_STATUS_TO_TRPC_CODE];
const STATUS_TABLE: Partial<Record<number, TrpcErrorCode>> = HTTP_STATUS_TO_TRPC_CODE;

// Convierte un ApiError ya traducido en el TRPCError que hay que lanzar. El
// ApiError viaja como `cause` para que el `errorFormatter` de trpc.ts pueda
// recuperar `code`/`details` exactos sin volver a mapear nada.
export function toTRPCError(apiError: ApiError): TRPCError {
  const code = STATUS_TABLE[apiError.httpStatus] ?? "INTERNAL_SERVER_ERROR";
  return new TRPCError({ code, message: apiError.message, cause: apiError });
}

export function isApiError(value: unknown): value is ApiError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ApiError>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.httpStatus === "number"
  );
}
