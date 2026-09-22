// Ruta HTTP de subida de medios (WP-C09, RF-CAT-08). Excepción documentada
// a docs/api-conventions.md §1 ("REST solo para lo que necesita ser
// consumido por terceros"): la carga es multipart/binaria, no JSON, así
// que no puede ser un procedimiento tRPC — pero cumple TODO lo demás que
// cumpliría uno: permiso declarado (`enforcePermissionGate`, idéntico al
// de trpc/trpc.ts), el mismo gate de segundo factor, `Idempotency-Key`
// (docs/api-conventions.md §5) y el mismo mapeo de errores de Postgres
// (docs/api-conventions.md §4.4). Si trpc/trpc.ts cambia esos dos gates
// algún día, este archivo se desincroniza — reusa las mismas constantes de
// error exportadas desde ahí a propósito, para que al menos el TEXTO nunca
// diverja aunque la lógica sí pueda.
import fastifyMultipart, { type MultipartFields } from "@fastify/multipart";
import { uploadProductMediaFields, type AdminMedia } from "@joda/contracts";
import { decidePermissionAccess, MEDIA_MAX_UPLOAD_BYTES, type ObjectStorage } from "@joda/domain";
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@joda/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { buildIdempotencyRequest } from "../../middleware/idempotency.js";
import {
  appError,
  isApiError,
  isPgError,
  mapPgError,
  type ApiError,
} from "../../middleware/errorMapper.js";
import { buildCreateContext, type RequestContext } from "../../trpc/context.js";
import {
  FORBIDDEN_ERROR,
  MFA_ENROLLMENT_REQUIRED_ERROR,
  MFA_VERIFICATION_REQUIRED_ERROR,
  NOT_FOUND_ERROR,
} from "../../trpc/trpc.js";
import type { TenantTxContext } from "../../db/withTenantTx.js";
import type { AuthServiceDeps } from "../auth/service.js";
import { uploadProductMedia, validateUploadedImage } from "./service.js";

export interface MediaRouteDeps {
  readonly db: PrismaClient | null;
  readonly authDeps: AuthServiceDeps | null;
  readonly storage: ObjectStorage | null;
  readonly mediaPublicBaseUrl: string | null;
}

/** Mismo criterio que requireDb de modules/catalog/router.ts: solo `null` en tests que levantan `buildServer()` sin Postgres. */
function requireDb(db: PrismaClient | null): PrismaClient {
  if (db === null) {
    throw appError("INTERNAL", 500, "El servidor no tiene la base de datos configurada.");
  }
  return db;
}

/** Mismo criterio que requireDb — `null` solo en tests que levantan `buildServer()` sin un adaptador de almacenamiento real. */
function requireStorage(storage: ObjectStorage | null): ObjectStorage {
  if (storage === null) {
    throw appError("INTERNAL", 500, "El servidor no tiene almacenamiento de medios configurado.");
  }
  return storage;
}

function requireMediaPublicBaseUrl(mediaPublicBaseUrl: string | null): string {
  if (mediaPublicBaseUrl === null) {
    throw appError("INTERNAL", 500, "El servidor no tiene almacenamiento de medios configurado.");
  }
  return mediaPublicBaseUrl;
}

/** Mismo criterio que requireStaffContext de modules/catalog/router.ts. */
function requireStaffContext(ctx: RequestContext): TenantTxContext {
  if (ctx.audience === "staff" && ctx.userId && ctx.tenantId) {
    return { userId: ctx.userId, tenantId: ctx.tenantId, audience: ctx.audience };
  }
  throw appError("UNAUTHENTICATED_SESSION_EXPIRED", 401, "Necesitás una sesión de personal.");
}

/** Misma condición que enforceMfaGate de trpc/trpc.ts, fuera de un middleware de tRPC. */
function enforceMfaGate(ctx: RequestContext): void {
  if (ctx.mfaStatus === null || ctx.mfaStatus === "satisfied") return;
  throw ctx.mfaStatus === "pending_enrollment"
    ? MFA_ENROLLMENT_REQUIRED_ERROR
    : MFA_VERIFICATION_REQUIRED_ERROR;
}

/** Subir medios de un producto cae bajo el mismo permiso que editarlo — no hay un permiso `catalog.media:write` separado (RF-CAT-08 no lo pide). */
const REQUIRED_PERMISSION = "catalog.product:write";

/** Misma condición que enforcePermissionGate de trpc/trpc.ts. */
function enforcePermissionGate(ctx: RequestContext): void {
  const outcome = decidePermissionAccess({
    hasStaffSession: ctx.grantedPermissions !== null,
    requiredPermission: REQUIRED_PERMISSION,
    grantedPermissions: ctx.grantedPermissions ?? new Set(),
  });
  if (outcome.kind === "granted") return;
  throw outcome.httpStatus === 404 ? NOT_FOUND_ERROR : FORBIDDEN_ERROR;
}

/** Busboy entrega cada campo simple como `{ type: "field", value }` — el archivo mismo también aparece acá con `type: "file"`, se descarta (ya lo devolvió `req.file()`). */
function extractFieldValues(fields: MultipartFields): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of Object.values(fields)) {
    const field = Array.isArray(entry) ? entry[0] : entry;
    if (field?.type === "field") result[field.fieldname] = String(field.value);
  }
  return result;
}

/** Mismo repertorio que trpc/trpc.ts (catchPgErrors) + tRPC (ZodError en el borde de `.input()`) — acá explícito porque no hay middleware que lo haga por este camino. */
function resolveApiError(error: unknown): ApiError {
  if (error instanceof TRPCError && isApiError(error.cause)) return error.cause;
  if (isApiError(error)) return error;
  if (error instanceof z.ZodError) {
    return appError("VALIDATION_INVALID_INPUT", 400, "Los datos del formulario no son válidos.", {
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  if (isPgError(error)) return mapPgError(error);
  return appError("INTERNAL", 500, "Ocurrió un error interno. Intentá de nuevo en unos minutos.");
}

/** Misma forma que docs/api-conventions.md §4.1 — el mismo JSON que devolvería el errorFormatter de trpc/trpc.ts, armado a mano porque acá no hay tRPC. */
function sendApiError(reply: FastifyReply, req: FastifyRequest, error: unknown): FastifyReply {
  const apiError = resolveApiError(error);
  return reply.code(apiError.httpStatus).send({
    code: apiError.code,
    message: apiError.message,
    httpStatus: apiError.httpStatus,
    ...(apiError.details ? { details: apiError.details } : {}),
    requestId: req.id,
  });
}

function normalizeUserAgent(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function registerMediaHttpRoutes(app: FastifyInstance, deps: MediaRouteDeps): void {
  app.register(fastifyMultipart, {
    limits: { fileSize: MEDIA_MAX_UPLOAD_BYTES, files: 1, fields: 10 },
  });

  app.post("/media/products", async (req, reply) => {
    try {
      const ctx = await buildCreateContext(deps.authDeps)({ req, res: reply });
      // Mismo orden que trpc/trpc.ts (staffProcedure = catchPgErrors →
      // enforceMfaGate → enforcePermissionGate): una petición SIN sesión
      // tiene que terminar en el 404 de enforcePermissionGate (§4.3, "la
      // regla del 404" — no confirmar que el endpoint existe a quien no
      // tiene ni credenciales), no en un 401 de requireStaffContext más
      // temprano. requireStaffContext corre último, como red de tipos para
      // el resto del handler — en la práctica ya pasó la sesión.
      enforceMfaGate(ctx);
      enforcePermissionGate(ctx);
      const tenantCtx = requireStaffContext(ctx);

      const filePart = await req.file();
      if (!filePart) {
        throw appError("VALIDATION_MISSING_FILE", 400, 'Falta el archivo a subir (campo "file").');
      }

      const fields = uploadProductMediaFields.parse(extractFieldValues(filePart.fields));

      let buffer: Buffer;
      try {
        buffer = await filePart.toBuffer();
      } catch {
        // @fastify/multipart aborta el stream apenas se supera `limits.fileSize`
        // (arriba) — nunca termina de bufferizar un archivo de 800 MB para
        // recién ahí enterarse de que es demasiado grande (trampa explícita
        // del WP). El archivo nunca llega a validateUploadedImage/sharp.
        throw appError(
          "VALIDATION_FILE_TOO_LARGE",
          413,
          `El archivo supera el límite de ${MEDIA_MAX_UPLOAD_BYTES} bytes.`,
        );
      }

      const image = await validateUploadedImage(buffer);

      const idempotency = buildIdempotencyRequest(req, {
        productId: fields.productId,
        variantId: fields.variantId ?? null,
        altText: fields.altText ?? null,
        position: fields.position ?? null,
        sha256: image.sha256,
      });

      const { result, statusCode } = await uploadProductMedia(
        {
          db: requireDb(deps.db),
          storage: requireStorage(deps.storage),
          mediaPublicBaseUrl: requireMediaPublicBaseUrl(deps.mediaPublicBaseUrl),
        },
        tenantCtx,
        fields,
        image,
        idempotency,
        {
          ip: req.ip,
          userAgent: normalizeUserAgent(req.headers["user-agent"]),
          requestId: req.id,
        },
      );

      return reply.code(statusCode).send(result satisfies AdminMedia);
    } catch (error) {
      return sendApiError(reply, req, error);
    }
  });
}
