import type { Prisma } from "@joda/db";
import type { TenantTx } from "../../db/withTenantTx.js";

// Acceso a datos del módulo catálogo (WP-C08). `include` fijo, reusado por
// findProductRow/listProductRows/insertProduct/updateProductRow: todas
// devuelven la misma forma, así que service.ts siempre mapea con el mismo
// mapper sin importar qué operación la produjo. Los nombres de relación con
// sufijo `_product_idToproducts` (no `_kindToproducts`) son los que deja la
// introspección para la FK compuesta de las verticales — ver
// packages/db/README.md, hallazgo 4: ambas apuntan a la misma fila, se elige
// siempre la que NO repite `kind` en el nombre.
const PRODUCT_INCLUDE = {
  brands: { select: { name: true } },
  product_categories: { select: { category_id: true, is_primary: true } },
  product_tags: { select: { tag_id: true } },
  product_variants: { orderBy: { position: "asc" } },
  perfume_details_perfume_details_product_id_tenant_idToproducts: true,
  watch_details_watch_details_product_id_tenant_idToproducts: true,
  accessory_details_accessory_details_product_id_tenant_idToproducts: true,
} as const;

export type ProductRow = Prisma.productsGetPayload<{ include: typeof PRODUCT_INCLUDE }>;
export type VariantRow = Prisma.product_variantsGetPayload<Record<string, never>>;
export type BomComponentRow = Prisma.bom_componentsGetPayload<Record<string, never>>;
export type CategoryRow = Prisma.categoriesGetPayload<Record<string, never>>;
export type TagRow = Prisma.tagsGetPayload<Record<string, never>>;

// ---------------------------------------------------------------------
// Producto
// ---------------------------------------------------------------------
export async function findProductRow(
  tx: TenantTx,
  input: { readonly id: string },
): Promise<ProductRow | null> {
  return tx.products.findFirst({ where: { id: input.id }, include: PRODUCT_INCLUDE });
}

export interface ListProductsFilter {
  readonly kind?: "perfume" | "watch" | "accessory";
  readonly status?: "draft" | "active" | "archived";
  readonly cursorId?: string;
  readonly limit: number;
}

/** Pide `limit + 1` filas — service.ts decide si hay página siguiente descartando la última. */
export async function listProductRows(
  tx: TenantTx,
  filter: ListProductsFilter,
): Promise<ProductRow[]> {
  return tx.products.findMany({
    where: { kind: filter.kind, status: filter.status },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    ...(filter.cursorId && { cursor: { id: filter.cursorId }, skip: 1 }),
    take: filter.limit + 1,
    include: PRODUCT_INCLUDE,
  });
}

export interface InsertProductInput {
  readonly tenantId: string;
  readonly kind: "perfume" | "watch" | "accessory";
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly brandId: string | null;
  readonly seo: Prisma.InputJsonValue;
  readonly facets: Prisma.InputJsonValue;
}

export async function insertProductRow(tx: TenantTx, input: InsertProductInput): Promise<string> {
  const row = await tx.products.create({
    data: {
      tenant_id: input.tenantId,
      kind: input.kind,
      slug: input.slug,
      name: input.name,
      description: input.description,
      brand_id: input.brandId,
      seo: input.seo,
      facets: input.facets,
    },
    select: { id: true },
  });
  return row.id;
}

export interface UpdateProductPatch {
  readonly slug?: string;
  readonly name?: string;
  readonly description?: string | null;
  readonly brandId?: string | null;
  readonly status?: "draft" | "active" | "archived";
  readonly seo?: Prisma.InputJsonValue;
  readonly facets?: Prisma.InputJsonValue;
}

export async function updateProductRow(
  tx: TenantTx,
  id: string,
  patch: UpdateProductPatch,
): Promise<void> {
  await tx.products.update({
    where: { id },
    data: {
      slug: patch.slug,
      name: patch.name,
      description: patch.description,
      brand_id: patch.brandId,
      status: patch.status,
      seo: patch.seo,
      facets: patch.facets,
    },
  });
}

/**
 * `product_categories`/`product_tags` tienen su propio `tenant_id` desde
 * WP-B08, pero eso protege la FILA (que sea legible/escribible solo bajo
 * el tenant que la creó) — no evita por sí solo insertar una fila propia
 * que apunta por FK a un `category_id`/`tag_id` de OTRO tenant (los checks
 * de integridad referencial de Postgres no evalúan RLS, mismo motivo que
 * `product_media`, revisión cruzada de WP-C09). `count()` corre dentro de
 * `withTenantTx`: RLS en `categories`/`tags` hace que una fila ajena no
 * cuente, así que comparar contra el tamaño del set (no el largo del
 * array — un id repetido en el input no debería exigir "dos" existentes)
 * detecta cualquier id que no exista O no sea del tenant, sin distinguir
 * cuál de las dos cosas fue.
 */
export async function countExistingCategoryIds(
  tx: TenantTx,
  ids: readonly string[],
): Promise<number> {
  return tx.categories.count({ where: { id: { in: [...ids] } } });
}

export async function countExistingTagIds(tx: TenantTx, ids: readonly string[]): Promise<number> {
  return tx.tags.count({ where: { id: { in: [...ids] } } });
}

/** Reemplaza TODA la asignación de categorías del producto — el caller siempre manda la lista completa (docs/api-conventions.md, no hay PATCH parcial de una relación N:N con un índice único parcial de por medio). */
export async function replaceProductCategories(
  tx: TenantTx,
  tenantId: string,
  productId: string,
  assignments: readonly { readonly categoryId: string; readonly isPrimary: boolean }[],
): Promise<void> {
  await tx.product_categories.deleteMany({ where: { product_id: productId } });
  if (assignments.length === 0) return;
  await tx.product_categories.createMany({
    data: assignments.map((assignment) => ({
      tenant_id: tenantId,
      product_id: productId,
      category_id: assignment.categoryId,
      is_primary: assignment.isPrimary,
    })),
  });
}

export async function replaceProductTags(
  tx: TenantTx,
  tenantId: string,
  productId: string,
  tagIds: readonly string[],
): Promise<void> {
  await tx.product_tags.deleteMany({ where: { product_id: productId } });
  if (tagIds.length === 0) return;
  await tx.product_tags.createMany({
    data: tagIds.map((tagId) => ({ tenant_id: tenantId, product_id: productId, tag_id: tagId })),
  });
}

// ---------------------------------------------------------------------
// Detalle por vertical — un insert/update por tabla CTI (ADR-005).
// `tenant_id` propio desde WP-B08 (packages/db/migrations/0014_rls_sweep.sql,
// revisión cruzada de WP-C09): antes de eso dependía solo de la FK compuesta
// a `products`, que no evalúa RLS — mismo patrón de vulnerabilidad que
// product_media.
// ---------------------------------------------------------------------
export interface PerfumeDetailsData {
  readonly concentration: string;
  readonly nominalVolumeMl: number;
  readonly olfactoryFamily: string;
  readonly notesTop: readonly string[];
  readonly notesHeart: readonly string[];
  readonly notesBase: readonly string[];
  readonly isDecantable: boolean;
  readonly wasteFactor: number;
  readonly unusableResidueMl: number;
  readonly evaporationMlYear: number;
}

export async function insertPerfumeDetails(
  tx: TenantTx,
  tenantId: string,
  productId: string,
  data: PerfumeDetailsData,
): Promise<void> {
  await tx.perfume_details.create({
    data: {
      tenant_id: tenantId,
      product_id: productId,
      kind: "perfume",
      concentration: data.concentration as Prisma.perfume_detailsCreateInput["concentration"],
      nominal_volume_ml: data.nominalVolumeMl,
      olfactory_family: data.olfactoryFamily,
      notes_top: [...data.notesTop],
      notes_heart: [...data.notesHeart],
      notes_base: [...data.notesBase],
      is_decantable: data.isDecantable,
      waste_factor: data.wasteFactor,
      unusable_residue_ml: data.unusableResidueMl,
      evaporation_ml_year: data.evaporationMlYear,
    },
  });
}

export async function updatePerfumeDetails(
  tx: TenantTx,
  productId: string,
  patch: Partial<PerfumeDetailsData>,
): Promise<void> {
  await tx.perfume_details.update({
    where: { product_id: productId },
    data: {
      concentration: patch.concentration as
        Prisma.perfume_detailsUpdateInput["concentration"] | undefined,
      nominal_volume_ml: patch.nominalVolumeMl,
      olfactory_family: patch.olfactoryFamily,
      notes_top: patch.notesTop ? [...patch.notesTop] : undefined,
      notes_heart: patch.notesHeart ? [...patch.notesHeart] : undefined,
      notes_base: patch.notesBase ? [...patch.notesBase] : undefined,
      is_decantable: patch.isDecantable,
      waste_factor: patch.wasteFactor,
      unusable_residue_ml: patch.unusableResidueMl,
      evaporation_ml_year: patch.evaporationMlYear,
    },
  });
}

export interface WatchDetailsData {
  readonly movement: string;
  readonly caseMaterial: string;
  readonly caseDiameterMm: number | null;
  readonly waterResistanceM: number | null;
  readonly strapMaterial: string | null;
  readonly crystal: string | null;
  readonly warrantyMonths: number;
  readonly requiresSerial: boolean;
}

export async function insertWatchDetails(
  tx: TenantTx,
  tenantId: string,
  productId: string,
  data: WatchDetailsData,
): Promise<void> {
  await tx.watch_details.create({
    data: {
      tenant_id: tenantId,
      product_id: productId,
      kind: "watch",
      movement: data.movement as Prisma.watch_detailsCreateInput["movement"],
      case_material: data.caseMaterial,
      case_diameter_mm: data.caseDiameterMm,
      water_resistance_m: data.waterResistanceM,
      strap_material: data.strapMaterial,
      crystal: data.crystal,
      warranty_months: data.warrantyMonths,
      requires_serial: data.requiresSerial,
    },
  });
}

export async function updateWatchDetails(
  tx: TenantTx,
  productId: string,
  patch: Partial<WatchDetailsData>,
): Promise<void> {
  await tx.watch_details.update({
    where: { product_id: productId },
    data: {
      movement: patch.movement as Prisma.watch_detailsUpdateInput["movement"] | undefined,
      case_material: patch.caseMaterial,
      case_diameter_mm: patch.caseDiameterMm,
      water_resistance_m: patch.waterResistanceM,
      strap_material: patch.strapMaterial,
      crystal: patch.crystal,
      warranty_months: patch.warrantyMonths,
      requires_serial: patch.requiresSerial,
    },
  });
}

export interface AccessoryDetailsData {
  readonly material: string | null;
  readonly color: string | null;
  readonly sizeLabel: string | null;
}

export async function insertAccessoryDetails(
  tx: TenantTx,
  tenantId: string,
  productId: string,
  data: AccessoryDetailsData,
): Promise<void> {
  await tx.accessory_details.create({
    data: {
      tenant_id: tenantId,
      product_id: productId,
      kind: "accessory",
      material: data.material,
      color: data.color,
      size_label: data.sizeLabel,
    },
  });
}

export async function updateAccessoryDetails(
  tx: TenantTx,
  productId: string,
  patch: Partial<AccessoryDetailsData>,
): Promise<void> {
  await tx.accessory_details.update({
    where: { product_id: productId },
    data: { material: patch.material, color: patch.color, size_label: patch.sizeLabel },
  });
}

// ---------------------------------------------------------------------
// Variante
// ---------------------------------------------------------------------
export async function findVariantRow(tx: TenantTx, id: string): Promise<VariantRow | null> {
  return tx.product_variants.findFirst({ where: { id } });
}

/** Si el producto ya tiene su variante de granel — a lo sumo una, impuesto por el índice único parcial de 0028 (WP-C11). */
export async function productHasBulkVariant(tx: TenantTx, productId: string): Promise<boolean> {
  const count = await tx.product_variants.count({
    where: { product_id: productId, variant_type: "bulk" },
  });
  return count > 0;
}

export async function listVariantRows(tx: TenantTx, productId: string): Promise<VariantRow[]> {
  return tx.product_variants.findMany({
    where: { product_id: productId },
    orderBy: { position: "asc" },
  });
}

export interface InsertVariantInput {
  readonly tenantId: string;
  readonly productId: string;
  readonly sku: string;
  readonly variantType: string;
  readonly uom: string;
  readonly sizeMl: number | null;
  readonly pricePyg: bigint;
  readonly compareAtPyg: bigint | null;
  readonly vatRate?: string;
  readonly allocationPolicy?: string;
  readonly productionMode?: string;
  readonly sourceVariantId: string | null;
  readonly isSerialized?: boolean;
  readonly minStockAlert: number | null;
  readonly weightG: number | null;
  readonly position?: number;
}

export async function insertVariantRow(tx: TenantTx, input: InsertVariantInput): Promise<string> {
  const row = await tx.product_variants.create({
    data: {
      tenant_id: input.tenantId,
      product_id: input.productId,
      sku: input.sku,
      variant_type: input.variantType as Prisma.product_variantsCreateInput["variant_type"],
      uom: input.uom as Prisma.product_variantsCreateInput["uom"],
      size_ml: input.sizeMl,
      price_pyg: input.pricePyg,
      compare_at_pyg: input.compareAtPyg,
      vat_rate: input.vatRate as Prisma.product_variantsCreateInput["vat_rate"] | undefined,
      allocation_policy: input.allocationPolicy as
        Prisma.product_variantsCreateInput["allocation_policy"] | undefined,
      production_mode: input.productionMode as
        Prisma.product_variantsCreateInput["production_mode"] | undefined,
      source_variant_id: input.sourceVariantId,
      is_serialized: input.isSerialized,
      min_stock_alert: input.minStockAlert,
      weight_g: input.weightG,
      position: input.position,
    },
    select: { id: true },
  });
  return row.id;
}

export interface UpdateVariantPatch {
  readonly sku?: string;
  readonly pricePyg?: bigint;
  readonly compareAtPyg?: bigint | null;
  readonly vatRate?: string;
  readonly allocationPolicy?: string;
  readonly productionMode?: string;
  readonly sourceVariantId?: string | null;
  readonly isSerialized?: boolean;
  readonly minStockAlert?: number | null;
  readonly weightG?: number | null;
  readonly position?: number;
}

export async function updateVariantRow(
  tx: TenantTx,
  id: string,
  patch: UpdateVariantPatch,
): Promise<void> {
  await tx.product_variants.update({
    where: { id },
    data: {
      sku: patch.sku,
      price_pyg: patch.pricePyg,
      compare_at_pyg: patch.compareAtPyg,
      vat_rate: patch.vatRate as Prisma.product_variantsUpdateInput["vat_rate"] | undefined,
      allocation_policy: patch.allocationPolicy as
        Prisma.product_variantsUpdateInput["allocation_policy"] | undefined,
      production_mode: patch.productionMode as
        Prisma.product_variantsUpdateInput["production_mode"] | undefined,
      source_variant_id: patch.sourceVariantId,
      is_serialized: patch.isSerialized,
      min_stock_alert: patch.minStockAlert,
      weight_g: patch.weightG,
      position: patch.position,
    },
  });
}

// ---------------------------------------------------------------------
// BOM
// ---------------------------------------------------------------------
export async function findBomComponentRow(
  tx: TenantTx,
  id: string,
): Promise<BomComponentRow | null> {
  return tx.bom_components.findFirst({ where: { id } });
}

export async function listBomComponentRows(
  tx: TenantTx,
  parentVariantId: string,
): Promise<BomComponentRow[]> {
  return tx.bom_components.findMany({ where: { parent_variant_id: parentVariantId } });
}

export interface InsertBomComponentInput {
  readonly tenantId: string;
  readonly parentVariantId: string;
  readonly componentVariantId: string;
  readonly qtyPerUnit: number;
  readonly uom: string;
  readonly isOptional?: boolean;
  readonly notes: string | null;
}

export async function insertBomComponentRow(
  tx: TenantTx,
  input: InsertBomComponentInput,
): Promise<string> {
  const row = await tx.bom_components.create({
    data: {
      tenant_id: input.tenantId,
      parent_variant_id: input.parentVariantId,
      component_variant_id: input.componentVariantId,
      qty_per_unit: input.qtyPerUnit,
      uom: input.uom as Prisma.bom_componentsCreateInput["uom"],
      is_optional: input.isOptional,
      notes: input.notes,
    },
    select: { id: true },
  });
  return row.id;
}

export interface UpdateBomComponentPatch {
  readonly qtyPerUnit?: number;
  readonly uom?: string;
  readonly isOptional?: boolean;
  readonly notes?: string | null;
}

export async function updateBomComponentRow(
  tx: TenantTx,
  id: string,
  patch: UpdateBomComponentPatch,
): Promise<void> {
  await tx.bom_components.update({
    where: { id },
    data: {
      qty_per_unit: patch.qtyPerUnit,
      uom: patch.uom as Prisma.bom_componentsUpdateInput["uom"] | undefined,
      is_optional: patch.isOptional,
      notes: patch.notes,
    },
  });
}

export async function deleteBomComponentRow(tx: TenantTx, id: string): Promise<void> {
  await tx.bom_components.delete({ where: { id } });
}

// ---------------------------------------------------------------------
// Categoría
// ---------------------------------------------------------------------
export async function findCategoryRow(tx: TenantTx, id: string): Promise<CategoryRow | null> {
  return tx.categories.findFirst({ where: { id } });
}

export async function listCategoryRows(
  tx: TenantTx,
  filter: { readonly cursorId?: string; readonly limit: number },
): Promise<CategoryRow[]> {
  return tx.categories.findMany({
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    ...(filter.cursorId && { cursor: { id: filter.cursorId }, skip: 1 }),
    take: filter.limit + 1,
  });
}

export interface InsertCategoryInput {
  readonly tenantId: string;
  readonly parentId: string | null;
  readonly slug: string;
  readonly name: string;
  readonly path: string;
  readonly position?: number;
  readonly isVisible?: boolean;
  readonly seo?: Prisma.InputJsonValue;
}

export async function insertCategoryRow(tx: TenantTx, input: InsertCategoryInput): Promise<string> {
  const row = await tx.categories.create({
    data: {
      tenant_id: input.tenantId,
      parent_id: input.parentId,
      slug: input.slug,
      name: input.name,
      path: input.path,
      position: input.position,
      is_visible: input.isVisible,
      seo: input.seo,
    },
    select: { id: true },
  });
  return row.id;
}

export interface UpdateCategoryPatch {
  readonly name?: string;
  readonly position?: number;
  readonly isVisible?: boolean;
  readonly seo?: Prisma.InputJsonValue;
}

export async function updateCategoryRow(
  tx: TenantTx,
  id: string,
  patch: UpdateCategoryPatch,
): Promise<void> {
  await tx.categories.update({
    where: { id },
    data: {
      name: patch.name,
      position: patch.position,
      is_visible: patch.isVisible,
      seo: patch.seo,
    },
  });
}

/**
 * Bloquea TODAS las categorías del tenant (RLS deja ver solo las propias), en
 * una sola sentencia y en orden ascendente de `id`. Mover un nodo (o dar de
 * alta una categoría bajo un padre) lee el árbol para decidir y después lo
 * escribe: sin serializar, dos movimientos cruzados (A bajo B y B bajo A)
 * pasan cada uno la comprobación contra un árbol que el otro está por
 * cambiar, y el resultado es un ciclo; un alta puede heredar el `path` que un
 * movimiento acaba de dejar viejo. Con el bloqueo, el segundo espera, y como
 * en READ COMMITTED cada sentencia toma un snapshot nuevo, ya lee el árbol
 * que dejó el primero. El orden ascendente es lo que evita el interbloqueo
 * entre dos de estos (.claude/rules/api.md, "Concurrencia"): no lo
 * "simplifiques" a un FOR UPDATE por fila ni le saques el ORDER BY.
 *
 * Es `NO KEY UPDATE` y no `UPDATE` a propósito: dar de alta un producto
 * inserta en `product_categories`, y cada fila toma `FOR KEY SHARE` sobre su
 * categoría por la FK. `FOR UPDATE` haría esperar ahí a todo el alta de
 * productos, y como esas filas se insertan en el orden en que el cliente
 * mandó las categorías (no el ascendente), abriría un interbloqueo.
 */
export async function lockCategoryTree(tx: TenantTx): Promise<void> {
  await tx.$queryRaw`SELECT c.id FROM app.categories c ORDER BY c.id FOR NO KEY UPDATE OF c`;
}

/** ¿`candidateId` es `rootId` o un descendiente suyo? Una sola consulta recursiva por `parent_id`, no por prefijo de `path`: no depende de qué caracteres tenga un slug. */
export async function isCategoryInSubtree(
  tx: TenantTx,
  rootId: string,
  candidateId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ found: boolean }[]>`
    WITH RECURSIVE subtree(id) AS (
      SELECT c.id FROM app.categories c WHERE c.id = ${rootId}::uuid
      UNION
      SELECT child.id FROM app.categories child JOIN subtree s ON child.parent_id = s.id
    )
    SELECT EXISTS (SELECT 1 FROM subtree WHERE id = ${candidateId}::uuid) AS found`;
  return rows[0]?.found === true;
}

/**
 * Cambia el padre de una categoría y recompone el `path` materializado de ella
 * y de todo su subárbol, en una sola sentencia. El `path` de cada
 * descendiente sale de encadenar el del padre nuevo con los slugs, no de
 * reemplazar un prefijo de texto. `parentId` null la deja como raíz.
 */
export async function moveCategorySubtree(
  tx: TenantTx,
  id: string,
  parentId: string | null,
  newPath: string,
): Promise<void> {
  await tx.$executeRaw`
    WITH RECURSIVE subtree(id, new_path) AS (
      SELECT c.id, ${newPath}::text FROM app.categories c WHERE c.id = ${id}::uuid
      UNION ALL
      SELECT child.id, s.new_path || '/' || child.slug::text
      FROM app.categories child JOIN subtree s ON child.parent_id = s.id
    )
    UPDATE app.categories c
    SET path = s.new_path,
        parent_id = CASE WHEN c.id = ${id}::uuid THEN ${parentId}::uuid ELSE c.parent_id END
    FROM subtree s
    WHERE c.id = s.id`;
}

// ---------------------------------------------------------------------
// Tag
// ---------------------------------------------------------------------
export async function findTagRow(tx: TenantTx, id: string): Promise<TagRow | null> {
  return tx.tags.findFirst({ where: { id } });
}

export async function listTagRows(
  tx: TenantTx,
  filter: { readonly cursorId?: string; readonly limit: number },
): Promise<TagRow[]> {
  return tx.tags.findMany({
    orderBy: { id: "desc" },
    ...(filter.cursorId && { cursor: { id: filter.cursorId }, skip: 1 }),
    take: filter.limit + 1,
  });
}

export interface InsertTagInput {
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly kind?: string;
}

export async function insertTagRow(tx: TenantTx, input: InsertTagInput): Promise<string> {
  const row = await tx.tags.create({
    data: { tenant_id: input.tenantId, slug: input.slug, name: input.name, kind: input.kind },
    select: { id: true },
  });
  return row.id;
}

export interface UpdateTagPatch {
  readonly name?: string;
  readonly kind?: string;
}

export async function updateTagRow(tx: TenantTx, id: string, patch: UpdateTagPatch): Promise<void> {
  await tx.tags.update({ where: { id }, data: { name: patch.name, kind: patch.kind } });
}
