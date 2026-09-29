import type {
  AdminBomComponent,
  AdminCategory,
  AdminProduct,
  AdminTag,
  AdminVariant,
  ProductKind,
} from "@joda/contracts";
import { buildProductFacets, type ProductFacetInput } from "@joda/domain";
import type { BomComponentRow, CategoryRow, ProductRow, TagRow, VariantRow } from "./repository.js";

// Fila de base → DTO (docs/api-conventions.md §1, árbol de `modules/<dominio>/`
// — `mappers.ts` es "fila de base ↔ tipo de dominio"). Nada de reglas de
// negocio acá — solo conversión de tipo: Decimal → number, BigInt → string
// (pygAmountSchema), Date → ISO string.
function toDecimalNumber(value: { toNumber(): number } | null): number | null {
  return value === null ? null : value.toNumber();
}

export function toAdminVariant(row: VariantRow): AdminVariant {
  return {
    id: row.id,
    productId: row.product_id,
    sku: row.sku,
    variantType: row.variant_type,
    uom: row.uom,
    sizeMl: toDecimalNumber(row.size_ml),
    pricePyg: row.price_pyg.toString(),
    compareAtPyg: row.compare_at_pyg?.toString() ?? null,
    vatRate: row.vat_rate,
    allocationPolicy: row.allocation_policy,
    productionMode: row.production_mode,
    sourceVariantId: row.source_variant_id,
    isSerialized: row.is_serialized,
    onlineVisible: row.online_visible,
    minStockAlert: toDecimalNumber(row.min_stock_alert),
    weightG: toDecimalNumber(row.weight_g),
    position: row.position,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toAdminBomComponent(row: BomComponentRow): AdminBomComponent {
  return {
    id: row.id,
    parentVariantId: row.parent_variant_id,
    componentVariantId: row.component_variant_id,
    qtyPerUnit: row.qty_per_unit.toNumber(),
    uom: row.uom,
    isOptional: row.is_optional,
    notes: row.notes,
  };
}

export function toAdminCategory(row: CategoryRow): AdminCategory {
  return {
    id: row.id,
    parentId: row.parent_id,
    slug: row.slug,
    name: row.name,
    path: row.path,
    position: row.position,
    isVisible: row.is_visible,
    seo: row.seo as Record<string, unknown>,
    createdAt: row.created_at.toISOString(),
  };
}

export function toAdminTag(row: TagRow): AdminTag {
  return { id: row.id, slug: row.slug, name: row.name, kind: row.kind as AdminTag["kind"] };
}

/** `kind` decide qué unión de adminProductSchema/ProductFacetInput arma — un producto SIEMPRE tiene exactamente uno de los tres detalles poblado (la FK compuesta de ADR-005 no permite otra cosa). */
function toProductFacetInput(row: ProductRow): ProductFacetInput {
  switch (row.kind) {
    case "perfume": {
      const details = row.perfume_details_perfume_details_product_id_tenant_idToproducts;
      if (!details) throw new Error(`producto ${row.id} es kind=perfume sin perfume_details`);
      return {
        kind: "perfume",
        concentration: details.concentration,
        nominalVolumeMl: details.nominal_volume_ml.toNumber(),
        olfactoryFamily: details.olfactory_family,
        notesTop: details.notes_top,
        notesHeart: details.notes_heart,
        notesBase: details.notes_base,
        isDecantable: details.is_decantable,
      };
    }
    case "watch": {
      const details = row.watch_details_watch_details_product_id_tenant_idToproducts;
      if (!details) throw new Error(`producto ${row.id} es kind=watch sin watch_details`);
      return {
        kind: "watch",
        movement: details.movement,
        caseMaterial: details.case_material,
        caseDiameterMm: toDecimalNumber(details.case_diameter_mm),
        waterResistanceM: details.water_resistance_m,
        strapMaterial: details.strap_material,
        crystal: details.crystal,
        warrantyMonths: details.warranty_months,
      };
    }
    case "accessory": {
      const details = row.accessory_details_accessory_details_product_id_tenant_idToproducts;
      if (!details) throw new Error(`producto ${row.id} es kind=accessory sin accessory_details`);
      return {
        kind: "accessory",
        material: details.material,
        color: details.color,
        sizeLabel: details.size_label,
      };
    }
  }
}

export function toAdminProduct(row: ProductRow): AdminProduct {
  const kind = row.kind as ProductKind;
  const primaryCategory = row.product_categories.find((assignment) => assignment.is_primary);
  const base = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    brandId: row.brand_id,
    brandName: row.brands?.name ?? null,
    primaryCategoryId: primaryCategory?.category_id ?? null,
    categoryIds: row.product_categories.map((assignment) => assignment.category_id),
    tagIds: row.product_tags.map((assignment) => assignment.tag_id),
    seo: row.seo as Record<string, unknown>,
    facets: buildProductFacets(toProductFacetInput(row)),
    variants: row.product_variants.map(toAdminVariant),
    publishedAt: row.published_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };

  switch (kind) {
    case "perfume": {
      const details = row.perfume_details_perfume_details_product_id_tenant_idToproducts;
      if (!details) throw new Error(`producto ${row.id} es kind=perfume sin perfume_details`);
      return {
        ...base,
        kind: "perfume",
        perfumeDetails: {
          concentration: details.concentration,
          nominalVolumeMl: details.nominal_volume_ml.toNumber(),
          olfactoryFamily: details.olfactory_family,
          notesTop: details.notes_top,
          notesHeart: details.notes_heart,
          notesBase: details.notes_base,
          isDecantable: details.is_decantable,
          wasteFactor: details.waste_factor.toNumber(),
          unusableResidueMl: details.unusable_residue_ml.toNumber(),
          evaporationMlYear: details.evaporation_ml_year.toNumber(),
        },
      };
    }
    case "watch": {
      const details = row.watch_details_watch_details_product_id_tenant_idToproducts;
      if (!details) throw new Error(`producto ${row.id} es kind=watch sin watch_details`);
      return {
        ...base,
        kind: "watch",
        watchDetails: {
          movement: details.movement,
          caseMaterial: details.case_material,
          caseDiameterMm: toDecimalNumber(details.case_diameter_mm),
          waterResistanceM: details.water_resistance_m,
          strapMaterial: details.strap_material,
          crystal: details.crystal,
          warrantyMonths: details.warranty_months,
          requiresSerial: details.requires_serial,
        },
      };
    }
    case "accessory": {
      const details = row.accessory_details_accessory_details_product_id_tenant_idToproducts;
      if (!details) throw new Error(`producto ${row.id} es kind=accessory sin accessory_details`);
      return {
        ...base,
        kind: "accessory",
        accessoryDetails: {
          material: details.material,
          color: details.color,
          sizeLabel: details.size_label,
        },
      };
    }
  }
}
