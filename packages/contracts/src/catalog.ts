// Esquemas del módulo catálogo (WP-C08, docs/api-conventions.md §7 "DTOs por
// audiencia", docs/data-model.md §3.1/3.2, RF-CAT-01…07). packages/contracts
// no depende de packages/domain (frontera de tipos independiente, ver el
// comentario de auth.ts): los enums de acá repiten los mismos literales que
// packages/db/migrations/0001_foundation.sql, no se importan de ningún lado.
import { z } from "zod";
import { idSchema } from "./shared/id.js";
import { pygAmountSchema } from "./shared/money.js";
import { MAX_PAGE_SIZE, paginatedOutputSchema } from "./shared/pagination.js";

// ---------------------------------------------------------------------
// Enums — mismos valores que los CREATE TYPE de 0001_foundation.sql.
// ---------------------------------------------------------------------
export const productKindSchema = z.enum(["perfume", "watch", "accessory"]);
export type ProductKind = z.infer<typeof productKindSchema>;

export const productStatusSchema = z.enum(["draft", "active", "archived"]);
export type ProductStatus = z.infer<typeof productStatusSchema>;

export const uomSchema = z.enum(["unit", "ml"]);
export type Uom = z.infer<typeof uomSchema>;

export const variantTypeSchema = z.enum(["sealed", "decant", "tester", "unit", "supply", "bulk"]);
export type VariantType = z.infer<typeof variantTypeSchema>;

export const productionModeSchema = z.enum(["stocked", "made_to_order"]);
export type ProductionMode = z.infer<typeof productionModeSchema>;

export const allocationPolicySchema = z.enum(["fifo", "fefo", "serial", "manual"]);
export type AllocationPolicy = z.infer<typeof allocationPolicySchema>;

export const vatRateSchema = z.enum(["iva_10", "iva_5", "exenta"]);
export type VatRate = z.infer<typeof vatRateSchema>;

export const perfumeConcentrationSchema = z.enum([
  "parfum",
  "extrait",
  "edp",
  "edt",
  "edc",
  "oil",
  "attar",
]);
export type PerfumeConcentration = z.infer<typeof perfumeConcentrationSchema>;

export const watchMovementSchema = z.enum([
  "quartz",
  "automatic",
  "manual",
  "solar",
  "kinetic",
  "spring_drive",
]);
export type WatchMovement = z.infer<typeof watchMovementSchema>;

// `tags.kind` es `text` libre en la base (sin CHECK), pero el comentario de
// 0003_catalog.sql documenta un conjunto cerrado — se aplica acá, en la
// frontera, no en la base (docs/data-model.md §1, "Enums | tipos nativos...
// cuando el conjunto es cerrado y lo conoce el código").
export const tagKindSchema = z.enum(["marketing", "coleccion", "badge"]);
export type TagKind = z.infer<typeof tagKindSchema>;

// jsonb sin forma fija — `seo` y `facets` (docs/data-model.md §1: "Enums" no
// aplica acá, son columnas de descubrimiento libres).
const jsonRecordSchema = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------
// Facetas por vertical — SOLO lo descriptivo, apto para el storefront
// (packages/domain/src/catalog/facets.ts las arma; ADR-005: "lo puramente
// descriptivo va a products.facets"). La merma (waste_factor,
// unusable_residue_ml, evaporation_ml_year) y requires_serial NO están acá:
// son operativas, nunca las ve un cliente — quedan solo en el detalle admin,
// más abajo.
// ---------------------------------------------------------------------
export const perfumeFacetSchema = z
  .object({
    concentration: perfumeConcentrationSchema,
    nominalVolumeMl: z.number().positive(),
    olfactoryFamily: z.string(),
    notesTop: z.array(z.string()),
    notesHeart: z.array(z.string()),
    notesBase: z.array(z.string()),
    isDecantable: z.boolean(),
  })
  .strict();
export type PerfumeFacet = z.infer<typeof perfumeFacetSchema>;

export const watchFacetSchema = z
  .object({
    movement: watchMovementSchema,
    caseMaterial: z.string(),
    caseDiameterMm: z.number().positive().nullable(),
    waterResistanceM: z.number().int().nonnegative().nullable(),
    strapMaterial: z.string().nullable(),
    crystal: z.string().nullable(),
    warrantyMonths: z.number().int().nonnegative(),
  })
  .strict();
export type WatchFacet = z.infer<typeof watchFacetSchema>;

export const accessoryFacetSchema = z
  .object({
    material: z.string().nullable(),
    color: z.string().nullable(),
    sizeLabel: z.string().nullable(),
  })
  .strict();
export type AccessoryFacet = z.infer<typeof accessoryFacetSchema>;

// ---------------------------------------------------------------------
// Detalle ADMINISTRATIVO por vertical — la fila CTI completa
// (perfume_details/watch_details/accessory_details), incluida la merma:
// esto es lo que el formulario de staff edita, nunca lo que ve un cliente.
// ---------------------------------------------------------------------
export const adminPerfumeDetailsSchema = perfumeFacetSchema
  .extend({
    wasteFactor: z.number().nonnegative(),
    unusableResidueMl: z.number().nonnegative(),
    evaporationMlYear: z.number().nonnegative(),
  })
  .strict();
export type AdminPerfumeDetails = z.infer<typeof adminPerfumeDetailsSchema>;

export const adminWatchDetailsSchema = watchFacetSchema
  .extend({ requiresSerial: z.boolean() })
  .strict();
export type AdminWatchDetails = z.infer<typeof adminWatchDetailsSchema>;

// accessory_details no tiene ningún campo operativo aparte de lo
// descriptivo: el detalle admin coincide con la faceta pública.
export const adminAccessoryDetailsSchema = accessoryFacetSchema;
export type AdminAccessoryDetails = z.infer<typeof adminAccessoryDetailsSchema>;

// ---------------------------------------------------------------------
// Variante — dos esquemas DISTINTOS (.claude/rules/contracts.md), no uno
// con campos opcionales: publicVariant expone `inStock: boolean`, nunca la
// cantidad ni ningún campo operativo (allocationPolicy, minStockAlert,
// sourceVariantId...) — es del contrato mismo, no una decisión de frontend
// (WP-E05/G05). NO se extiende de publicVariant: fuera de sku/tipo/precio,
// el contenido diverge tanto (inStock computado vs. campos operativos crudos)
// que extender obligaría a pisar casi todas las claves igual.
// ---------------------------------------------------------------------
export const publicVariantSchema = z
  .object({
    id: idSchema,
    sku: z.string(),
    variantType: variantTypeSchema,
    uom: uomSchema,
    sizeMl: z.number().positive().nullable(),
    pricePyg: pygAmountSchema,
    compareAtPyg: pygAmountSchema.nullable(),
    vatRate: vatRateSchema,
    inStock: z.boolean(),
  })
  .strict();
export type PublicVariant = z.infer<typeof publicVariantSchema>;

export const adminVariantSchema = z
  .object({
    id: idSchema,
    productId: idSchema,
    sku: z.string(),
    variantType: variantTypeSchema,
    uom: uomSchema,
    sizeMl: z.number().positive().nullable(),
    pricePyg: pygAmountSchema,
    compareAtPyg: pygAmountSchema.nullable(),
    vatRate: vatRateSchema,
    allocationPolicy: allocationPolicySchema,
    productionMode: productionModeSchema,
    sourceVariantId: idSchema.nullable(),
    isSerialized: z.boolean(),
    onlineVisible: z.boolean(),
    minStockAlert: z.number().nonnegative().nullable(),
    weightG: z.number().positive().nullable(),
    position: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type AdminVariant = z.infer<typeof adminVariantSchema>;

const VARIANTS_WITH_SIZE = new Set<VariantType>(["sealed", "decant", "tester"]);
const VARIANTS_IN_ML = new Set<VariantType>(["decant", "bulk"]);

// onlineVisible queda fuera de create/update: esos procedimientos exigen
// catalog.product:write. La visibilidad se administrará bajo
// catalog.product:publish (RF-CAT-09), nunca como campo de edición común.
// Mismos CHECK de product_variants (packages/db/migrations/0003_catalog.sql,
// líneas 174-183) validados en la frontera para devolver VALIDATION_* con un
// mensaje claro en vez de dejar que Postgres los rechace como
// CONFLICT_CHECK_VIOLATION genérico — pero solo en create: en update estos
// tres campos son inmutables (ver updateVariantInput), así que no hay
// combinación parcial que revalidar ahí.
export const createVariantInput = z
  .object({
    productId: idSchema,
    sku: z.string().min(1),
    variantType: variantTypeSchema,
    uom: uomSchema,
    sizeMl: z.number().positive().nullable(),
    pricePyg: pygAmountSchema,
    compareAtPyg: pygAmountSchema.nullable().optional(),
    vatRate: vatRateSchema.optional(),
    allocationPolicy: allocationPolicySchema.optional(),
    productionMode: productionModeSchema.optional(),
    sourceVariantId: idSchema.nullable().optional(),
    isSerialized: z.boolean().optional(),
    minStockAlert: z.number().nonnegative().nullable().optional(),
    weightG: z.number().positive().nullable().optional(),
    position: z.number().int().optional(),
  })
  .strict()
  .refine(
    (input) =>
      VARIANTS_WITH_SIZE.has(input.variantType) ? input.sizeMl !== null : input.sizeMl === null,
    {
      message: "sealed/decant/tester requieren sizeMl; unit/supply/bulk no lo admiten.",
      path: ["sizeMl"],
    },
  )
  .refine(
    (input) => (VARIANTS_IN_ML.has(input.variantType) ? input.uom === "ml" : input.uom === "unit"),
    { message: "decant/bulk se miden en ml; el resto de las variantes, en unit.", path: ["uom"] },
  )
  .refine(
    (input) => (input.productionMode ?? "stocked") === "stocked" || input.sourceVariantId != null,
    {
      message: "Una variante made_to_order necesita declarar sourceVariantId.",
      path: ["sourceVariantId"],
    },
  )
  .refine((input) => !input.isSerialized || input.uom === "unit", {
    message: "Solo una variante en unit puede serializarse.",
    path: ["isSerialized"],
  });
export type CreateVariantInput = z.infer<typeof createVariantInput>;

// variantType/uom/sizeMl/productId no se editan (son la identidad
// estructural de la variante, atada por los CHECK de arriba) — cambiarla es
// crear una variante nueva, no un update.
export const updateVariantInput = z
  .object({
    id: idSchema,
    sku: z.string().min(1).optional(),
    pricePyg: pygAmountSchema.optional(),
    compareAtPyg: pygAmountSchema.nullable().optional(),
    vatRate: vatRateSchema.optional(),
    allocationPolicy: allocationPolicySchema.optional(),
    productionMode: productionModeSchema.optional(),
    sourceVariantId: idSchema.nullable().optional(),
    isSerialized: z.boolean().optional(),
    minStockAlert: z.number().nonnegative().nullable().optional(),
    weightG: z.number().positive().nullable().optional(),
    position: z.number().int().optional(),
  })
  .strict()
  .refine(
    (input) => input.productionMode !== "made_to_order" || input.sourceVariantId !== undefined,
    {
      message: "Pasar a made_to_order requiere declarar sourceVariantId en el mismo pedido.",
      path: ["sourceVariantId"],
    },
  );
export type UpdateVariantInput = z.infer<typeof updateVariantInput>;

export const listVariantsInput = z.object({ productId: idSchema }).strict();
export const byVariantIdInput = z.object({ id: idSchema }).strict();

// ---------------------------------------------------------------------
// BOM — RF-CAT-07, lista de insumos de una variante FRACCIONADA (decant),
// no de una sellada/granel (docs/data-model.md §3.2, GLOSARIO.md "BOM").
// La restricción "parentVariantId tiene que ser una variante decant" no es
// un CHECK de base (bom_components no lo declara) — la valida el service
// contra la variante ya creada, con un error de negocio claro.
// ---------------------------------------------------------------------
export const adminBomComponentSchema = z
  .object({
    id: idSchema,
    parentVariantId: idSchema,
    componentVariantId: idSchema,
    qtyPerUnit: z.number().positive(),
    uom: uomSchema,
    isOptional: z.boolean(),
    notes: z.string().nullable(),
  })
  .strict();
export type AdminBomComponent = z.infer<typeof adminBomComponentSchema>;

export const createBomComponentInput = z
  .object({
    parentVariantId: idSchema,
    componentVariantId: idSchema,
    qtyPerUnit: z.number().positive(),
    uom: uomSchema,
    isOptional: z.boolean().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict()
  .refine((input) => input.parentVariantId !== input.componentVariantId, {
    message: "Un insumo no puede ser componente de sí mismo.",
    path: ["componentVariantId"],
  });
export type CreateBomComponentInput = z.infer<typeof createBomComponentInput>;

export const updateBomComponentInput = z
  .object({
    id: idSchema,
    qtyPerUnit: z.number().positive().optional(),
    uom: uomSchema.optional(),
    isOptional: z.boolean().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();
export type UpdateBomComponentInput = z.infer<typeof updateBomComponentInput>;

export const listBomComponentsInput = z.object({ variantId: idSchema }).strict();
export const removeBomComponentInput = z.object({ id: idSchema }).strict();
export const removeBomComponentOutput = z.object({ ok: z.literal(true) }).strict();

// ---------------------------------------------------------------------
// Categoría — árbol de navegación comercial (ADR-006), compartido entre las
// tres verticales. `parentId` no se edita después de creada (re-parentar
// implica recalcular el `path` materializado de todos los descendientes,
// fuera del alcance de RF-CAT-03 — "administrar... orden y visibilidad", no
// "mover"). No hay un mecanismo de reemplazo dentro de este WP: `categories`
// no tiene columna de estado (solo `is_visible`) y su router
// (apps/api/src/modules/catalog/router.ts) no declara `archive` ni `delete`
// — "crear una nueva y migrar productos a mano" es la única salida hoy, no
// un flujo soportado por el sistema. Si reparentar termina haciendo falta,
// es un WP propio (recalcular `path` en cascada sobre los descendientes).
// ---------------------------------------------------------------------
export const adminCategorySchema = z
  .object({
    id: idSchema,
    parentId: idSchema.nullable(),
    slug: z.string(),
    name: z.string(),
    path: z.string(),
    position: z.number().int(),
    isVisible: z.boolean(),
    seo: jsonRecordSchema,
    createdAt: z.string(),
  })
  .strict();
export type AdminCategory = z.infer<typeof adminCategorySchema>;

export const createCategoryInput = z
  .object({
    parentId: idSchema.nullable().optional(),
    slug: z.string().min(1),
    name: z.string().min(1),
    position: z.number().int().optional(),
    isVisible: z.boolean().optional(),
    seo: jsonRecordSchema.optional(),
  })
  .strict();
export type CreateCategoryInput = z.infer<typeof createCategoryInput>;

export const updateCategoryInput = z
  .object({
    id: idSchema,
    name: z.string().min(1).optional(),
    position: z.number().int().optional(),
    isVisible: z.boolean().optional(),
    seo: jsonRecordSchema.optional(),
  })
  .strict();
export type UpdateCategoryInput = z.infer<typeof updateCategoryInput>;

export const listCategoriesOutput = paginatedOutputSchema(adminCategorySchema);

// ---------------------------------------------------------------------
// Tag — marca transversal de marketing (ADR-006). `slug` no se edita
// después de creado, mismo criterio que category.
// ---------------------------------------------------------------------
export const adminTagSchema = z
  .object({ id: idSchema, slug: z.string(), name: z.string(), kind: tagKindSchema })
  .strict();
export type AdminTag = z.infer<typeof adminTagSchema>;

export const createTagInput = z
  .object({ slug: z.string().min(1), name: z.string().min(1), kind: tagKindSchema.optional() })
  .strict();
export type CreateTagInput = z.infer<typeof createTagInput>;

export const updateTagInput = z
  .object({ id: idSchema, name: z.string().min(1).optional(), kind: tagKindSchema.optional() })
  .strict();
export type UpdateTagInput = z.infer<typeof updateTagInput>;

export const listTagsOutput = paginatedOutputSchema(adminTagSchema);

// ---------------------------------------------------------------------
// Producto — el núcleo CTI (ADR-005): `kind` fija la vertical para siempre,
// nunca se edita (cambiar de vertical es un producto distinto, no un
// update). publicProduct sigue el ejemplo de docs/api-conventions.md §7 al
// pie de la letra: `facets` es el único lugar por el que lo descriptivo de
// cada vertical llega al público — sin unión discriminada por kind del lado
// público, porque el storefront no necesita el detalle tipado, solo mostrar
// lo que packages/domain/src/catalog/facets.ts ya proyectó.
//
// publicProductSchema/publicVariantSchema NO TIENEN NINGÚN CONSUMIDOR
// TODAVÍA — no hay un `publicProcedure` de catálogo en
// apps/api/src/modules/catalog/router.ts (`publicProcedure` en sí no existe
// como infraestructura en apps/api; solo `staffProcedure`, WP-C05) y el
// storefront real (bloque G, posterior al corte) va a leer las vistas
// `v_catalog_*` directamente con `joda_readonly`
// (packages/db/migrations/0010_security_rls.sql), no tRPC — ver
// docs/data-model.md §7 y AGENTS.md § "Solo apps/api escribe en la base...
// el storefront lee vistas estables". Esto es andamiaje DELIBERADO: el
// criterio de WP-C08 (docs/backlog.md) pide el contrato público con su test
// de claves prohibidas, no un endpoint — para que cuando exista un
// consumidor real (por tRPC o para describir la forma que esas vistas
// tienen que respetar) la garantía de "nunca cost/landed/supplier/margin/
// fx_rate" ya esté verificada, no se agregue recién en ese momento.
// ---------------------------------------------------------------------
export const publicProductSchema = z
  .object({
    id: idSchema,
    kind: productKindSchema,
    slug: z.string(),
    name: z.string(),
    brandName: z.string().nullable(),
    facets: jsonRecordSchema,
    variants: z.array(publicVariantSchema),
  })
  .strict();
export type PublicProduct = z.infer<typeof publicProductSchema>;

const adminProductBase = z.object({
  id: idSchema,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: productStatusSchema,
  brandId: idSchema.nullable(),
  brandName: z.string().nullable(),
  primaryCategoryId: idSchema.nullable(),
  categoryIds: z.array(idSchema),
  tagIds: z.array(idSchema),
  seo: jsonRecordSchema,
  facets: jsonRecordSchema,
  variants: z.array(adminVariantSchema),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// costSummary/supplierRefs del ejemplo de docs/api-conventions.md §7 no
// aparecen acá TODAVÍA: el costo real vive en inventory_lots /
// movement_cost_allocations, y el primer procedimiento que lo expone por API
// es WP-C10 ("RF-INV-05: consultar el historial de movimientos de un lote,
// con su costo", docs/especificacion-software.md §2.2) — no C08, no hay dato
// real que exponer hasta que ese WP puntual exista. catalog.test.ts (claves
// prohibidas) sigue protegiendo publicProduct para cuando sí lo haya.
export const adminProductSchema = z.discriminatedUnion("kind", [
  adminProductBase
    .extend({ kind: z.literal("perfume"), perfumeDetails: adminPerfumeDetailsSchema })
    .strict(),
  adminProductBase
    .extend({ kind: z.literal("watch"), watchDetails: adminWatchDetailsSchema })
    .strict(),
  adminProductBase
    .extend({ kind: z.literal("accessory"), accessoryDetails: adminAccessoryDetailsSchema })
    .strict(),
]);
export type AdminProduct = z.infer<typeof adminProductSchema>;

const productAssignmentFields = {
  categoryIds: z.array(idSchema).min(1),
  primaryCategoryId: idSchema,
  tagIds: z.array(idSchema).optional(),
};

function refinePrimaryCategory<
  T extends { categoryIds: readonly string[]; primaryCategoryId: string },
>(input: T): boolean {
  return input.categoryIds.includes(input.primaryCategoryId);
}

export const createProductInput = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("perfume"),
        slug: z.string().min(1),
        name: z.string().min(1),
        description: z.string().nullable().optional(),
        brandId: idSchema.nullable().optional(),
        seo: jsonRecordSchema.optional(),
        ...productAssignmentFields,
        perfumeDetails: adminPerfumeDetailsSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("watch"),
        slug: z.string().min(1),
        name: z.string().min(1),
        description: z.string().nullable().optional(),
        brandId: idSchema.nullable().optional(),
        seo: jsonRecordSchema.optional(),
        ...productAssignmentFields,
        watchDetails: adminWatchDetailsSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("accessory"),
        slug: z.string().min(1),
        name: z.string().min(1),
        description: z.string().nullable().optional(),
        brandId: idSchema.nullable().optional(),
        seo: jsonRecordSchema.optional(),
        ...productAssignmentFields,
        accessoryDetails: adminAccessoryDetailsSchema,
      })
      .strict(),
  ])
  .refine(refinePrimaryCategory, {
    message: "primaryCategoryId debe estar incluido en categoryIds.",
    path: ["primaryCategoryId"],
  });
export type CreateProductInput = z.infer<typeof createProductInput>;

// `status` tampoco viaja por este procedimiento: catalog.product.update solo
// exige catalog.product:write y no debe activar una ficha que ya tenga
// published_at. La transición de publicación tendrá un procedimiento propio
// protegido por catalog.product:publish (RF-CAT-09).
// A diferencia de create, update NO redeclara `kind`: la vertical es fija
// (ver el comentario de arriba de adminProductSchema). El service rechaza
// perfumeDetails/watchDetails/accessoryDetails que no correspondan a la
// vertical real del producto — eso no se puede expresar en Zod sin conocer
// el `kind` existente, que no viaja en este input.
export const updateProductInput = z
  .object({
    id: idSchema,
    slug: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    brandId: idSchema.nullable().optional(),
    seo: jsonRecordSchema.optional(),
    categoryIds: z.array(idSchema).min(1).optional(),
    primaryCategoryId: idSchema.optional(),
    tagIds: z.array(idSchema).optional(),
    perfumeDetails: adminPerfumeDetailsSchema.partial().optional(),
    watchDetails: adminWatchDetailsSchema.partial().optional(),
    accessoryDetails: adminAccessoryDetailsSchema.partial().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.categoryIds === undefined ||
      input.primaryCategoryId === undefined ||
      input.categoryIds.includes(input.primaryCategoryId),
    {
      message: "primaryCategoryId debe estar incluido en categoryIds.",
      path: ["primaryCategoryId"],
    },
  )
  .refine((input) => input.primaryCategoryId === undefined || input.categoryIds !== undefined, {
    message: "Cambiar primaryCategoryId requiere reenviar categoryIds completo.",
    path: ["categoryIds"],
  });
export type UpdateProductInput = z.infer<typeof updateProductInput>;

export const archiveProductInput = z.object({ id: idSchema }).strict();
export const byProductIdInput = z.object({ id: idSchema }).strict();

export const listProductsInput = z
  .object({
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
    kind: productKindSchema.optional(),
    status: productStatusSchema.optional(),
  })
  .strict();
export type ListProductsInput = z.infer<typeof listProductsInput>;

export const listProductsOutput = paginatedOutputSchema(adminProductSchema);
