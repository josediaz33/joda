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
  type ActivateProductInput,
  type CreateVariantInput,
  type ListProductsInput,
  type SetProductPublicationInput,
  type SetVariantVisibilityInput,
  type PaginationInput,
  type ProductKind,
  type UpdateBomComponentInput,
  type UpdateCategoryInput,
  type UpdateProductInput,
  type UpdateTagInput,
  type UpdateVariantInput,
} from "@joda/contracts";
import { buildProductFacets, type Clock, type ProductFacetInput } from "@joda/domain";
import type { PrismaClient, Prisma } from "@joda/db";
import { recordAuditEntry } from "../../db/audit.js";
import { decodeCursor, encodeCursor } from "../../db/cursor.js";
import { withTenantTx, type TenantTx, type TenantTxContext } from "../../db/withTenantTx.js";
import { appError, hasSqlState, toTRPCError } from "../../middleware/errorMapper.js";
import {
  toAdminBomComponent,
  toAdminCategory,
  toAdminProduct,
  toAdminTag,
  toAdminVariant,
} from "./mappers.js";
import * as inventoryRepo from "../inventory/repository.js";
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

/**
 * WP-C08b. `brandId` llega del cliente y se escribe en `products`: se lee
 * primero bajo RLS (docs/api-conventions.md §8.4). Una marca de otro tenant y
 * una que no existe dan el mismo 404, sin distinguir cuál fue. `null` (sin
 * marca) no se consulta.
 */
async function assertBrandExists(tx: TenantTx, brandId: string | null | undefined): Promise<void> {
  if (brandId == null) return;
  if (!(await repo.brandExists(tx, brandId))) throw toTRPCError(NOT_FOUND_ERROR);
}

/**
 * WP-C08b. Mismo criterio que `assertBrandExists`, para el origen (`sourceVariantId`) de una variante.
 * Solo comprueba que la variante sea del tenant: no que sea un granel, ni del mismo producto,
 * ni que no sea la propia variante. Esa regla de negocio está sin decidir (WP-C08m).
 */
async function assertSourceVariantExists(
  tx: TenantTx,
  sourceVariantId: string | null | undefined,
): Promise<void> {
  if (sourceVariantId == null) return;
  if (!(await repo.findVariantRow(tx, sourceVariantId))) throw toTRPCError(NOT_FOUND_ERROR);
}

export async function createProduct(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: CreateProductInput,
): Promise<AdminProduct> {
  return withTenantTx(db, ctx, async (tx) => {
    await assertCategoryAndTagIdsExist(tx, input.categoryIds, input.tagIds ?? []);
    await assertBrandExists(tx, input.brandId);

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

const requiresSerialUnitsRegisteredError = (registeredUnits: number) =>
  appError(
    "CONFLICT_REQUIRES_SERIAL_UNITS_REGISTERED",
    409,
    "Este reloj tiene unidades con número de serie registradas en sus variantes: requiresSerial no puede pasar a «no» mientras existan.",
    { registeredUnits },
  );

/**
 * WP-C08h, decisión de José (2026-10-11): cambiar `requires_serial` de un reloj
 * se propaga a sus variantes, que heredan `is_serialized` de él (RN-SER-02,
 * E05c). Decide qué variantes cambian y rechaza lo que no se puede propagar,
 * ANTES de escribir nada:
 *
 *  - a «sí»: una variante que no se mide en `unit` no puede serializarse (CHECK
 *    `NOT is_serialized OR uom = 'unit'`); se rechaza el cambio y se nombra el SKU.
 *  - a «no»: si alguna variante tiene unidades registradas se rechaza: apagarlo
 *    dejaría unidades de una variante que ya no las admite (RN-SER-02). Es la
 *    regla de WP-C08d aplicada a este camino.
 *
 * Bloquea la fila de `watch_details` primero (`FOR NO KEY UPDATE`) y compara con
 * el valor vigente: solo propaga si de verdad cambia, así que guardar el reloj
 * con el mismo `requiresSerial` no revalida nada ni se frena por una variante
 * anterior a E05c. Con el bloqueo tomado, las variantes que se crean o se
 * actualizan al mismo tiempo esperan (`readWatchRequiresSerialShared`) y las que
 * ya estaban leyendo terminan antes de que se listen acá.
 *
 * Devuelve `null` si no hay nada que propagar.
 */
async function planRequiresSerialPropagation(
  tx: TenantTx,
  productId: string,
  requiresSerial: boolean,
): Promise<{ readonly variantIds: string[]; readonly to: boolean } | null> {
  const current = await repo.lockWatchRequiresSerial(tx, productId);
  if (current === null || current === requiresSerial) return null;

  const stale = (await repo.listVariantRows(tx, productId)).filter(
    (variant) => variant.is_serialized !== requiresSerial,
  );
  if (stale.length === 0) return null;

  if (requiresSerial) {
    const notInUnits = stale.filter((variant) => variant.uom !== "unit");
    if (notInUnits.length > 0) {
      throw toTRPCError(
        appError(
          "CONFLICT_REQUIRES_SERIAL_VARIANT_NOT_UNIT",
          409,
          `requiresSerial no puede pasar a «sí»: solo una variante en unidades enteras (uom = unit) puede llevar número de serie, y estas se miden en ml: ${notInUnits.map((variant) => variant.sku).join(", ")}.`,
          { skus: notInUnits.map((variant) => variant.sku) },
        ),
      );
    }
  } else {
    // Primero los lotes, después el conteo: el alta de una unidad bloquea su lote antes de
    // leer el flag de la variante (ver `lockLotsAndAssertNoSerialUnits`, WP-C08d).
    await inventoryRepo.lockLotsOfVariants(
      tx,
      stale.map((variant) => variant.id),
    );
    const registeredUnits = await repo.countSerializedUnitsOfVariants(
      tx,
      stale.map((variant) => variant.id),
    );
    if (registeredUnits > 0) {
      throw toTRPCError(requiresSerialUnitsRegisteredError(registeredUnits));
    }
  }
  return { variantIds: stale.map((variant) => variant.id), to: requiresSerial };
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
    await assertBrandExists(tx, input.brandId);

    if (input.perfumeDetails) await repo.updatePerfumeDetails(tx, input.id, input.perfumeDetails);
    if (input.watchDetails) {
      // WP-C08h. Antes de escribir: los rechazos de la propagación no dejan el cambio a medias.
      const propagation =
        input.watchDetails.requiresSerial === undefined
          ? null
          : await planRequiresSerialPropagation(tx, input.id, input.watchDetails.requiresSerial);
      await repo.updateWatchDetails(tx, input.id, input.watchDetails);
      if (propagation) await repo.setVariantsSerialized(tx, propagation.variantIds, propagation.to);
    }
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

// ---------------------------------------------------------------------
// Activación — RN-CAT-04 (WP-C08e). `draft` → `active` con su propio procedimiento:
// `status` no viaja por `update`. Activar un producto que ya tiene `published_at` lo
// muestra en la tienda, así que además de `write` exige `publish`. WP-C08q (decisión de
// José): un `archived` también se reactiva por acá, con `write`, y vuelve a `active` SIN
// publicar (`published_at` en nulo), por eso no necesita `publish`: no queda nada que mostrar.
// ---------------------------------------------------------------------
const PRODUCT_RE_ARCHIVED_ERROR = appError(
  "CONFLICT_PRODUCT_ARCHIVED",
  409,
  "El producto se archivó de nuevo mientras se lo reactivaba: volvé a intentarlo.",
);

const ACTIVATE_PUBLISHED_FORBIDDEN_ERROR = appError(
  "FORBIDDEN_INSUFFICIENT_PERMISSION",
  403,
  "Este producto ya está publicado: activarlo lo muestra en la tienda y hace falta el permiso de publicar.",
);

/** WP-C08q, RN-CAT-04. `archived` → `active` sin publicar; deja la bitácora con el `published_at` que pisó. */
async function reactivate(
  tx: TenantTx,
  ctx: TenantTxContext,
  origin: AuditOrigin,
  id: string,
): Promise<boolean> {
  const previous = await repo.reactivateArchivedProductRow(tx, id);
  if (previous === null) return false;
  await recordAuditEntry(tx, {
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    audience: ctx.audience,
    action: "catalog.product.activate",
    entity: "products",
    entityId: id,
    before: {
      status: "archived",
      publishedAt: previous.previousPublishedAt?.toISOString() ?? null,
    },
    after: { status: "active", publishedAt: null },
    ...origin,
  });
  return true;
}

export async function activateProduct(
  db: PrismaClient,
  ctx: TenantTxContext,
  origin: AuditOrigin,
  access: { readonly canPublish: boolean },
  input: ActivateProductInput,
): Promise<AdminProduct> {
  return withTenantTx(db, ctx, async (tx) => {
    // Una sola decisión: se intenta la escritura condicional (draft → active, y sin
    // `published_at` si quien activa no puede publicar), y si el producto está archivado, la
    // reactivación (archived → active sin publicar). Si ninguna cambió nada, se lee el producto
    // y se explica por qué; así una carrera con otro pedido (que lo publique, lo archive o lo
    // active) termina igual que si hubiera ocurrido antes de este pedido.
    if (await repo.activateProductRow(tx, input.id, !access.canPublish)) {
      await recordAuditEntry(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        audience: ctx.audience,
        action: "catalog.product.activate",
        entity: "products",
        entityId: input.id,
        before: { status: "draft" },
        after: { status: "active" },
        ...origin,
      });
    } else if (await reactivate(tx, ctx, origin, input.id)) {
      // Reactivado: ya quedó auditado.
    } else {
      const current = await repo.findProductRow(tx, { id: input.id });
      if (!current) throw toTRPCError(NOT_FOUND_ERROR);
      // Otro pedido lo reactivó y un tercero lo archivó de nuevo entre las dos escrituras.
      if (current.status === "archived") throw toTRPCError(PRODUCT_RE_ARCHIVED_ERROR);
      // Sigue en borrador: la condición que falló es `published_at IS NULL`, o sea que
      // está publicado y quien activa no puede publicar.
      if (current.status === "draft") throw toTRPCError(ACTIVATE_PUBLISHED_FORBIDDEN_ERROR);
      // Ya activo: no hay nada que hacer.
      return toAdminProduct(current);
    }

    const row = await repo.findProductRow(tx, { id: input.id });
    if (!row) throw new Error(`producto ${input.id} desapareció a mitad de la transacción`);
    return toAdminProduct(row);
  });
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
// Publicación — RF-CAT-09, RN-CAT-03 (WP-C08g). Procedimientos propios, bajo
// catalog.product:publish: `update` y `archive` (que exigen `write`) no
// tocan `published_at` ni `online_visible`.
// ---------------------------------------------------------------------
export interface CatalogServiceDeps {
  readonly clock: Clock;
}

/** De dónde vino el pedido, para la bitácora (docs/security-spec.md §7). */
export interface AuditOrigin {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

const PRODUCT_WITHOUT_PRIMARY_CATEGORY_ERROR = appError(
  "CONFLICT_PRODUCT_WITHOUT_PRIMARY_CATEGORY",
  409,
  "El producto no tiene categoría primaria: sin ella no se puede armar su ruta en la tienda.",
);

const VARIANT_NOT_PUBLISHABLE_ERROR = appError(
  "CONFLICT_VARIANT_NOT_PUBLISHABLE",
  409,
  "Solo las variantes sellado, decant y unidad se pueden mostrar en la tienda.",
);

/**
 * Publica el producto: `published_at` = ahora. Es independiente del `status`: un
 * borrador publicado no se ve en la tienda hasta que esté activo (las vistas
 * públicas piden las dos cosas), y publicar no lo activa. Sin categoría primaria
 * se rechaza (caso borde 17: el breadcrumb no se puede resolver). Ya publicado,
 * no hace nada: conserva la fecha original y no deja otra entrada en la bitácora.
 */
export async function publishProduct(
  db: PrismaClient,
  deps: CatalogServiceDeps,
  ctx: TenantTxContext,
  origin: AuditOrigin,
  input: SetProductPublicationInput,
): Promise<AdminProduct> {
  return withTenantTx(db, ctx, async (tx) => {
    const existing = await repo.findProductRow(tx, { id: input.id });
    if (!existing) throw toTRPCError(NOT_FOUND_ERROR);
    if (existing.published_at !== null) return toAdminProduct(existing);
    if (!existing.product_categories.some((assignment) => assignment.is_primary)) {
      throw toTRPCError(PRODUCT_WITHOUT_PRIMARY_CATEGORY_ERROR);
    }

    const publishedAt = deps.clock.now();
    // Si otro pedido la publicó mientras tanto, no hay nada que escribir ni auditar.
    if (await repo.publishProductRow(tx, input.id, publishedAt)) {
      await recordAuditEntry(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        audience: ctx.audience,
        action: "catalog.product.publish",
        entity: "products",
        entityId: input.id,
        before: { publishedAt: null },
        after: { publishedAt: publishedAt.toISOString() },
        ...origin,
      });
    }

    const row = await repo.findProductRow(tx, { id: input.id });
    if (!row) throw new Error(`producto ${input.id} desapareció a mitad de la transacción`);
    return toAdminProduct(row);
  });
}

/** Despublica el producto: `published_at` vuelve a nulo. No toca `status` ni la visibilidad de sus variantes. Ya despublicado, no hace nada. */
export async function unpublishProduct(
  db: PrismaClient,
  ctx: TenantTxContext,
  origin: AuditOrigin,
  input: SetProductPublicationInput,
): Promise<AdminProduct> {
  return withTenantTx(db, ctx, async (tx) => {
    const existing = await repo.findProductRow(tx, { id: input.id });
    if (!existing) throw toTRPCError(NOT_FOUND_ERROR);
    if (existing.published_at === null) return toAdminProduct(existing);

    if (await repo.unpublishProductRow(tx, input.id)) {
      await recordAuditEntry(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        audience: ctx.audience,
        action: "catalog.product.unpublish",
        entity: "products",
        entityId: input.id,
        before: { publishedAt: existing.published_at.toISOString() },
        after: { publishedAt: null },
        ...origin,
      });
    }

    const row = await repo.findProductRow(tx, { id: input.id });
    if (!row) throw new Error(`producto ${input.id} desapareció a mitad de la transacción`);
    return toAdminProduct(row);
  });
}

/**
 * Muestra u oculta una variante en la tienda (`online_visible`). Qué tipos se
 * pueden mostrar lo decide la base (RN-CAT-02, `0038`): acá no se repite la
 * lista, solo se traduce su rechazo a un error en español. Mostrar una variante
 * no publica el producto, ni al revés.
 */
export async function setVariantVisibility(
  db: PrismaClient,
  ctx: TenantTxContext,
  origin: AuditOrigin,
  input: SetVariantVisibilityInput,
): Promise<AdminVariant> {
  return withTenantTx(db, ctx, async (tx) => {
    const existing = await repo.findVariantRow(tx, input.id);
    if (!existing) throw toTRPCError(NOT_FOUND_ERROR);
    if (existing.online_visible === input.onlineVisible) return toAdminVariant(existing);

    let changed: boolean;
    try {
      changed = await repo.setVariantOnlineVisible(tx, input.id, input.onlineVisible);
    } catch (error) {
      // Este UPDATE solo cambia `online_visible`, y hoy el único CHECK de `product_variants` que
      // lo involucra es el de RN-CAT-02: cualquier 23514 acá es ése. Si algún día hay otro,
      // hay que distinguirlos por el nombre de la restricción.
      if (hasSqlState(error, "23514")) throw toTRPCError(VARIANT_NOT_PUBLISHABLE_ERROR);
      throw error;
    }
    if (changed) {
      await recordAuditEntry(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        audience: ctx.audience,
        action: "catalog.variant.setVisibility",
        entity: "product_variants",
        entityId: input.id,
        before: { onlineVisible: existing.online_visible },
        after: { onlineVisible: input.onlineVisible },
        ...origin,
      });
    }

    const row = await repo.findVariantRow(tx, input.id);
    if (!row) throw new Error(`variante ${input.id} desapareció a mitad de la transacción`);
    return toAdminVariant(row);
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
// seriales), y uno con serie no puede entrar sin registrarla. WP-C08f: la misma
// regla rige al actualizar la variante, que no puede contradecir al producto.
// WP-C08h, decisión de José: lo inverso también. Cambiar `requires_serial` del
// producto se propaga a las variantes ya creadas (`planRequiresSerialPropagation`).
// Apagarlo en una variante suelta con unidades ya registradas lo rechaza
// `lockLotsAndAssertNoSerialUnits` (WP-C08d), y la propagación aplica la misma
// guarda con el mismo bloqueo previo de lotes.
//
// El valor del producto se lee con `FOR SHARE`: la propagación y esta lectura
// tienen que ordenarse entre sí, o una variante creada mientras el producto
// cambia nace con el valor viejo y nadie la corrige.
//
// El refine de `createVariantInput` sobre `isSerialized` solo ve lo que manda el
// cliente, no lo que se hereda; por eso el CHECK `NOT is_serialized OR uom =
// 'unit'` de la base se adelanta acá con un mensaje claro, en vez de llegar como
// un conflicto genérico. `updateVariantInput` no lleva `uom` (no se edita), así
// que al actualizar viene de la variante guardada. WP-C08i: vale para cualquier
// producto, no solo para un reloj: un `decant` o un `bulk` se miden en ml y no se
// serializan, y sin este chequeo `isSerialized: true` sobre ellos llegaba a la base
// y salía como un error interno (500).
function serializedRequiresUnitError(message: string) {
  return toTRPCError(appError("VALIDATION_SERIALIZED_REQUIRES_UNIT", 400, message));
}

async function resolveIsSerialized(
  tx: TenantTx,
  product: repo.ProductRow,
  input: { readonly isSerialized?: boolean; readonly uom: CreateVariantInput["uom"] },
): Promise<boolean | undefined> {
  if (product.kind !== "watch") {
    if (input.isSerialized === true && input.uom !== "unit") {
      throw serializedRequiresUnitError(
        "Una variante con número de serie se mide en unidades enteras (uom = unit).",
      );
    }
    return input.isSerialized;
  }
  const inherited = await repo.readWatchRequiresSerialShared(tx, product.id);
  if (inherited === null) throw new Error(`producto ${product.id} es kind=watch sin watch_details`);
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
    throw serializedRequiresUnitError(
      "Un reloj con número de serie se mide en unidades enteras (uom = unit).",
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
    const isSerialized = await resolveIsSerialized(tx, product, input);
    await assertSourceVariantExists(tx, input.sourceVariantId);

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
      minStockAlert: input.minStockAlert ?? null,
      weightG: input.weightG ?? null,
      position: input.position,
    });

    const row = await repo.findVariantRow(tx, id);
    if (!row) throw new Error(`variante ${id} no se pudo releer dentro de la misma transacción`);
    return toAdminVariant(row);
  });
}

/**
 * WP-C08d, RN-SER-02. Una variante con unidades registradas no deja de ser
 * serializada: quedarían unidades con número de serie colgando de una variante
 * que ya no las admite, y la recepción y la venta dejarían de tratarlas como tales.
 * Cuentan las unidades de todos los estados (RN-SER-03).
 *
 * Primero se bloquean los lotes de la variante y después se cuenta: el alta de una
 * unidad bloquea su lote antes de leer el flag de la variante, así que, sobre un lote
 * que ya existe, o la unidad ya está confirmada cuando se cuenta, o el alta espera y
 * encuentra la variante apagada y se rechaza. Sin el bloqueo, un alta en vuelo pasa
 * inadvertida.
 *
 * **Toma bloqueos, no solo cuenta.** Y tiene límites: el bloqueo corre con la
 * visibilidad de quien apaga (sin permisos de inventario sobre los lotes no bloquea
 * nada) y no ve un lote que nace después con sus unidades. El invariante completo
 * vive en la base: WP-B20.
 */
async function lockLotsAndAssertNoSerialUnits(tx: TenantTx, variantId: string): Promise<void> {
  await inventoryRepo.lockLotsOfVariant(tx, variantId);
  const registered = await inventoryRepo.countSerializedUnitsOfVariant(tx, variantId);
  if (registered > 0) {
    throw toTRPCError(
      appError(
        "CONFLICT_VARIANT_HAS_SERIAL_UNITS",
        409,
        "Esta variante ya tiene unidades con número de serie registradas: no se puede dejar de serializar.",
        { registered },
      ),
    );
  }
}

export async function updateVariant(
  db: PrismaClient,
  ctx: TenantTxContext,
  input: UpdateVariantInput,
): Promise<AdminVariant> {
  return withTenantTx(db, ctx, async (tx) => {
    const existing = await repo.findVariantRow(tx, input.id);
    if (!existing) throw toTRPCError(NOT_FOUND_ERROR);
    await assertSourceVariantExists(tx, input.sourceVariantId);

    // WP-C08f. Solo si el pedido toca `isSerialized`: el producto no se lee de más.
    let isSerialized: boolean | undefined;
    if (input.isSerialized !== undefined) {
      const product = await repo.findProductRow(tx, { id: existing.product_id });
      if (!product) throw new Error(`variante ${existing.id} sin producto ${existing.product_id}`);
      isSerialized = await resolveIsSerialized(tx, product, {
        isSerialized: input.isSerialized,
        uom: existing.uom,
      });
    }
    // Solo al apagar: encender no tiene este problema (el CHECK de la base ya exige `unit`).
    if (isSerialized === false && existing.is_serialized) {
      await lockLotsAndAssertNoSerialUnits(tx, existing.id);
    }

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
      isSerialized,
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
// Categoría — RF-CAT-03. `path` es un materialized path (docs/data-model.md
// §3.1): se computa al crear y se recompone, junto con el de todo el subárbol,
// al mover la categoría (WP-E05b, `updateCategory`). Crear bajo un padre y
// mover leen el árbol antes de escribirlo, así que ambos empiezan por
// `lockCategoryTree`.
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
    // Antes de leer el padre: si otro movimiento le está cambiando el `path`
    // (a él o a un ancestro), esperar a que termine y leerlo ya nuevo.
    if (input.parentId) await repo.lockCategoryTree(tx);
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

const CATEGORY_CYCLE_ERROR = appError(
  "VALIDATION_CATEGORY_CYCLE",
  400,
  "Una categoría no puede quedar dentro de sí misma ni de una de sus subcategorías.",
);

/**
 * WP-E05b. El destino se lee bajo RLS antes del UPDATE (una FK al padre no
 * protege nada: docs/api-conventions.md §8.4), y no puede ser la propia
 * categoría ni un descendiente suyo. El árbol queda bloqueado por quien llama
 * (`lockCategoryTree`) antes de leer `category`.
 */
async function moveCategory(
  tx: TenantTx,
  category: repo.CategoryRow,
  parentId: string | null,
): Promise<void> {
  let path = category.slug;
  if (parentId !== null) {
    const parent = await repo.findCategoryRow(tx, parentId);
    if (!parent) throw toTRPCError(NOT_FOUND_ERROR);
    if (await repo.isCategoryInSubtree(tx, category.id, parent.id)) {
      throw toTRPCError(CATEGORY_CYCLE_ERROR);
    }
    path = `${parent.path}/${category.slug}`;
  }
  await repo.moveCategorySubtree(tx, category.id, parentId, path);
}

const CATEGORY_VISIBILITY_FORBIDDEN_ERROR = appError(
  "FORBIDDEN_INSUFFICIENT_PERMISSION",
  403,
  "Mostrar u ocultar una categoría cambia lo que ve la tienda y hace falta el permiso de publicar.",
);

/**
 * WP-C08k, RN-CAT-05. Mostrar u ocultar una categoría (cambiar `isVisible`) es publicar:
 * exige `catalog.product:publish`, además del `write` que declara el procedimiento.
 * Renombrar, mover y reordenar siguen siendo de `write`. Mandar `isVisible` con el valor
 * que la categoría ya tiene no cambia nada y no pide `publish`.
 *
 * Quien no puede publicar nunca escribe `is_visible`: si lo mandó igual, se descarta del
 * UPDATE en vez de reescribirlo, así una visibilidad que otro pedido cambió entre la lectura
 * y la escritura no la pisa alguien sin permiso. El rechazo ocurre antes de mover o escribir
 * nada, de modo que un pedido que mezcla un cambio permitido con otro que no lo es no cambia
 * ninguno.
 */
export async function updateCategory(
  db: PrismaClient,
  ctx: TenantTxContext,
  access: { readonly canPublish: boolean },
  input: UpdateCategoryInput,
): Promise<AdminCategory> {
  return withTenantTx(db, ctx, async (tx) => {
    // Antes de leer: lo que se lee para decidir el movimiento no puede
    // cambiarle debajo a otro movimiento concurrente.
    if (input.parentId !== undefined) await repo.lockCategoryTree(tx);

    const existing = await repo.findCategoryRow(tx, input.id);
    if (!existing) throw toTRPCError(NOT_FOUND_ERROR);

    const changesVisibility =
      input.isVisible !== undefined && input.isVisible !== existing.is_visible;
    if (changesVisibility && !access.canPublish) {
      throw toTRPCError(CATEGORY_VISIBILITY_FORBIDDEN_ERROR);
    }

    if (input.parentId !== undefined && input.parentId !== existing.parent_id) {
      await moveCategory(tx, existing, input.parentId);
    }

    await repo.updateCategoryRow(tx, input.id, {
      name: input.name,
      position: input.position,
      isVisible: access.canPublish ? input.isVisible : undefined,
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
