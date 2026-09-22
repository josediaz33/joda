import { describe, expect, it } from "vitest";
import {
  buildMediaDerivativeKey,
  buildMediaOriginalKey,
  isAllowedMediaInputMimeType,
  listMediaDerivativeSpecs,
  MEDIA_ALLOWED_INPUT_MIME_TYPES,
  MEDIA_DERIVATIVE_FORMATS,
  MEDIA_DERIVATIVE_WIDTHS,
} from "./media.js";

const SHA = "a".repeat(64);

// docs/architecture/JODA_Arquitectura_v5_Final.md §9 Fase 2: "subir original
// + derivados AVIF/WebP en 320/640/1024/1600 px" — no es una regla RN-CAT
// numerada (docs/testing-strategy.md §2.2), es una convención definida en ese
// documento.
describe("listMediaDerivativeSpecs · docs/architecture/JODA_Arquitectura_v5_Final.md §9", () => {
  it("genera los 8 derivados: cada ancho en cada formato", () => {
    expect(listMediaDerivativeSpecs()).toEqual([
      { width: 320, format: "avif" },
      { width: 320, format: "webp" },
      { width: 640, format: "avif" },
      { width: 640, format: "webp" },
      { width: 1024, format: "avif" },
      { width: 1024, format: "webp" },
      { width: 1600, format: "avif" },
      { width: 1600, format: "webp" },
    ]);
  });

  it("cubre exactamente los anchos y formatos declarados", () => {
    expect(MEDIA_DERIVATIVE_WIDTHS).toEqual([320, 640, 1024, 1600]);
    expect(MEDIA_DERIVATIVE_FORMATS).toEqual(["avif", "webp"]);
  });
});

// docs/security-spec.md §5, fila "Carga de archivos": "nombre por hash".
describe("buildMediaOriginalKey / buildMediaDerivativeKey · docs/security-spec.md §5", () => {
  it("el original vive bajo originals/, nombrado por su sha256", () => {
    expect(buildMediaOriginalKey(SHA)).toBe(`originals/${SHA}`);
  });

  it("un derivado vive bajo catalog/<sha256>/<ancho>.<formato>", () => {
    expect(buildMediaDerivativeKey(SHA, { width: 640, format: "avif" })).toBe(
      `catalog/${SHA}/640.avif`,
    );
  });

  it("dos derivados del mismo original comparten prefijo, difieren en ancho y formato", () => {
    const a = buildMediaDerivativeKey(SHA, { width: 320, format: "webp" });
    const b = buildMediaDerivativeKey(SHA, { width: 1600, format: "avif" });
    expect(a).toBe(`catalog/${SHA}/320.webp`);
    expect(b).toBe(`catalog/${SHA}/1600.avif`);
  });

  it("un sha256 con forma inválida es un bug de quien llama, no una entrada de usuario: lanza (docs/domain-contracts.md §4.1)", () => {
    expect(() => buildMediaOriginalKey("no-es-un-hash")).toThrow(/sha256 inválido/);
    expect(() =>
      buildMediaDerivativeKey("demasiado-corto", { width: 320, format: "avif" }),
    ).toThrow(/sha256 inválido/);
  });
});

describe("isAllowedMediaInputMimeType · docs/security-spec.md §5", () => {
  it("acepta jpeg, png y webp", () => {
    for (const mime of MEDIA_ALLOWED_INPUT_MIME_TYPES) {
      expect(isAllowedMediaInputMimeType(mime)).toBe(true);
    }
  });

  it("rechaza cualquier otro mime — incluido el de un ejecutable renombrado a .jpg", () => {
    expect(isAllowedMediaInputMimeType("application/x-msdownload")).toBe(false);
    expect(isAllowedMediaInputMimeType("image/gif")).toBe(false);
    expect(isAllowedMediaInputMimeType("image/svg+xml")).toBe(false);
  });
});
