// Orquesta la subida de una imagen de producto (WP-C09, RF-CAT-08). A
// diferencia de modules/catalog/service.ts, esto NO corre detrás de un
// procedimiento tRPC (docs/api-conventions.md §1, excepción documentada) —
// httpRoutes.ts lo llama directo desde una ruta Fastify multipart. Sigue
// las mismas capas (router/service/repository/domain,
// .claude/rules/api.md): esta función es el "service", nunca hace I/O de
// archivo por su cuenta más allá de invocar `storage` (el puerto) y
// `sharp` (procesamiento en memoria, sin red).
//
// docs/api-conventions.md §8.3: "no llames a un proveedor externo dentro
// de una transacción". Subir bytes a `storage` (disco hoy, red mañana) es
// justamente eso — corre SIEMPRE fuera de withTenantTx/withIdempotentTx.
// El único trabajo que ocurre DENTRO de una transacción acá es Postgres
// puro: la fila de `media`, el link `product_media` y el audit_log.
import { createHash } from "node:crypto";
import type { AdminMedia, UploadProductMediaFields } from "@joda/contracts";
import {
  buildMediaDerivativeKey,
  buildMediaOriginalKey,
  isAllowedMediaInputMimeType,
  listMediaDerivativeSpecs,
  MEDIA_MAX_DIMENSION_PX,
  type ObjectStorage,
} from "@joda/domain";
import type { PrismaClient } from "@joda/db";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { recordAuditEntry } from "../../db/audit.js";
import type { Audience } from "../../trpc/context.js";
import { withTenantTx, type TenantTxContext } from "../../db/withTenantTx.js";
import { withIdempotentTx, type IdempotencyRequest } from "../../db/withIdempotentTx.js";
import { appError } from "../../middleware/errorMapper.js";
import { toAdminMedia } from "./mappers.js";
import { findMediaBySha256, insertMediaRow, insertProductMediaRow } from "./repository.js";

const UNSUPPORTED_FILE_TYPE_ERROR = appError(
  "VALIDATION_UNSUPPORTED_FILE_TYPE",
  400,
  "El archivo no es una imagen soportada (jpeg, png o webp) — se valida por el contenido real " +
    "del archivo, no por su nombre ni por el tipo que declaró quien lo sube.",
);

const CORRUPT_IMAGE_ERROR = appError(
  "VALIDATION_CORRUPT_IMAGE",
  400,
  "No se pudo leer la imagen: el archivo está dañado o no es una imagen válida.",
);

function tooLargeError(widthPx: number, heightPx: number): ReturnType<typeof appError> {
  return appError(
    "VALIDATION_IMAGE_TOO_LARGE",
    400,
    `La imagen supera el máximo de ${MEDIA_MAX_DIMENSION_PX}px por lado (subida: ${widthPx}x${heightPx}px).`,
  );
}

export interface ValidatedImage {
  readonly buffer: Buffer;
  readonly mimeType: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly sha256: string;
}

/** Sin tipo explícito para el metadata (el tipo se infiere): `sharp` exporta `export = sharp` con un namespace del mismo nombre — nombrar `sharp.Metadata` como anotación choca con el import por default bajo este tsconfig. Inferir evita el problema sin `any`. */
async function readImageMetadataOrThrow(buffer: Buffer) {
  try {
    return await sharp(buffer).metadata();
  } catch {
    throw CORRUPT_IMAGE_ERROR;
  }
}

/**
 * Bytes mágicos, nunca `Content-Type` ni extensión (docs/security-spec.md
 * §5) — `file-type` los lee directo de la firma del archivo. Dimensiones
 * ANTES de generar derivados (la otra trampa explícita del WP): leer
 * metadata con sharp es barato incluso para un archivo grande, muy
 * distinto de correr el pipeline de resize+encode contra algo que se va a
 * rechazar igual.
 */
export async function validateUploadedImage(buffer: Buffer): Promise<ValidatedImage> {
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected || !isAllowedMediaInputMimeType(detected.mime)) {
    throw UNSUPPORTED_FILE_TYPE_ERROR;
  }

  const { width, height } = await readImageMetadataOrThrow(buffer);
  if (!width || !height) throw CORRUPT_IMAGE_ERROR;
  if (width > MEDIA_MAX_DIMENSION_PX || height > MEDIA_MAX_DIMENSION_PX) {
    throw tooLargeError(width, height);
  }

  return {
    buffer,
    mimeType: detected.mime,
    widthPx: width,
    heightPx: height,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

/** sharp no preserva EXIF/ICC/XMP salvo que se llame `.withMetadata()` — nunca se llama acá, a propósito (docs/security-spec.md §5: "elimina metadatos y cargas útiles embebidas"). */
async function encodeDerivative(
  buffer: Buffer,
  spec: { readonly width: number; readonly format: "avif" | "webp" },
): Promise<Buffer> {
  const resized = sharp(buffer).resize({ width: spec.width, withoutEnlargement: true });
  return spec.format === "avif" ? resized.avif().toBuffer() : resized.webp().toBuffer();
}

/** Fuera de cualquier transacción (docs/api-conventions.md §8.3) — sube el original + los 8 derivados. */
async function persistOriginalAndDerivatives(
  storage: ObjectStorage,
  image: ValidatedImage,
): Promise<void> {
  const uploads = listMediaDerivativeSpecs().map(async (spec) => {
    const derivativeBuffer = await encodeDerivative(image.buffer, spec);
    const contentType = spec.format === "avif" ? "image/avif" : "image/webp";
    await storage.put(buildMediaDerivativeKey(image.sha256, spec), derivativeBuffer, {
      contentType,
      isPublic: true,
    });
  });

  await Promise.all([
    storage.put(buildMediaOriginalKey(image.sha256), image.buffer, {
      contentType: image.mimeType,
      isPublic: false,
    }),
    ...uploads,
  ]);
}

export interface UploadProductMediaDeps {
  readonly db: PrismaClient;
  readonly storage: ObjectStorage;
  readonly mediaPublicBaseUrl: string;
}

export interface UploadAuditMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

export interface UploadProductMediaResult {
  readonly result: AdminMedia;
  readonly statusCode: number;
  readonly replayed: boolean;
}

export async function uploadProductMedia(
  deps: UploadProductMediaDeps,
  ctx: TenantTxContext,
  fields: UploadProductMediaFields,
  image: ValidatedImage,
  idempotency: IdempotencyRequest | null,
  auditMeta: UploadAuditMeta,
): Promise<UploadProductMediaResult> {
  const existingMedia = await withTenantTx(deps.db, ctx, (tx) =>
    findMediaBySha256(tx, image.sha256),
  );

  if (existingMedia === null) {
    await persistOriginalAndDerivatives(deps.storage, image);
  }

  return withIdempotentTx(deps.db, ctx, idempotency, async (tx) => {
    const media =
      existingMedia ??
      (await insertMediaRow(tx, {
        tenantId: ctx.tenantId,
        sha256: image.sha256,
        // El original nunca se sirve (docs/architecture/JODA_Arquitectura_v5_Final.md
        // §8.3: "Originales sin procesar | Privado | Se sirven derivados,
        // no originales") — bucket/is_public describen ESTE objeto (el
        // original), no los derivados, que viven en rutas fijas derivadas
        // del sha256 y no tienen fila propia (mappers.ts).
        bucket: "private-docs",
        objectKey: buildMediaOriginalKey(image.sha256),
        mimeType: image.mimeType,
        width: image.widthPx,
        height: image.heightPx,
        bytes: image.buffer.byteLength,
        isPublic: false,
      }));

    const productMedia = await insertProductMediaRow(tx, {
      productId: fields.productId,
      mediaId: media.id,
      variantId: fields.variantId ?? null,
      position: fields.position ?? 0,
      altText: fields.altText ?? null,
    });

    await recordAuditEntry(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      audience: ctx.audience satisfies Audience,
      action: "catalog.media.upload",
      entity: "media",
      entityId: media.id,
      before: null,
      after: {
        productId: fields.productId,
        variantId: fields.variantId ?? null,
        sha256: image.sha256,
        mimeType: image.mimeType,
        bytes: image.buffer.byteLength,
      },
      ip: auditMeta.ip,
      userAgent: auditMeta.userAgent,
      requestId: auditMeta.requestId,
    });

    return {
      result: toAdminMedia(media, productMedia, deps.mediaPublicBaseUrl),
      statusCode: 201,
    };
  });
}
