import {
  DEFAULT_PAGE_SIZE,
  type AdminBomComponent,
  type AdminCategory,
  type AdminProduct,
  type AdminTag,
  type AdminVariant,
  type CreateBomComponentInput,
  type CreateCategoryInput,
  type CreateProductInput,
  type CreateTagInput,
  type CreateVariantInput,
  type ListProductsInput,
  type PaginationInput,
  type ProductKind,
  type UpdateBomComponentInput,
  type UpdateCategoryInput,
  type UpdateProductInput,
  type UpdateTagInput,
  type UpdateVariantInput,
} from "@joda/contracts";
import { buildProductFacets, type ProductFacetInput } from "@joda/domain";
import type { PrismaClient, Prisma } from "@joda/db";
import { decodeCursor, encodeCursor } from "../../db/cursor.js";
import { withTenantTx, type TenantTx, type TenantTxContext } from "../../db/withTenantTx.js";
import { appError, toTRPCError } from "../../middleware/errorMapper.js";
import {
  toAdminBomComponent,
  toAdminCategory,
  toAdminProduct,
  toAdminTag,
  toAdminVariant,
} from "./mappers.js";
import * as repo from "./repository.js";

const NOT_FOUND_ERROR = appError("NOT_FOUND", 404, "No encontrado.");
const INVALID_CURSOR_ERROR = appError(
  "VALIDATION_INVALID_CURSOR",
  400,
  "El cursor de paginación no es válido.",
);

function requireCursorId(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  const id = decodeCursor(cursor);
  if (id === null) throw toTRPCError(INVALID_CURSOR_ERROR);
  return id;
}

function paginate<Row extends { readonly id: string }, Dto>(
  rows: readonly Row[],
  limit: number,
  toDto: (row: Row) => Dto,
): { readonly items: Dto[]; readonly nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = page.at(-1);
  return {
    items: page.map(toDto),
    nextCursor: hasMore && lastRow ? encodeCursor(lastRow.id) : null,
  };
}

function parsePygAmount(value: string): bigint {
  // pygAmountSchema ya validó el formato (/^-?\d+$/) en la frontera de tRPC —
  // BigInt(value) no puede lanzar acá.
  return BigInt(value);
}

// ---------------------------------------------------------------------
// Producto
// ---------------------------------------------------------------------
export async function listProducts(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: ListProductsInput,
) {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  const cursorId = requireCursorId(input.cursor);
  return withTenantTx(db, ctx, async (tx) => {
    const rows = await repo.listProductRows(tx, {
      kind: input.kind,
      status: input.status,
      cursorId,
      limit,
    });
    return paginate(rows, limit, toAdminProduct);
  });
}

export async function getProductById(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: { readonly id: string },
): Promise<AdminProduct> {
  return withTenantTx(db, ctx, async (tx) => {
    const row = await repo.findProductRow(tx, input);
    if (!row) throw toTRPCError(NOT_FOUND_ERROR);
    return toAdminProduct(row);
  });
}

function toFacetInputFromCreate(input: CreateProductInput): ProductFacetInput {
  switch (input.kind) {
    case "perfume":
      return { kind: "perfume", ...input.perfumeDetails };
    case "watch":
      return { kind: "watch", ...input.watchDetails };
    case "accessory":
      return { kind: "accessory", ...input.accessoryDetails };
  }
}

function categoryAssignments(
  categoryIds: readonly string[],
  primaryCategoryId: string | undefined,
): { readonly categoryId: string; readonly isPrimary: boolean }[] {
  return categoryIds.map((categoryId) => ({
    categoryId,
    isPrimary: categoryId === primaryCategoryId,
  }));
}

/**
 * `product_categories`/`product_tags` tienen tenant_id propio desde WP-B08,
 * pero eso no evita insertar una fila propia con un `category_id`/`tag_id`
 * de OTRO tenant (revisión cruzada de WP-C09, mismo patrón que
 * `product_media`) — sin esto, un `categoryId`/`tagId` ajeno pasaba la FK
 * igual. `count()` corre dentro del mismo `withTenantTx`: RLS hace que un
 * id ajeno no cuente, así que comparar contra el tamaño del SET (no el
 * largo del array, un id repetido no debería exigir "dos") detecta
 * cualquier id inexistente o de otro tenant, sin necesitar distinguir cuál.
 */
async function assertCategoryAndTagIdsExist(
  tx: TenantTx,
  categoryIds: readonly string[],
  tagIds: readonly string[],
): Promise<void> {
  const uniqueCategoryIds = [...new Set(categoryIds)];
  if (uniqueCategoryIds.length > 0) {
    const found = await repo.countExistingCategoryIds(tx, uniqueCategoryIds);
    if (found !== uniqueCategoryIds.length) throw toTRPCError(NOT_FOUND_ERROR);
  }

  const uniqueTagIds = [...new Set(tagIds)];
  if (uniqueTagIds.length > 0) {
    const found = await repo.countExistingTagIds(tx, uniqueTagIds);
    if (found !== uniqueTagIds.length) throw toTRPCError(NOT_FOUND_ERROR);
  }
}

export async function createProduct(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: CreateProductInput,
): Promise<AdminProduct> {
  return withTenantTx(db, ctx, async (tx) => {
    await assertCategoryAndTagIdsExist(tx, input.categoryIds, input.tagIds ?? []);

    const facets = buildProductFacets(toFacetInputFromCreate(input));
    const productId = await repo.insertProductRow(tx, {
      tenantId: ctx.tenantId,
      kind: input.kind,
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      brandId: input.brandId ?? null,
      seo: (input.seo ?? {}) as Prisma.InputJsonValue,
      facets: facets as Prisma.InputJsonValue,
    });

    switch (input.kind) {
      case "perfume":
        await repo.insertPerfumeDetails(tx, ctx.tenantId, productId, input.perfumeDetails);
        break;
      case "watch":
        await repo.insertWatchDetails(tx, ctx.tenantId, productId, input.watchDetails);
        break;
      case "accessory":
        await repo.insertAccessoryDetails(tx, ctx.tenantId, productId, input.accessoryDetails);
        break;
    }

    await repo.replaceProductCategories(
      tx,
      ctx.tenantId,
      productId,
      categoryAssignments(input.categoryIds, input.primaryCategoryId),
    );
    await repo.replaceProductTags(tx, ctx.tenantId, productId, input.tagIds ?? []);

    const row = await repo.findProductRow(tx, { id: productId });
    if (!row)
      throw new Error(`producto ${productId} no se pudo releer dentro de la misma transacción`);
    return toAdminProduct(row);
  });
}

/** Rechaza un detalle de vertical que no corresponde al `kind` real del producto — Zod no puede validarlo porque updateProductInput no conoce el kind existente (no viaja en el input). */
function assertDetailsMatchKind(kind: ProductKind, input: UpdateProductInput): void {
  const mismatched =
    (input.perfumeDetails !== undefined && kind !== "perfume") ||
    (input.watchDetails !== undefined && kind !== "watch") ||
    (input.accessoryDetails !== undefined && kind !== "accessory");

  if (mismatched) {
    throw toTRPCError(
      appError(
        "VALIDATION_WRONG_VERTICAL_DETAILS",
        400,
        `Este producto es ${kind}; no se le puede editar el detalle de otra vertical.`,
      ),
    );
  }
}

export async function updateProduct(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: UpdateProductInput,
): Promise<AdminProduct> {
  return withTenantTx(db, ctx, async (tx) => {
    const existing = await repo.findProductRow(tx, { id: input.id });
    if (!existing) throw toTRPCError(NOT_FOUND_ERROR);
    assertDetailsMatchKind(existing.kind as ProductKind, input);
    await assertCategoryAndTagIdsExist(tx, input.categoryIds ?? [], input.tagIds ?? []);

    if (input.perfumeDetails) await repo.updatePerfumeDetails(tx, input.id, input.perfumeDetails);
    if (input.watchDetails) await repo.updateWatchDetails(tx, input.id, input.watchDetails);
    if (input.accessoryDetails)
      await repo.updateAccessoryDetails(tx, input.id, input.accessoryDetails);

    if (input.categoryIds) {
      await repo.replaceProductCategories(
        tx,
        ctx.tenantId,
        input.id,
        categoryAssignments(input.categoryIds, input.primaryCategoryId),
      );
    }
    if (input.tagIds) await repo.replaceProductTags(tx, ctx.tenantId, input.id, input.tagIds);

    // Recomputa facets a partir del detalle YA actualizado arriba — releer es
    // más simple y más correcto que reimplementar en JS el merge parcial que
    // Postgres ya aplicó (ver mappers.ts, toProductFacetInput).
    const withUpdatedDetails = await repo.findProductRow(tx, { id: input.id });
    if (!withUpdatedDetails)
      throw new Error(`producto ${input.id} desapareció a mitad de la transacción`);

    await repo.updateProductRow(tx, input.id, {
      slug: input.slug,
      name: input.name,
      description: input.description,
      brandId: input.brandId,
      status: input.status,
      seo: input.seo as Prisma.InputJsonValue | undefined,
      facets: buildProductFacetsFromRow(withUpdatedDetails) as Prisma.InputJsonValue,
    });

    const row = await repo.findProductRow(tx, { id: input.id });
    if (!row) throw new Error(`producto ${input.id} desapareció a mitad de la transacción`);
    return toAdminProduct(row);
  });
}

// Reexporta la misma lógica de mappers.ts (toProductFacetInput no se exporta
// desde ahí porque es un detalle interno del mapper) — se reconstruye acá a
// partir del AdminProduct ya mapeado, que es más simple que duplicar el
// switch sobre la fila cruda de Prisma.
function buildProductFacetsFromRow(row: repo.ProductRow): Record<string, unknown> {
  const admin = toAdminProduct(row);
  switch (admin.kind) {
    case "perfume":
      return buildProductFacets({ kind: "perfume", ...admin.perfumeDetails });
    case "watch":
      return buildProductFacets({ kind: "watch", ...admin.watchDetails });
    case "accessory":
      return buildProductFacets({ kind: "accessory", ...admin.accessoryDetails });
  }
}

export async function archiveProduct(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: { readonly id: string },
): Promise<AdminProduct> {
  return withTenantTx(db, ctx, async (tx) => {
    const existing = await repo.findProductRow(tx, input);
    if (!existing) throw toTRPCError(NOT_FOUND_ERROR);
    await repo.updateProductRow(tx, input.id, { status: "archived" });
    const row = await repo.findProductRow(tx, input);
    if (!row) throw new Error(`producto ${input.id} desapareció a mitad de la transacción`);
    return toAdminProduct(row);
  });
}

// ---------------------------------------------------------------------
// Variante
// ---------------------------------------------------------------------
export async function listVariants(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: { readonly productId: string },
): Promise<AdminVariant[]> {
  return withTenantTx(db, ctx, async (tx) => {
    const rows = await repo.listVariantRows(tx, input.productId);
    return rows.map(toAdminVariant);
  });
}

export async function getVariantById(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: { readonly id: string },
): Promise<AdminVariant> {
  return withTenantTx(db, ctx, async (tx) => {
    const row = await repo.findVariantRow(tx, input.id);
    if (!row) throw toTRPCError(NOT_FOUND_ERROR);
    return toAdminVariant(row);
  });
}

const BULK_VARIANT_EXISTS_ERROR = appError(
  "CONFLICT_BULK_VARIANT_EXISTS",
  409,
  "El producto ya tiene una variante de granel: un producto es un solo líquido.",
);

// WP-E05c. Las variantes de un reloj heredan `is_serialized` de `requires_serial`
// del producto: no se marcan aparte. Un reloj sin serie no puede trabarse al
// recibirlo (la recepción de una variante serializada exige cargar los
// seriales), y uno con serie no puede entrar sin registrarla. La herencia es al
// crear: apagarlo después, con unidades ya registradas, es WP-C08d.
//
// El refine de `createVariantInput` sobre `isSerialized` solo ve lo que manda el
// cliente, no lo que se hereda; por eso el CHECK `NOT is_serialized OR uom =
// 'unit'` de la base se adelanta acá con un mensaje claro, en vez de llegar como
// un conflicto genérico.
function resolveIsSerialized(
  product: repo.ProductRow,
  input: CreateVariantInput,
): boolean | undefined {
  if (product.kind !== "watch") return input.isSerialized;
  const details = product.watch_details_watch_details_product_id_tenant_idToproducts;
  if (!details) throw new Error(`producto ${product.id} es kind=watch sin watch_details`);

  const inherited = details.requires_serial;
  if (input.isSerialized !== undefined && input.isSerialized !== inherited) {
    throw toTRPCError(
      appError(
        "VALIDATION_SERIALIZED_INHERITED",
        400,
        `Las variantes de un reloj toman el número de serie de requiresSerial del producto (acá: ${inherited ? "sí" : "no"}); no se marcan aparte.`,
      ),
    );
  }
  if (inherited && input.uom !== "unit") {
    throw toTRPCError(
      appError(
        "VALIDATION_SERIALIZED_REQUIRES_UNIT",
        400,
        "Un reloj con número de serie se mide en unidades enteras (uom = unit).",
      ),
    );
  }
  return inherited;
}

export async function createVariant(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: CreateVariantInput,
): Promise<AdminVariant> {
  return withTenantTx(db, ctx, async (tx) => {
    const product = await repo.findProductRow(tx, { id: input.productId });
    if (!product) throw toTRPCError(NOT_FOUND_ERROR);
    const isSerialized = resolveIsSerialized(product, input);

    // El índice único parcial de 0028 lo impone la base; esto adelanta el
    // mensaje, en vez de dejar que llegue como un error interno.
    if (input.variantType === "bulk" && (await repo.productHasBulkVariant(tx, input.productId))) {
      throw toTRPCError(BULK_VARIANT_EXISTS_ERROR);
    }

    const id = await repo.insertVariantRow(tx, {
      tenantId: ctx.tenantId,
      productId: input.productId,
      sku: input.sku,
      variantType: input.variantType,
      uom: input.uom,
      sizeMl: input.sizeMl,
      pricePyg: parsePygAmount(input.pricePyg),
      compareAtPyg: input.compareAtPyg != null ? parsePygAmount(input.compareAtPyg) : null,
      vatRate: input.vatRate,
      allocationPolicy: input.allocationPolicy,
      productionMode: input.productionMode,
      sourceVariantId: input.sourceVariantId ?? null,
      isSerialized,
      onlineVisible: input.onlineVisible,
      minStockAlert: input.minStockAlert ?? null,
      weightG: input.weightG ?? null,
      position: input.position,
    });

    const row = await repo.findVariantRow(tx, id);
    if (!row) throw new Error(`variante ${id} no se pudo releer dentro de la misma transacción`);
    return toAdminVariant(row);
  });
}

export async function updateVariant(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: UpdateVariantInput,
): Promise<AdminVariant> {
  return withTenantTx(db, ctx, async (tx) => {
    const existing = await repo.findVariantRow(tx, input.id);
    if (!existing) throw toTRPCError(NOT_FOUND_ERROR);

    await repo.updateVariantRow(tx, input.id, {
      sku: input.sku,
      pricePyg: input.pricePyg !== undefined ? parsePygAmount(input.pricePyg) : undefined,
      compareAtPyg:
        input.compareAtPyg === undefined
          ? undefined
          : input.compareAtPyg === null
            ? null
            : parsePygAmount(input.compareAtPyg),
      vatRate: input.vatRate,
      allocationPolicy: input.allocationPolicy,
      productionMode: input.productionMode,
      sourceVariantId: input.sourceVariantId,
      isSerialized: input.isSerialized,
      onlineVisible: input.onlineVisible,
      minStockAlert: input.minStockAlert,
      weightG: input.weightG,
      position: input.position,
    });

    const row = await repo.findVariantRow(tx, input.id);
    if (!row) throw new Error(`variante ${input.id} desapareció a mitad de la transacción`);
    return toAdminVariant(row);
  });
}

// ---------------------------------------------------------------------
// BOM — RF-CAT-07, solo sobre una variante decant (GLOSARIO.md "BOM",
// "fraccionamiento").
// ---------------------------------------------------------------------
const BOM_REQUIRES_DECANT_ERROR = appError(
  "CONFLICT_BOM_REQUIRES_DECANT_VARIANT",
  409,
  "El BOM solo se define sobre una variante fraccionada (decant).",
);

export async function listBomComponents(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: { readonly variantId: string },
): Promise<AdminBomComponent[]> {
  return withTenantTx(db, ctx, async (tx) => {
    const rows = await repo.listBomComponentRows(tx, input.variantId);
    return rows.map(toAdminBomComponent);
  });
}

export async function createBomComponent(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: CreateBomComponentInput,
): Promise<AdminBomComponent> {
  return withTenantTx(db, ctx, async (tx) => {
    const parent = await repo.findVariantRow(tx, input.parentVariantId);
    if (!parent) throw toTRPCError(NOT_FOUND_ERROR);
    if (parent.variant_type !== "decant") throw toTRPCError(BOM_REQUIRES_DECANT_ERROR);

    const component = await repo.findVariantRow(tx, input.componentVariantId);
    if (!component) throw toTRPCError(NOT_FOUND_ERROR);

    const id = await repo.insertBomComponentRow(tx, {
      tenantId: ctx.tenantId,
      parentVariantId: input.parentVariantId,
      componentVariantId: input.componentVariantId,
      qtyPerUnit: input.qtyPerUnit,
      uom: input.uom,
      isOptional: input.isOptional,
      notes: input.notes ?? null,
    });

    const row = await repo.findBomComponentRow(tx, id);
    if (!row)
      throw new Error(`bom_component ${id} no se pudo releer dentro de la misma transacción`);
    return toAdminBomComponent(row);
  });
}

export async function updateBomComponent(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: UpdateBomComponentInput,
): Promise<AdminBomComponent> {
  return withTenantTx(db, ctx, async (tx) => {
    const existing = await repo.findBomComponentRow(tx, input.id);
    if (!existing) throw toTRPCError(NOT_FOUND_ERROR);

    await repo.updateBomComponentRow(tx, input.id, {
      qtyPerUnit: input.qtyPerUnit,
      uom: input.uom,
      isOptional: input.isOptional,
      notes: input.notes,
    });

    const row = await repo.findBomComponentRow(tx, input.id);
    if (!row) throw new Error(`bom_component ${input.id} desapareció a mitad de la transacción`);
    return toAdminBomComponent(row);
  });
}

export async function removeBomComponent(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: { readonly id: string },
): Promise<void> {
  return withTenantTx(db, ctx, async (tx) => {
    const existing = await repo.findBomComponentRow(tx, input.id);
    if (!existing) throw toTRPCError(NOT_FOUND_ERROR);
    await repo.deleteBomComponentRow(tx, input.id);
  });
}

// ---------------------------------------------------------------------
// Categoría — RF-CAT-03. `path` es un materialized path: se computa una
// sola vez, al crear (docs/data-model.md §3.1) — parentId no se edita
// después (ver el comentario de updateCategoryInput en packages/contracts).
// ---------------------------------------------------------------------
export async function listCategories(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: PaginationInput,
) {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  const cursorId = requireCursorId(input.cursor);
  return withTenantTx(db, ctx, async (tx) => {
    const rows = await repo.listCategoryRows(tx, { cursorId, limit });
    return paginate(rows, limit, toAdminCategory);
  });
}

export async function createCategory(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: CreateCategoryInput,
): Promise<AdminCategory> {
  return withTenantTx(db, ctx, async (tx) => {
    let path = input.slug;
    if (input.parentId) {
      const parent = await repo.findCategoryRow(tx, input.parentId);
      if (!parent) throw toTRPCError(NOT_FOUND_ERROR);
      path = `${parent.path}/${input.slug}`;
    }

    const id = await repo.insertCategoryRow(tx, {
      tenantId: ctx.tenantId,
      parentId: input.parentId ?? null,
      slug: input.slug,
      name: input.name,
      path,
      position: input.position,
      isVisible: input.isVisible,
      seo: input.seo as Prisma.InputJsonValue | undefined,
    });

    const row = await repo.findCategoryRow(tx, id);
    if (!row) throw new Error(`categoría ${id} no se pudo releer dentro de la misma transacción`);
    return toAdminCategory(row);
  });
}

export async function updateCategory(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: UpdateCategoryInput,
): Promise<AdminCategory> {
  return withTenantTx(db, ctx, async (tx) => {
    const existing = await repo.findCategoryRow(tx, input.id);
    if (!existing) throw toTRPCError(NOT_FOUND_ERROR);

    await repo.updateCategoryRow(tx, input.id, {
      name: input.name,
      position: input.position,
      isVisible: input.isVisible,
      seo: input.seo as Prisma.InputJsonValue | undefined,
    });

    const row = await repo.findCategoryRow(tx, input.id);
    if (!row) throw new Error(`categoría ${input.id} desapareció a mitad de la transacción`);
    return toAdminCategory(row);
  });
}

// ---------------------------------------------------------------------
// Tag — RF-CAT-04.
// ---------------------------------------------------------------------
export async function listTags(db: PrismaClient, ctx: TenantTxContext, input: PaginationInput) {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  const cursorId = requireCursorId(input.cursor);
  return withTenantTx(db, ctx, async (tx) => {
    const rows = await repo.listTagRows(tx, { cursorId, limit });
    return paginate(rows, limit, toAdminTag);
  });
}

export async function createTag(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: CreateTagInput,
): Promise<AdminTag> {
  return withTenantTx(db, ctx, async (tx) => {
    const id = await repo.insertTagRow(tx, {
      tenantId: ctx.tenantId,
      slug: input.slug,
      name: input.name,
      kind: input.kind,
    });
    const row = await repo.findTagRow(tx, id);
    if (!row) throw new Error(`tag ${id} no se pudo releer dentro de la misma transacción`);
    return toAdminTag(row);
  });
}

export async function updateTag(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: UpdateTagInput,
): Promise<AdminTag> {
  return withTenantTx(db, ctx, async (tx) => {
    const existing = await repo.findTagRow(tx, input.id);
    if (!existing) throw toTRPCError(NOT_FOUND_ERROR);
    await repo.updateTagRow(tx, input.id, { name: input.name, kind: input.kind });
    const row = await repo.findTagRow(tx, input.id);
    if (!row) throw new Error(`tag ${input.id} desapareció a mitad de la transacción`);
    return toAdminTag(row);
  });
}
