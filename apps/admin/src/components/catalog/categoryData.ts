import type { AdminCategory } from "@joda/contracts";
import { api } from "../../api";

/** Clave de React Query compartida: el formulario de producto y la pantalla de categorías leen y refrescan lo mismo. */
export const CATEGORIES_QUERY_KEY = ["catalog-categories"] as const;

/** Todas las categorías del tenant: sigue el cursor hasta agotar las páginas. */
export async function loadCategories(): Promise<AdminCategory[]> {
  const categories: AdminCategory[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listCategories(cursor);
    categories.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return categories;
}
