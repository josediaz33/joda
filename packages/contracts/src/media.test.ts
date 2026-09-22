import { describe, expect, it } from "vitest";
import { adminMediaSchema, uploadProductMediaFields } from "./media.js";

const PRODUCT_ID = "11111111-1111-4111-a111-111111111111";
const VARIANT_ID = "22222222-2222-4222-a222-222222222222";
const MEDIA_ID = "33333333-3333-4333-a333-333333333333";

// .claude/rules/contracts.md: "Zod .strict() en todo esquema" — sin
// referencia a una regla de negocio (RN-XXX) porque esto no encarna una,
// solo la convención mecánica de la frontera (docs/testing-strategy.md §2.2).
describe("uploadProductMediaFields · .claude/rules/contracts.md", () => {
  it("acepta solo productId, sin el resto de los campos opcionales", () => {
    const result = uploadProductMediaFields.parse({ productId: PRODUCT_ID });
    expect(result).toEqual({ productId: PRODUCT_ID });
  });

  it("acepta los cuatro campos declarados", () => {
    const result = uploadProductMediaFields.parse({
      productId: PRODUCT_ID,
      variantId: VARIANT_ID,
      altText: "Frasco de 50 ml sobre fondo blanco",
      position: "2",
    });
    expect(result).toEqual({
      productId: PRODUCT_ID,
      variantId: VARIANT_ID,
      altText: "Frasco de 50 ml sobre fondo blanco",
      position: 2,
    });
  });

  it("coerciona position de string a number — los campos de un multipart llegan como texto", () => {
    expect(uploadProductMediaFields.parse({ productId: PRODUCT_ID, position: "0" }).position).toBe(
      0,
    );
  });

  it("rechaza un campo no declarado (.strict(), asignación masiva)", () => {
    expect(() =>
      uploadProductMediaFields.parse({ productId: PRODUCT_ID, bucket: "public-catalog" }),
    ).toThrow();
  });

  it("rechaza sin productId", () => {
    expect(() => uploadProductMediaFields.parse({})).toThrow();
  });
});

describe("adminMediaSchema · .claude/rules/contracts.md", () => {
  it("valida la forma completa que devuelve la ruta de subida", () => {
    const media = {
      id: MEDIA_ID,
      productId: PRODUCT_ID,
      variantId: null,
      altText: null,
      position: 0,
      width: 1200,
      height: 1600,
      bytes: 345_120,
      mimeType: "image/jpeg",
      derivatives: [{ width: 320, format: "avif" as const, url: "https://media.example/a.avif" }],
      createdAt: "2026-09-22T12:00:00.000Z",
    };
    expect(adminMediaSchema.parse(media)).toEqual(media);
  });

  it("rechaza un campo no declarado", () => {
    expect(() =>
      adminMediaSchema.parse({
        id: MEDIA_ID,
        productId: PRODUCT_ID,
        variantId: null,
        altText: null,
        position: 0,
        width: null,
        height: null,
        bytes: 1,
        mimeType: "image/jpeg",
        derivatives: [],
        createdAt: "2026-09-22T12:00:00.000Z",
        sha256: "a".repeat(64),
      }),
    ).toThrow();
  });
});
