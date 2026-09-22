import type { AdminMedia, MediaDerivative } from "@joda/contracts";
import { buildMediaDerivativeKey, listMediaDerivativeSpecs } from "@joda/domain";
import type { MediaRow, ProductMediaRow } from "./repository.js";

/** URL pública de un derivado — nunca firmada (docs/architecture/JODA_Arquitectura_v5_Final.md §8.3: firmar rompe el caché del CDN). */
function buildDerivativeUrls(mediaPublicBaseUrl: string, sha256: string): MediaDerivative[] {
  const base = mediaPublicBaseUrl.endsWith("/") ? mediaPublicBaseUrl : `${mediaPublicBaseUrl}/`;
  return listMediaDerivativeSpecs().map((spec) => ({
    width: spec.width,
    format: spec.format,
    url: new URL(buildMediaDerivativeKey(sha256, spec), base).toString(),
  }));
}

export function toAdminMedia(
  media: MediaRow,
  productMedia: ProductMediaRow,
  mediaPublicBaseUrl: string,
): AdminMedia {
  return {
    id: media.id,
    productId: productMedia.product_id,
    variantId: productMedia.variant_id,
    altText: productMedia.alt_text,
    position: productMedia.position,
    width: media.width,
    height: media.height,
    bytes: Number(media.bytes),
    mimeType: media.mime_type,
    derivatives: buildDerivativeUrls(mediaPublicBaseUrl, media.sha256),
    createdAt: media.created_at.toISOString(),
  };
}
