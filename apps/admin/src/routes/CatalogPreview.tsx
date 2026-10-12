import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminProduct, AdminVariant, ProductKind, ProductStatus } from "@joda/contracts";
import { Button } from "@joda/ui/primitives/button";
import { formatPyg } from "@joda/ui/format/money";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@joda/ui/primitives/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@joda/ui/primitives/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@joda/ui/primitives/select";
import { api } from "../api";
import { Can } from "../Can";
import { ImageUpload, ProductEditor, VariantEditor } from "../components/catalog/CatalogActions";

const kinds: Record<ProductKind, string> = {
  perfume: "Perfume",
  watch: "Reloj",
  accessory: "Accesorio",
};
const statuses: Record<ProductStatus, string> = {
  draft: "Borrador",
  active: "Activo",
  archived: "Archivado",
};

export default function CatalogPreview() {
  const [kind, setKind] = useState<ProductKind | undefined>();
  const [status, setStatus] = useState<ProductStatus | undefined>();
  const [pageCursors, setPageCursors] = useState<string[]>([]);
  const cursor = pageCursors.at(-1);
  const [editor, setEditor] = useState<{ kind: ProductKind; product?: AdminProduct } | null>(null);
  const [variantEditor, setVariantEditor] = useState<{
    product: AdminProduct;
    variant?: AdminVariant;
  } | null>(null);
  const [imageProduct, setImageProduct] = useState<AdminProduct | null>(null);
  // Publicar, despublicar y mostrar u ocultar una variante (RF-CAT-09): se anuncia el
  // resultado en una región `aria-live` y un rechazo de la API se muestra tal cual.
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const queryClient = useQueryClient();
  const products = useQuery({
    queryKey: ["catalog-preview", kind, status, cursor],
    queryFn: () => api.listProducts({ kind, status, limit: 20, ...(cursor ? { cursor } : {}) }),
    retry: false,
  });

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["catalog-preview"] });
  }

  // No se deshabilitan los botones mientras corre (el foco se perdería al releer la
  // lista): un segundo clic se ignora.
  async function runPublication(
    action: () => Promise<unknown>,
    messages: { readonly done: string; readonly failure: string },
  ) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    setActionError("");
    try {
      await action();
      setNotice(messages.done);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : messages.failure);
    } finally {
      await refresh();
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-heading-lg">Productos</h1>
          <p className="mt-2 text-text-secondary">Administrá perfumes, relojes y accesorios.</p>
        </div>
        <Can perform="catalog.product:write">
          <div className="flex flex-wrap gap-2">
            {(["perfume", "watch", "accessory"] as const).map((value) => (
              <Button
                key={value}
                type="button"
                variant="outline"
                onClick={() => setEditor({ kind: value })}
              >
                Nuevo {kinds[value].toLowerCase()}
              </Button>
            ))}
          </div>
        </Can>
      </div>
      <div className="mt-8 flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-sm font-semibold" htmlFor="kind-filter">
            Tipo de producto
          </label>
          <Select
            value={kind ?? "all"}
            onValueChange={(value) => {
              setKind(value === "all" ? undefined : (value as ProductKind));
              setPageCursors([]);
            }}
          >
            <SelectTrigger id="kind-filter" aria-label="Tipo de producto" className="min-w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="perfume">Perfumes</SelectItem>
              <SelectItem value="watch">Relojes</SelectItem>
              <SelectItem value="accessory">Accesorios</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline">Estado: {status ? statuses[status] : "Todos"}</Button>
          </PopoverTrigger>
          <PopoverContent aria-label="Filtrar por estado" align="start">
            <p className="px-2 text-sm font-semibold">Mostrar productos</p>
            <button
              type="button"
              className="w-full rounded-control px-2 py-2 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-focus"
              onClick={() => {
                setStatus(undefined);
                setPageCursors([]);
              }}
            >
              Todos
            </button>
            {(["draft", "active", "archived"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className="w-full rounded-control px-2 py-2 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-focus"
                onClick={() => {
                  setStatus(value);
                  setPageCursors([]);
                }}
              >
                {statuses[value]}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      </div>

      <p role="status" className="sr-only">
        {notice}
      </p>
      {actionError && (
        <p role="alert" className="mt-6 text-error">
          {actionError}
        </p>
      )}
      {products.isPending && <p className="mt-8 text-text-secondary">Cargando productos…</p>}
      {products.isError && (
        <p role="alert" className="mt-8 text-error">
          No se pudo consultar el catálogo. {products.error.message}
        </p>
      )}
      {products.data && (
        <div className="mt-6 border-y border-border-subtle">
          {products.data.items.length === 0 && (
            <p className="py-8 text-text-secondary">No hay productos con estos filtros.</p>
          )}
          {products.data.items.map((product) => (
            <div key={product.id} className="border-b border-border-subtle py-4 last:border-0">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="font-semibold">{product.name}</p>
                  <p className="text-sm text-text-secondary">
                    {product.brandName ?? "Sin marca"} · {kinds[product.kind]}
                  </p>
                  {/* El estado interno y la publicación son cosas distintas (RF-CAT-09):
                      la tienda ve un producto cuando está activo Y publicado. */}
                  <p className="mt-1 text-sm">
                    <span className="text-text-secondary">Estado interno:</span>{" "}
                    {statuses[product.status]}
                    <span aria-hidden="true"> · </span>
                    <span className="text-text-secondary">En la tienda:</span>{" "}
                    {product.publishedAt ? "Publicado" : "No publicado"}
                  </p>
                  {product.publishedAt && product.status !== "active" && (
                    <p className="text-sm text-text-secondary">
                      Publicado, pero no se ve en la tienda hasta que esté activo.
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button variant="outline" size="sm">
                        Ver detalle
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="max-h-[min(85vh,40rem)] overflow-y-auto">
                      <DialogHeader>
                        <DialogTitle>{product.name}</DialogTitle>
                        <DialogDescription>
                          {product.brandName ?? "Sin marca"} · {kinds[product.kind]}
                        </DialogDescription>
                      </DialogHeader>
                      <dl className="grid grid-cols-2 gap-3 text-sm">
                        <dt className="text-text-secondary">Estado interno</dt>
                        <dd>{statuses[product.status]}</dd>
                        <dt className="text-text-secondary">En la tienda</dt>
                        <dd>{product.publishedAt ? "Publicado" : "No publicado"}</dd>
                        <dt className="text-text-secondary">Variantes</dt>
                        <dd>{product.variants.length}</dd>
                      </dl>
                    </DialogContent>
                  </Dialog>
                  <Can perform="catalog.product:publish">
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`${product.publishedAt ? "Despublicar" : "Publicar"} ${product.name}`}
                      onClick={() =>
                        void runPublication(
                          () =>
                            product.publishedAt
                              ? api.unpublishProduct({ id: product.id })
                              : api.publishProduct({ id: product.id }),
                          {
                            done: product.publishedAt
                              ? `${product.name} se despublicó.`
                              : `${product.name} se publicó.`,
                            failure: "No se pudo cambiar la publicación.",
                          },
                        )
                      }
                    >
                      {product.publishedAt ? "Despublicar" : "Publicar"}
                    </Button>
                  </Can>
                  <Can perform="catalog.product:write">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditor({ kind: product.kind, product })}
                    >
                      Editar
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setVariantEditor({ product })}
                    >
                      Nueva variante
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setImageProduct(product)}>
                      Subir imagen
                    </Button>
                  </Can>
                </div>
              </div>
              {product.variants.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-sm">
                  {product.variants.map((variant) => (
                    <div key={variant.id} className="flex items-center gap-2">
                      <span>
                        {variant.sku} · {formatPyg(variant.pricePyg)} ·{" "}
                        <span className="text-text-secondary">
                          {variant.onlineVisible
                            ? "Visible en la tienda"
                            : "No visible en la tienda"}
                        </span>
                      </span>
                      <Can perform="catalog.product:publish">
                        <Button
                          variant="link"
                          size="sm"
                          aria-label={`${variant.onlineVisible ? "Ocultar" : "Mostrar"} ${variant.sku} en la tienda`}
                          onClick={() =>
                            void runPublication(
                              () =>
                                api.setVariantVisibility({
                                  id: variant.id,
                                  onlineVisible: !variant.onlineVisible,
                                }),
                              {
                                done: variant.onlineVisible
                                  ? `${variant.sku} quedó oculta de la tienda.`
                                  : `${variant.sku} quedó visible en la tienda.`,
                                failure: "No se pudo cambiar la visibilidad.",
                              },
                            )
                          }
                        >
                          {variant.onlineVisible ? "Ocultar de la tienda" : "Mostrar en la tienda"}
                        </Button>
                      </Can>
                      <Can perform="catalog.product:write">
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() => setVariantEditor({ product, variant })}
                        >
                          Editar variante
                        </Button>
                      </Can>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div className="flex justify-between py-3">
            {pageCursors.length > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPageCursors((current) => current.slice(0, -1))}
              >
                Anterior
              </Button>
            ) : (
              <span />
            )}
            {products.data.nextCursor && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setPageCursors((current) => [...current, products.data!.nextCursor!])
                }
              >
                Siguiente
              </Button>
            )}
          </div>
        </div>
      )}
      {editor && (
        <ProductEditor
          kind={editor.kind}
          product={editor.product}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            void refresh();
          }}
        />
      )}
      {variantEditor && (
        <VariantEditor
          product={variantEditor.product}
          variant={variantEditor.variant}
          onClose={() => setVariantEditor(null)}
          onSaved={() => {
            setVariantEditor(null);
            void refresh();
          }}
        />
      )}
      {imageProduct && <ImageUpload product={imageProduct} onClose={() => setImageProduct(null)} />}
    </main>
  );
}
