// Traduce errores de PostgreSQL y Prisma a errores de API en español, con
// código estable (docs/api-conventions.md §4.4). Los casos que necesitan un
// mensaje de negocio específico usan el SQLSTATE estructurado, nunca el
// texto crudo de la base.
import { TRPCError } from "@trpc/server";

export interface PgError {
  code?: string;
  message?: string;
  detail?: string;
  constraint?: string;
}

const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

interface PrismaKnownError {
  readonly name: "PrismaClientKnownRequestError";
  readonly code: string;
  // `code` es el SQLSTATE de un P2010 (SQL crudo); `constraint` es el nombre de
  // la restricción de un P2003 (FK rota con el cliente tipado). Es la forma que
  // Prisma entrega de verdad: errorMapper.integration.test.ts la comprueba con
  // un error real, no armado a mano.
  readonly meta?: { readonly code?: unknown; readonly constraint?: unknown };
}

export function isPrismaKnownError(error: unknown): error is PrismaKnownError {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === "PrismaClientKnownRequestError" &&
    typeof candidate.code === "string" &&
    /^P\d{4}$/.test(candidate.code)
  );
}

export function isPgError(error: unknown): error is PgError {
  if (isPrismaKnownError(error)) return false;
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
  // decant_work_orders.sale_order_id es NO ACTION: un pedido con órdenes de
  // fraccionamiento (WP-C13) no se borra, y sin esto salía como un error interno.
  decant_wo_order_fk: appError(
    "CONFLICT_ORDER_HAS_DECANT_ORDERS",
    409,
    "No se puede borrar el pedido porque tiene órdenes de fraccionamiento asociadas.",
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

export function hasSqlState(error: unknown, code: string): boolean {
  if (isPrismaKnownError(error)) {
    return error.code === "P2010" && error.meta?.code === code;
  }
  return isPgError(error) && error.code === code;
}

export function mapPrismaError(error: PrismaKnownError): ApiError {
  if (error.code === "P2002") return mapPgError({ code: "23505" });
  // P2003 es una FK rota con el cliente tipado (por ejemplo, borrar un pedido
  // que todavía tiene una seña). Sin esta rama caía en `mapPgError({})`: un 500.
  // Con SQL crudo Prisma da P2010 y deja el nombre de la restricción solo dentro
  // de `meta.message`, que acá no se lee: sale el 409 genérico.
  if (error.code === "P2003") {
    const constraint =
      typeof error.meta?.constraint === "string" ? error.meta.constraint : undefined;
    return mapPgError(constraint === undefined ? { code: "23503" } : { code: "23503", constraint });
  }
  // Prisma usa P2025 cuando UPDATE/DELETE no encuentra una fila, incluso si
  // RLS la oculta. La API no revela si existe fuera de esta sesión.
  if (error.code === "P2025") return appError("NOT_FOUND", 404, "No encontrado.");
  if (error.code === "P2010" && typeof error.meta?.code === "string") {
    return mapPgError({ code: error.meta.code });
  }
  return mapPgError({});
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
