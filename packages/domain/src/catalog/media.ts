// Política de medios de catálogo — RF-CAT-08, WP-C09.
// docs/architecture/JODA_Arquitectura_v5_Final.md §9 Fase 2 ("subir
// original + derivados AVIF/WebP en 320/640/1024/1600 px") fija los
// anchos y formatos; docs/security-spec.md §5 fija que el nombre sale del
// hash, nunca del nombre de archivo subido. Estas son las únicas
// funciones puras del flujo: leer bytes, invocar sharp y subir a
// almacenamiento necesitan I/O y viven en apps/api/src/modules/media/.

export const MEDIA_DERIVATIVE_WIDTHS = [320, 640, 1024, 1600] as const;
export type MediaDerivativeWidth = (typeof MEDIA_DERIVATIVE_WIDTHS)[number];

export const MEDIA_DERIVATIVE_FORMATS = ["avif", "webp"] as const;
export type MediaDerivativeFormat = (typeof MEDIA_DERIVATIVE_FORMATS)[number];

/**
 * Formatos de ENTRADA aceptados, por el `mime` real que devuelve la
 * detección de bytes mágicos (nunca por `Content-Type` ni por extensión,
 * docs/security-spec.md §5). No incluye avif/webp de entrada a propósito:
 * simplifica la validación de dimensiones (sharp lee metadata igual de
 * cualquiera de los tres) y ningún flujo de catálogo hoy sube ya-procesado.
 */
export const MEDIA_ALLOWED_INPUT_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type MediaAllowedInputMimeType = (typeof MEDIA_ALLOWED_INPUT_MIME_TYPES)[number];

export function isAllowedMediaInputMimeType(mime: string): mime is MediaAllowedInputMimeType {
  return (MEDIA_ALLOWED_INPUT_MIME_TYPES as readonly string[]).includes(mime);
}

/** 20 MB — generoso para una foto de producto, muy por debajo de lo que hace falta para que un archivo de 800 MB dañe algo (la trampa explícita del WP). */
export const MEDIA_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Por encima de esto no hay foto de producto real — corta decompression bombs (poca resolución en bytes, dimensiones enormes) antes de pedirle a sharp que las procese. */
export const MEDIA_MAX_DIMENSION_PX = 8000;

/** Prefijo del original sin procesar dentro de ObjectStorage — bucket privado, nunca servido. */
export const MEDIA_ORIGINAL_KEY_PREFIX = "originals";

/** Prefijo de los derivados públicos dentro de ObjectStorage — apps/api/src/mediaServer.ts sirve exactamente este subárbol, nada más. */
export const MEDIA_DERIVATIVE_KEY_PREFIX = "catalog";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Un `sha256` que no cumple esta forma nunca puede salir de
 * apps/api/src/modules/media/ (siempre lo calcula `createHash("sha256")`
 * sobre los bytes ya validados) — llegar hasta acá con otra cosa es un bug
 * de quien llama, no una entrada de usuario: excepción, no `Result`
 * (docs/domain-contracts.md §4.1).
 */
function assertSha256(sha256: string): void {
  if (!SHA256_HEX_PATTERN.test(sha256)) {
    throw new Error(
      `sha256 inválido: se esperaban 64 caracteres hexadecimales, llegó "${sha256}".`,
    );
  }
}

/** Key del original sin procesar — bucket privado, nunca servido (docs/architecture §8.3: "Originales sin procesar | Privado | Se sirven derivados, no originales"). */
export function buildMediaOriginalKey(sha256: string): string {
  assertSha256(sha256);
  return `${MEDIA_ORIGINAL_KEY_PREFIX}/${sha256}`;
}

export interface MediaDerivativeSpec {
  readonly width: MediaDerivativeWidth;
  readonly format: MediaDerivativeFormat;
}

/** Producto cartesiano de anchos × formatos — los 8 archivos que genera cada subida. */
export function listMediaDerivativeSpecs(): readonly MediaDerivativeSpec[] {
  return MEDIA_DERIVATIVE_WIDTHS.flatMap((width) =>
    MEDIA_DERIVATIVE_FORMATS.map((format) => ({ width, format })),
  );
}

/** Key de un derivado — determinística a partir del hash, nunca del nombre de archivo subido (docs/security-spec.md §5, "nombre por hash"). */
export function buildMediaDerivativeKey(sha256: string, spec: MediaDerivativeSpec): string {
  assertSha256(sha256);
  return `${MEDIA_DERIVATIVE_KEY_PREFIX}/${sha256}/${spec.width}.${spec.format}`;
}
