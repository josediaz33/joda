import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminCategory, UpdateCategoryInput } from "@joda/contracts";
import { Button } from "@joda/ui/primitives/button";
import { api } from "../api";
import { Can } from "../Can";
import { CATEGORIES_QUERY_KEY, loadCategories } from "../components/catalog/categoryData";
import {
  CreateCategoryDialog,
  MoveCategoryDialog,
  RenameCategoryDialog,
} from "../components/catalog/CategoryDialogs";
import { buildCategoryRows, reorderUpdates } from "../components/catalog/categoryTree";

type OpenDialog =
  | { kind: "create"; parent: AdminCategory | null }
  | { kind: "rename"; category: AdminCategory }
  | { kind: "move"; category: AdminCategory };

// RF-CAT-03. El árbol de categorías comerciales (ADR-006): navegación,
// breadcrumbs y SEO. Escribir exige catalog.product:write; la API vuelve a
// resolver el permiso, acá `Can` solo decide qué se muestra.
export default function Categories() {
  const queryClient = useQueryClient();
  const categories = useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: loadCategories,
    retry: false,
  });
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const all = categories.data ?? [];
  const rows = buildCategoryRows(all);
  const rootSiblings = rows.find((row) => row.depth === 0)?.siblings ?? [];

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: CATEGORIES_QUERY_KEY });
  }

  async function run(updates: readonly UpdateCategoryInput[], failure: string) {
    setActionError("");
    setBusy(true);
    try {
      await Promise.all(updates.map((update) => api.updateCategory(update)));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : failure);
    } finally {
      // Si una de varias falló, el árbol puede haber cambiado a medias: se relee siempre.
      await refresh();
      setBusy(false);
    }
  }

  function closeAndRefresh() {
    setDialog(null);
    void refresh();
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-heading-lg">Categorías</h1>
          <p className="mt-2 max-w-2xl text-text-secondary">
            El árbol de navegación de la tienda. Un producto puede estar en varias categorías.
          </p>
        </div>
        <Can perform="catalog.product:write">
          <Button
            type="button"
            variant="outline"
            onClick={() => setDialog({ kind: "create", parent: null })}
          >
            Nueva categoría raíz
          </Button>
        </Can>
      </div>

      {categories.isPending && <p className="mt-8 text-text-secondary">Cargando categorías…</p>}
      {categories.isError && (
        <p role="alert" className="mt-8 text-error">
          No se pudieron consultar las categorías. {categories.error.message}
        </p>
      )}
      {actionError && (
        <p role="alert" className="mt-6 text-error">
          {actionError}
        </p>
      )}
      {categories.data && rows.length === 0 && (
        <p className="mt-8 text-text-secondary">Todavía no hay categorías.</p>
      )}
      {rows.length > 0 && (
        <ul aria-label="Árbol de categorías" className="mt-6 border-y border-border-subtle">
          {rows.map(({ category, depth, siblings, index }) => (
            <li
              key={category.id}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border-subtle py-3 last:border-0"
              style={{ paddingLeft: `${depth * 1.75}rem` }}
            >
              <div className="min-w-0">
                <p className="font-semibold">
                  {category.name}
                  {!category.isVisible && (
                    <span className="ml-2 border border-border-strong px-1.5 py-0.5 text-xs font-normal text-text-secondary">
                      Oculta
                    </span>
                  )}
                </p>
                <p className="truncate text-sm text-text-secondary">{category.path}</p>
              </div>
              <Can perform="catalog.product:write">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || index === 0}
                    aria-label={`Subir ${category.name}`}
                    onClick={() =>
                      void run(reorderUpdates(siblings, index, -1), "No se pudo reordenar.")
                    }
                  >
                    Subir
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || index === siblings.length - 1}
                    aria-label={`Bajar ${category.name}`}
                    onClick={() =>
                      void run(reorderUpdates(siblings, index, 1), "No se pudo reordenar.")
                    }
                  >
                    Bajar
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-label={`${category.isVisible ? "Ocultar" : "Mostrar"} ${category.name}`}
                    onClick={() =>
                      void run(
                        [{ id: category.id, isVisible: !category.isVisible }],
                        "No se pudo cambiar la visibilidad.",
                      )
                    }
                  >
                    {category.isVisible ? "Ocultar" : "Mostrar"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-label={`Renombrar ${category.name}`}
                    onClick={() => setDialog({ kind: "rename", category })}
                  >
                    Renombrar
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-label={`Mover ${category.name}`}
                    onClick={() => setDialog({ kind: "move", category })}
                  >
                    Mover
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-label={`Agregar subcategoría a ${category.name}`}
                    onClick={() => setDialog({ kind: "create", parent: category })}
                  >
                    Agregar subcategoría
                  </Button>
                </div>
              </Can>
            </li>
          ))}
        </ul>
      )}

      {dialog?.kind === "create" && (
        <CreateCategoryDialog
          parent={dialog.parent}
          siblings={
            dialog.parent
              ? all.filter((category) => category.parentId === dialog.parent?.id)
              : rootSiblings
          }
          onClose={() => setDialog(null)}
          onSaved={closeAndRefresh}
        />
      )}
      {dialog?.kind === "rename" && (
        <RenameCategoryDialog
          category={dialog.category}
          onClose={() => setDialog(null)}
          onSaved={closeAndRefresh}
        />
      )}
      {dialog?.kind === "move" && (
        <MoveCategoryDialog
          category={dialog.category}
          categories={all}
          onClose={() => setDialog(null)}
          onSaved={closeAndRefresh}
        />
      )}
    </main>
  );
}
