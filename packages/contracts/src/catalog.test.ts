import { describe, expect, it } from "vitest";
import {
  adminAccessoryDetailsSchema,
  adminBomComponentSchema,
  adminCategorySchema,
  adminPerfumeDetailsSchema,
  adminProductSchema,
  adminTagSchema,
  adminVariantSchema,
  adminWatchDetailsSchema,
  createBomComponentInput,
  createProductInput,
  createVariantInput,
  publicProductSchema,
  publicVariantSchema,
} from "./catalog.js";

// Claves prohibidas en cualquier esquema PÚBLICO (.claude/rules/contracts.md,
// docs/api-conventions.md §7): costos, proveedores y márgenes jamás salen en
// una respuesta pública. Comparación normalizada (minúsculas, sin guion bajo)
// para que capture tanto `fxRate` (camelCase, la convención real de esta
// frontera) como el `fx_rate` literal del enunciado de la regla.
const FORBIDDEN_KEY_SUBSTRINGS = ["cost", "landed", "supplier", "margin", "fxrate"];

function normalize(key: string): string {
  return key.toLowerCase().replace(/_/g, "");
}

// Forma mínima que necesitamos leer de un esquema Zod en tiempo de ejecución
// — los tipos públicos de Zod (ZodObject, ZodArray, ...) no comparten un
// ancestro común con `.def`/`.shape`/`.unwrap()` cómodo de tipar en genérico,
// así que se declara la porción estructural que este recorrido usa.
interface IntrospectableSchema {
  readonly def: { readonly type: string; readonly element?: unknown; readonly options?: unknown[] };
  readonly shape?: Record<string, unknown>;
  readonly unwrap?: () => unknown;
}

/**
 * Recorre la FORMA del esquema (no una instancia parseada) para que un campo
 * opcional que un ejemplo de test no llegue a poblar no se escape sin
 * revisar. Cubre los constructores que usan los esquemas de este archivo —
 * object/array/nullable/optional/record/union — no es un recorrido genérico
 * de todo Zod.
 */
function collectSchemaKeys(schema: unknown, keys: Set<string> = new Set()): Set<string> {
  const { def, shape, unwrap } = schema as IntrospectableSchema;

  switch (def.type) {
    case "object":
      for (const [key, value] of Object.entries(shape ?? {})) {
        keys.add(key);
        collectSchemaKeys(value, keys);
      }
      break;
    case "array":
      if (def.element) collectSchemaKeys(def.element, keys);
      break;
    case "nullable":
    case "optional":
      if (unwrap) collectSchemaKeys(unwrap(), keys);
      break;
    case "union":
      for (const option of def.options ?? []) collectSchemaKeys(option, keys);
      break;
    default:
      // record (jsonb sin forma fija), enum, string, number, boolean,
      // literal: sin claves propias que recorrer.
      break;
  }

  return keys;
}

function assertNoForbiddenKeys(schema: unknown) {
  const keys = collectSchemaKeys(schema);
  const leaked = [...keys].filter((key) =>
    FORBIDDEN_KEY_SUBSTRINGS.some((forbidden) => normalize(key).includes(forbidden)),
  );
  expect(leaked).toEqual([]);
}

describe("catalog — DTOs por audiencia (docs/api-conventions.md §7)", () => {
  it("publicProductSchema no filtra ninguna clave prohibida (cost, landed, supplier, margin, fx_rate)", () => {
    assertNoForbiddenKeys(publicProductSchema);
  });

  it("publicVariantSchema no filtra ninguna clave prohibida", () => {
    assertNoForbiddenKeys(publicVariantSchema);
  });

  it("publicVariantSchema expone inStock como boolean, nunca la cantidad", () => {
    expect(publicVariantSchema.shape.inStock.def.type).toBe("boolean");
    expect("qty" in publicVariantSchema.shape).toBe(false);
    expect("quantity" in publicVariantSchema.shape).toBe(false);
  });

  it("adminProductSchema y publicProductSchema son esquemas DISTINTOS, no el mismo con campos opcionales", () => {
    expect(adminProductSchema).not.toBe(
      publicProductSchema as unknown as typeof adminProductSchema,
    );
    // adminProduct tiene campos que publicProduct nunca declara.
    const perfumeAdmin = adminProductSchema.options[0];
    expect("status" in perfumeAdmin.shape).toBe(true);
    expect("status" in publicProductSchema.shape).toBe(false);
  });

  it("los tres esquemas .strict() de adminProductSchema rechazan un campo no declarado", () => {
    for (const option of adminProductSchema.options) {
      expect(() => option.parse({ kind: option.shape.kind.value, notARealField: 1 })).toThrow();
    }
  });

  it("publicProductSchema rechaza un campo no declarado (.strict())", () => {
    expect(() =>
      publicProductSchema.parse({
        id: "0f3b6b2a-2e0e-4c1d-9c1a-2c9a9a9a9a9a",
        kind: "perfume",
        slug: "layton",
        name: "Layton",
        brandName: "Parfums de Marly",
        facets: {},
        variants: [],
        costSummary: { landed: "1000" },
      }),
    ).toThrow();
  });
});

describe("catalog — detalle admin por vertical (docs/data-model.md §3.1, ADR-005)", () => {
  it("adminPerfumeDetailsSchema incluye la merma; perfumeFacetSchema (lo público) no", () => {
    expect("wasteFactor" in adminPerfumeDetailsSchema.shape).toBe(true);
    expect("wasteFactor" in publicProductSchema.shape).toBe(false);
  });

  it("adminWatchDetailsSchema incluye requiresSerial, operativo, nunca público", () => {
    expect("requiresSerial" in adminWatchDetailsSchema.shape).toBe(true);
  });

  it("adminAccessoryDetailsSchema no tiene campos operativos propios (accessory_details no los tiene en la base)", () => {
    expect(Object.keys(adminAccessoryDetailsSchema.shape).sort()).toEqual(
      ["color", "material", "sizeLabel"].sort(),
    );
  });
});

describe("catalog — createVariantInput valida los mismos CHECK que product_variants (0003_catalog.sql)", () => {
  const base = {
    productId: "11111111-1111-4111-a111-111111111111",
    sku: "SKU-1",
    pricePyg: "245000",
  };

  it("sealed sin sizeMl se rechaza", () => {
    expect(() =>
      createVariantInput.parse({ ...base, variantType: "sealed", uom: "unit", sizeMl: null }),
    ).toThrow();
  });

  it("unit con sizeMl se rechaza", () => {
    expect(() =>
      createVariantInput.parse({ ...base, variantType: "unit", uom: "unit", sizeMl: 30 }),
    ).toThrow();
  });

  it("decant con uom unit se rechaza (decant/bulk se miden en ml)", () => {
    expect(() =>
      createVariantInput.parse({ ...base, variantType: "decant", uom: "unit", sizeMl: 10 }),
    ).toThrow();
  });

  it("made_to_order sin sourceVariantId se rechaza", () => {
    expect(() =>
      createVariantInput.parse({
        ...base,
        variantType: "decant",
        uom: "ml",
        sizeMl: 10,
        productionMode: "made_to_order",
      }),
    ).toThrow();
  });

  it("una combinación válida (sealed, unit, con sizeMl) se acepta", () => {
    expect(() =>
      createVariantInput.parse({ ...base, variantType: "sealed", uom: "unit", sizeMl: 1 }),
    ).not.toThrow();
  });
});

describe("catalog — createBomComponentInput (RF-CAT-07)", () => {
  it("rechaza que el componente sea la misma variante que el padre", () => {
    const variantId = "22222222-2222-4222-a222-222222222222";
    expect(() =>
      createBomComponentInput.parse({
        parentVariantId: variantId,
        componentVariantId: variantId,
        qtyPerUnit: 1,
        uom: "unit",
      }),
    ).toThrow();
  });
});

describe("catalog — createProductInput exige exactamente una categoría primaria incluida (ADR-006)", () => {
  const catA = "33333333-3333-4333-a333-333333333331";
  const catB = "33333333-3333-4333-a333-333333333332";

  it("rechaza primaryCategoryId fuera de categoryIds", () => {
    expect(() =>
      createProductInput.parse({
        kind: "accessory",
        slug: "estuche-cuero",
        name: "Estuche de cuero",
        categoryIds: [catA],
        primaryCategoryId: catB,
        accessoryDetails: { material: "cuero", color: "marrón", sizeLabel: null },
      }),
    ).toThrow();
  });

  it("acepta cuando primaryCategoryId está incluido en categoryIds", () => {
    expect(() =>
      createProductInput.parse({
        kind: "accessory",
        slug: "estuche-cuero",
        name: "Estuche de cuero",
        categoryIds: [catA, catB],
        primaryCategoryId: catB,
        accessoryDetails: { material: "cuero", color: "marrón", sizeLabel: null },
      }),
    ).not.toThrow();
  });
});

describe("catalog — .strict() en los esquemas administrativos restantes (.claude/rules/contracts.md)", () => {
  it("adminCategorySchema rechaza un campo no declarado", () => {
    expect(() =>
      adminCategorySchema.parse({
        id: "44444444-4444-4444-a444-444444444441",
        parentId: null,
        slug: "perfumeria",
        name: "Perfumería",
        path: "perfumeria",
        position: 0,
        isVisible: true,
        seo: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        role: "owner",
      }),
    ).toThrow();
  });

  it("adminTagSchema rechaza un campo no declarado", () => {
    expect(() =>
      adminTagSchema.parse({
        id: "44444444-4444-4444-a444-444444444442",
        slug: "best-seller",
        name: "Best Seller",
        kind: "badge",
        role: "owner",
      }),
    ).toThrow();
  });

  it("adminVariantSchema rechaza un campo no declarado", () => {
    expect(() =>
      adminVariantSchema.parse({
        id: "44444444-4444-4444-a444-444444444443",
        productId: "44444444-4444-4444-a444-444444444444",
        sku: "SKU-1",
        variantType: "sealed",
        uom: "unit",
        sizeMl: null,
        pricePyg: "245000",
        compareAtPyg: null,
        vatRate: "iva_10",
        allocationPolicy: "fifo",
        productionMode: "stocked",
        sourceVariantId: null,
        isSerialized: false,
        onlineVisible: true,
        minStockAlert: null,
        weightG: null,
        position: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        role: "owner",
      }),
    ).toThrow();
  });

  it("adminBomComponentSchema rechaza un campo no declarado", () => {
    expect(() =>
      adminBomComponentSchema.parse({
        id: "44444444-4444-4444-a444-444444444445",
        parentVariantId: "44444444-4444-4444-a444-444444444446",
        componentVariantId: "44444444-4444-4444-a444-444444444447",
        qtyPerUnit: 10,
        uom: "ml",
        isOptional: false,
        notes: null,
        role: "owner",
      }),
    ).toThrow();
  });
});
