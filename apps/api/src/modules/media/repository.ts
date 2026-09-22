import type { Prisma } from "@joda/db";
import type { TenantTx } from "../../db/withTenantTx.js";

export type MediaRow = Prisma.mediaGetPayload<Record<string, never>>;
export type ProductMediaRow = Prisma.product_mediaGetPayload<Record<string, never>>;

/** Dedup por (tenant_id, sha256) — UNIQUE de packages/db/migrations/0003_catalog.sql. Lectura corta, ANTES de generar derivados (docs/api-conventions.md §8.3: no vale la pena el trabajo de sharp/storage si el original ya está). */
export async function findMediaBySha256(tx: TenantTx, sha256: string): Promise<MediaRow | null> {
  return tx.media.findFirst({ where: { sha256 } });
}

export interface InsertMediaRowInput {
  readonly tenantId: string;
  readonly sha256: string;
  readonly bucket: string;
  readonly objectKey: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly isPublic: boolean;
}

export async function insertMediaRow(tx: TenantTx, input: InsertMediaRowInput): Promise<MediaRow> {
  return tx.media.create({
    data: {
      tenant_id: input.tenantId,
      sha256: input.sha256,
      bucket: input.bucket,
      object_key: input.objectKey,
      mime_type: input.mimeType,
      width: input.width,
      height: input.height,
      bytes: input.bytes,
      is_public: input.isPublic,
    },
  });
}

export interface InsertProductMediaRowInput {
  readonly productId: string;
  readonly mediaId: string;
  readonly variantId: string | null;
  readonly position: number;
  readonly altText: string | null;
}

export async function insertProductMediaRow(
  tx: TenantTx,
  input: InsertProductMediaRowInput,
): Promise<ProductMediaRow> {
  return tx.product_media.create({
    data: {
      product_id: input.productId,
      media_id: input.mediaId,
      variant_id: input.variantId,
      position: input.position,
      alt_text: input.altText,
    },
  });
}
