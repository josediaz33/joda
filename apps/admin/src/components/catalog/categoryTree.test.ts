import type { AdminCategory } from "@joda/contracts";
import { describe, expect, it } from "vitest";
import {
  buildCategoryRows,
  moveTargets,
  nextPosition,
  reorderUpdates,
  subtreeIds,
} from "./categoryTree";

// RF-CAT-03 (docs/especificacion-software.md §2.1): árbol de categorías con
// jerarquía padre-hijo, orden y visibilidad. WP-E05b.

function category(overrides: Partial<AdminCategory> & Pick<AdminCategory, "id">): AdminCategory {
  return {
    parentId: null,
    slug: overrides.id,
    name: overrides.id,
    path: overrides.id,
    position: 0,
    isVisible: true,
    seo: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const perfumeria = category({ id: "perfumeria", name: "Perfumería", position: 0 });
const nicho = category({ id: "nicho", name: "Nicho", parentId: "perfumeria", position: 1 });
const arabes = category({ id: "arabes", name: "Árabes", parentId: "perfumeria", position: 0 });
const relojes = category({ id: "relojes", name: "Relojes", position: 1 });

describe("RF-CAT-03 · buildCategoryRows ordena el árbol en profundidad", () => {
  it("muestra cada categoría seguida de sus hijas, y los hermanos por posición", () => {
    const rows = buildCategoryRows([relojes, nicho, arabes, perfumeria]);

    expect(rows.map((row) => row.category.id)).toEqual([
      "perfumeria",
      "arabes",
      "nicho",
      "relojes",
    ]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 1, 0]);
  });

  it("desempata las posiciones iguales por nombre", () => {
    const zeta = category({ id: "zeta", name: "Zeta" });
    const alfa = category({ id: "alfa", name: "Alfa" });

    const rows = buildCategoryRows([zeta, alfa]);

    expect(rows.map((row) => row.category.id)).toEqual(["alfa", "zeta"]);
  });

  it("cada fila trae a sus hermanas y su lugar entre ellas", () => {
    const rows = buildCategoryRows([perfumeria, nicho, arabes]);

    const nichoRow = rows.find((row) => row.category.id === "nicho");
    expect(nichoRow?.index).toBe(1);
    expect(nichoRow?.siblings.map((sibling) => sibling.id)).toEqual(["arabes", "nicho"]);
  });

  it("una categoría cuyo padre no está en la lista se muestra como raíz", () => {
    const huerfana = category({ id: "huerfana", parentId: "no-esta" });

    const rows = buildCategoryRows([huerfana]);

    expect(rows.map((row) => [row.category.id, row.depth])).toEqual([["huerfana", 0]]);
  });
});

describe("RF-CAT-03 · subtreeIds y moveTargets excluyen lo que no puede ser destino", () => {
  const nieta = category({ id: "nieta", parentId: "nicho" });
  const todas = [perfumeria, nicho, arabes, relojes, nieta];

  it("subtreeIds devuelve la categoría y todos sus descendientes, no a sus hermanas", () => {
    expect([...subtreeIds(todas, "nicho")].sort()).toEqual(["nicho", "nieta"]);
    expect([...subtreeIds(todas, "perfumeria")].sort()).toEqual([
      "arabes",
      "nicho",
      "nieta",
      "perfumeria",
    ]);
  });

  it("moveTargets deja fuera a la categoría y a su subárbol, y conserva el padre actual", () => {
    expect(moveTargets(todas, "nicho").map((target) => target.id)).toEqual([
      "perfumeria",
      "arabes",
      "relojes",
    ]);
  });
});

describe("RF-CAT-03 · reorderUpdates cambia solo las posiciones necesarias", () => {
  const a = category({ id: "a", position: 0 });
  const b = category({ id: "b", position: 1 });
  const c = category({ id: "c", position: 2 });

  it("intercambia dos hermanas contiguas", () => {
    expect(reorderUpdates([a, b, c], 1, -1)).toEqual([
      { id: "b", position: 0 },
      { id: "a", position: 1 },
    ]);
  });

  it("renumera cuando las hermanas comparten posición, porque un intercambio no cambiaría nada", () => {
    const x = category({ id: "x", position: 0 });
    const y = category({ id: "y", position: 0 });
    const z = category({ id: "z", position: 0 });

    expect(reorderUpdates([x, y, z], 2, -1)).toEqual([
      { id: "z", position: 1 },
      { id: "y", position: 2 },
    ]);
  });

  it("no hace nada en los extremos", () => {
    expect(reorderUpdates([a, b, c], 0, -1)).toEqual([]);
    expect(reorderUpdates([a, b, c], 2, 1)).toEqual([]);
  });
});

describe("RF-CAT-03 · nextPosition manda la categoría nueva al final", () => {
  it("es 0 sin hermanas", () => {
    expect(nextPosition([])).toBe(0);
  });

  it("es una más que la mayor posición, aunque haya huecos", () => {
    const first = category({ id: "first", position: 0 });
    const last = category({ id: "last", position: 4 });

    expect(nextPosition([first, last])).toBe(5);
  });
});
