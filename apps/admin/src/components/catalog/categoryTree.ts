import type { AdminCategory } from "@joda/contracts";

// Árbol de categorías para el admin (WP-E05b, RF-CAT-03). La API devuelve una
// lista plana ordenada por fecha de alta; el orden entre hermanos es `position`
// y el árbol lo arma el cliente a partir de `parentId`. Todo lo de acá es puro.

export interface CategoryTreeRow {
  readonly category: AdminCategory;
  readonly depth: number;
  /** Los hermanos de esta categoría (ella incluida), en el orden en que se muestran. */
  readonly siblings: readonly AdminCategory[];
  /** Posición de esta categoría dentro de `siblings`. */
  readonly index: number;
}

export interface PositionUpdate {
  readonly id: string;
  readonly position: number;
}

function compareSiblings(a: AdminCategory, b: AdminCategory): number {
  if (a.position !== b.position) return a.position - b.position;
  const byName = a.name.localeCompare(b.name, "es");
  if (byName !== 0) return byName;
  return a.id < b.id ? -1 : 1;
}

/**
 * La lista plana del árbol, en profundidad: cada categoría seguida de sus
 * descendientes, y los hermanos por `position` (empates por nombre). Una
 * categoría cuyo padre no está en la lista se muestra como raíz en vez de
 * desaparecer.
 */
export function buildCategoryRows(categories: readonly AdminCategory[]): CategoryTreeRow[] {
  const known = new Set(categories.map((category) => category.id));
  const childrenByParent = new Map<string | null, AdminCategory[]>();
  for (const category of categories) {
    const parentKey =
      category.parentId !== null && known.has(category.parentId) ? category.parentId : null;
    const siblings = childrenByParent.get(parentKey) ?? [];
    siblings.push(category);
    childrenByParent.set(parentKey, siblings);
  }
  for (const siblings of childrenByParent.values()) siblings.sort(compareSiblings);

  const rows: CategoryTreeRow[] = [];
  const visit = (parentId: string | null, depth: number): void => {
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.forEach((category, index) => {
      rows.push({ category, depth, siblings, index });
      visit(category.id, depth + 1);
    });
  };
  visit(null, 0);
  return rows;
}

/** El id de la categoría y los de todo su subárbol: ninguno es un destino válido para moverla. */
export function subtreeIds(categories: readonly AdminCategory[], rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const category of categories) {
      if (category.parentId !== null && ids.has(category.parentId) && !ids.has(category.id)) {
        ids.add(category.id);
        grew = true;
      }
    }
  }
  return ids;
}

/**
 * Las categorías a las que se puede mover `categoryId`, en el orden del árbol:
 * todas menos ella y su subárbol (la API también lo rechaza).
 */
export function moveTargets(
  categories: readonly AdminCategory[],
  categoryId: string,
): AdminCategory[] {
  const excluded = subtreeIds(categories, categoryId);
  return buildCategoryRows(categories)
    .map((row) => row.category)
    .filter((category) => !excluded.has(category.id));
}

/**
 * Subir o bajar una categoría un lugar entre sus hermanos. Devuelve solo los
 * cambios de `position` que hacen falta para que el orden nuevo sea 0, 1, 2…:
 * hermanos con la misma posición (el alta deja 0 por defecto) no se pueden
 * intercambiar sin renumerarlos. Vacío si ya está en el extremo.
 */
export function reorderUpdates(
  siblings: readonly AdminCategory[],
  index: number,
  direction: -1 | 1,
): PositionUpdate[] {
  const target = index + direction;
  if (index < 0 || index >= siblings.length || target < 0 || target >= siblings.length) return [];

  const reordered = [...siblings];
  const moving = reordered[index]!;
  reordered[index] = reordered[target]!;
  reordered[target] = moving;

  return reordered.flatMap((category, position) =>
    category.position === position ? [] : [{ id: category.id, position }],
  );
}

/** La posición para una categoría nueva entre `siblings`: al final. */
export function nextPosition(siblings: readonly AdminCategory[]): number {
  return siblings.reduce((last, category) => Math.max(last, category.position + 1), 0);
}
