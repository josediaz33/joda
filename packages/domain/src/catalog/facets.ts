// Mapper de facetas (WP-C08, docs/data-model.md §8 "Cómo agregar una
// vertical de producto": "mapper de facetas en
// packages/domain/src/catalog/facets.ts"). Proyecta SOLO lo descriptivo de
// cada vertical (ADR-005: "lo puramente descriptivo va a products.facets")
// hacia la columna `products.facets jsonb` — nunca lo operativo (merma,
// requiresSerial): eso vive solo en el detalle administrativo
// (packages/contracts/src/catalog.ts, adminPerfumeDetailsSchema y
// similares), nunca en la proyección de descubrimiento que este archivo
// arma. Función total y pura: no hay entrada inválida que represente un
// caso de negocio (packages/contracts ya validó la forma antes de llegar
// acá), así que no hay Result que devolver — ver .claude/rules/domain.md
// "Errores".

export interface PerfumeFacetInput {
  readonly kind: "perfume";
  readonly concentration: string;
  readonly nominalVolumeMl: number;
  readonly olfactoryFamily: string;
  readonly notesTop: readonly string[];
  readonly notesHeart: readonly string[];
  readonly notesBase: readonly string[];
  readonly isDecantable: boolean;
}

export interface WatchFacetInput {
  readonly kind: "watch";
  readonly movement: string;
  readonly caseMaterial: string;
  readonly caseDiameterMm: number | null;
  readonly waterResistanceM: number | null;
  readonly strapMaterial: string | null;
  readonly crystal: string | null;
  readonly warrantyMonths: number;
}

export interface AccessoryFacetInput {
  readonly kind: "accessory";
  readonly material: string | null;
  readonly color: string | null;
  readonly sizeLabel: string | null;
}

export type ProductFacetInput = PerfumeFacetInput | WatchFacetInput | AccessoryFacetInput;

/** El resultado es jsonb sin forma fija del lado de la base — Record<string, unknown> es la representación más honesta del lado del dominio. */
export type ProductFacets = Record<string, unknown>;

export function buildProductFacets(input: ProductFacetInput): ProductFacets {
  switch (input.kind) {
    case "perfume":
      return {
        concentration: input.concentration,
        nominalVolumeMl: input.nominalVolumeMl,
        olfactoryFamily: input.olfactoryFamily,
        notesTop: input.notesTop,
        notesHeart: input.notesHeart,
        notesBase: input.notesBase,
        isDecantable: input.isDecantable,
      };
    case "watch":
      return {
        movement: input.movement,
        caseMaterial: input.caseMaterial,
        caseDiameterMm: input.caseDiameterMm,
        waterResistanceM: input.waterResistanceM,
        strapMaterial: input.strapMaterial,
        crystal: input.crystal,
        warrantyMonths: input.warrantyMonths,
      };
    case "accessory":
      return {
        material: input.material,
        color: input.color,
        sizeLabel: input.sizeLabel,
      };
  }
}
