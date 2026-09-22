import { describe, expect, it } from "vitest";
import { buildProductFacets } from "./facets.js";

describe("buildProductFacets — proyección de descubrimiento (docs/data-model.md §8)", () => {
  it("perfume: proyecta solo lo descriptivo, nunca la merma", () => {
    expect(
      buildProductFacets({
        kind: "perfume",
        concentration: "edp",
        nominalVolumeMl: 100,
        olfactoryFamily: "amaderado",
        notesTop: ["bergamota"],
        notesHeart: ["jazmín"],
        notesBase: ["sándalo"],
        isDecantable: true,
      }),
    ).toEqual({
      concentration: "edp",
      nominalVolumeMl: 100,
      olfactoryFamily: "amaderado",
      notesTop: ["bergamota"],
      notesHeart: ["jazmín"],
      notesBase: ["sándalo"],
      isDecantable: true,
    });
  });

  it("perfume: el objeto resultante no tiene ninguna clave de merma (wasteFactor, unusableResidueMl, evaporationMlYear)", () => {
    const facets = buildProductFacets({
      kind: "perfume",
      concentration: "edt",
      nominalVolumeMl: 50,
      olfactoryFamily: "cítrico",
      notesTop: [],
      notesHeart: [],
      notesBase: [],
      isDecantable: false,
    });

    expect(Object.keys(facets)).not.toContain("wasteFactor");
    expect(Object.keys(facets)).not.toContain("unusableResidueMl");
    expect(Object.keys(facets)).not.toContain("evaporationMlYear");
  });

  it("watch: proyecta lo descriptivo, sin requiresSerial (operativo, no descriptivo)", () => {
    const facets = buildProductFacets({
      kind: "watch",
      movement: "automatic",
      caseMaterial: "acero",
      caseDiameterMm: 40,
      waterResistanceM: 100,
      strapMaterial: "cuero",
      crystal: "zafiro",
      warrantyMonths: 24,
    });

    expect(facets).toEqual({
      movement: "automatic",
      caseMaterial: "acero",
      caseDiameterMm: 40,
      waterResistanceM: 100,
      strapMaterial: "cuero",
      crystal: "zafiro",
      warrantyMonths: 24,
    });
    expect(Object.keys(facets)).not.toContain("requiresSerial");
  });

  it("watch: los campos nullable se proyectan como null, no se omiten", () => {
    const facets = buildProductFacets({
      kind: "watch",
      movement: "quartz",
      caseMaterial: "titanio",
      caseDiameterMm: null,
      waterResistanceM: null,
      strapMaterial: null,
      crystal: null,
      warrantyMonths: 12,
    });

    expect(facets).toEqual({
      movement: "quartz",
      caseMaterial: "titanio",
      caseDiameterMm: null,
      waterResistanceM: null,
      strapMaterial: null,
      crystal: null,
      warrantyMonths: 12,
    });
  });

  it("accessory: proyecta los tres campos descriptivos tal cual (accessory_details no tiene nada operativo)", () => {
    expect(
      buildProductFacets({ kind: "accessory", material: "cuero", color: "negro", sizeLabel: "M" }),
    ).toEqual({ material: "cuero", color: "negro", sizeLabel: "M" });
  });
});
