import { useEffect, useRef, useState } from "react";
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

function ActivateButton({
  product,
  onActivate,
}: {
  product: AdminProduct;
  onActivate: (product: AdminProduct) => Promise<void>;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={`Activar ${product.name}`}
      onClick={() => void onActivate(product)}
    >
      Activar
    </Button>
  );
}

// WP-C08q, RN-CAT-04: un archivado se reactiva con `write` y vuelve a activo SIN publicar.
function ReactivateButton({
  product,
  onReactivate,
}: {
  product: AdminProduct;
  onReactivate: (product: AdminProduct) => Promise<void>;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={`Reactivar ${product.name}`}
      onClick={() => void onReactivate(product)}
    >
      Reactivar
    </Button>
  );
}

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
  // resultado en una región `aria-live` y un rechazo de la API se muestra tal cual, junto
  // al producto donde se intentó.
  const busy = useRef(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState<{ productId: string; message: string } | null>(
    null,
  );
  // Al activar un borrador, el botón «Activar» desaparece de la fila (ya no es borrador): el
  // foco que tenía se perdería en <body>. Si pasa, vuelve al nombre del producto, o al título
  // de la pantalla si el producto ya no está en la lista.
  const [refocus, setRefocus] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const products = useQuery({
    queryKey: ["catalog-preview", kind, status, cursor],
    queryFn: () => api.listProducts({ kind, status, limit: 20, ...(cursor ? { cursor } : {}) }),
    retry: false,
  });

  useEffect(() => {
    if (refocus === null) return;
    if (document.activeElement === document.body || document.activeElement === null) {
      // Si el producto ya no está en la lista (por ejemplo, filtrada por «Borrador»), al título.
      (
        document.getElementById(`product-name-${refocus}`) ??
        document.getElementById("catalog-heading")
      )?.focus();
    }
    setRefocus(null);
  }, [refocus]);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["catalog-preview"] });
  }

  // No se deshabilitan los botones mientras corre (el foco se perdería al releer la
  // lista): un segundo clic se ignora.
  async function runPublication(
    productId: string,
    action: () => Promise<unknown>,
    messages: { readonly done: string; readonly failure: string },
  ) {
    if (busy.current) return;
    busy.current = true;
    setNotice("");
    setActionError(null);
    try {
      await action();
      setNotice(messages.done);
    } catch (cause) {
      setActionError({
        productId,
        message: cause instanceof Error ? cause.message : messages.failure,
      });
    } finally {
      await refresh();
      busy.current = false;
      setRefocus(productId);
    }
  }

  function activate(target: AdminProduct) {
    return runPublication(target.id, () => api.activateProduct({ id: target.id }), {
      done: `${target.name} se activó.`,
      failure: "No se pudo activar el producto.",
    });
  }

  function reactivate(target: AdminProduct) {
    return runPublication(target.id, () => api.activateProduct({ id: target.id }), {
      done: `${target.name} se reactivó y vuelve sin publicar.`,
      failure: "No se pudo reactivar el producto.",
    });
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1
            id="catalog-heading"
            tabIndex={-1}
            className="font-display text-heading-lg focus-visible:outline-2 focus-visible:outline-focus"
          >
            Productos
          </h1>
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
            <div
              key={product.id}
              data-testid="product-row"
              className="border-b border-border-subtle py-4 last:border-0"
            >
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p
                    id={`product-name-${product.id}`}
                    tabIndex={-1}
                    className="font-semibold focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    {product.name}
                  </p>
                  <p className="text-sm text-text-secondary">
                    {product.brandName ?? "Sin marca"} · {kinds[product.kind]}
                  </p>
                  {/* El estado interno y la publicación son cosas distintas (RF-CAT-09):
                      la tienda ve un producto cuando está activo Y publicado. */}
                  <p className="mt-1 text-sm">
                    <span className="text-text-secondary">Estado interno:</span>{" "}
                    {statuses[product.status]}
                    <span aria-hidden="true"> · </span>
                    <span className="text-text-secondary">Publicación:</span>{" "}
                    {product.publishedAt ? "Publicado" : "No publicado"}
                  </p>
                  {product.publishedAt && product.status === "draft" && (
                    <p className="text-sm text-text-secondary">
                      Publicado, pero no se ve en la tienda hasta que esté activo.
                    </p>
                  )}
                  {product.publishedAt && product.status === "archived" && (
                    <p className="text-sm text-text-secondary">
                      Publicado, pero no se ve en la tienda porque está archivado.
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
                        <dt className="text-text-secondary">Publicación</dt>
                        <dd>{product.publishedAt ? "Publicado" : "No publicado"}</dd>
                        <dt className="text-text-secondary">Variantes</dt>
                        <dd>{product.variants.length}</dd>
                      </dl>
                    </DialogContent>
                  </Dialog>
                  {/* Activar un borrador (RN-CAT-04): con `write` si no está publicado; si ya
                      tiene publicación, también hace falta `publish`, porque lo muestra en la tienda. */}
                  {product.status === "draft" && (
                    <Can perform="catalog.product:write">
                      {product.publishedAt ? (
                        <Can perform="catalog.product:publish">
                          <ActivateButton product={product} onActivate={activate} />
                        </Can>
                      ) : (
                        <ActivateButton product={product} onActivate={activate} />
                      )}
                    </Can>
                  )}
                  {/* Reactivar un archivado (RN-CAT-04): con `write`; vuelve activo y sin publicar,
                      así que publicarlo de nuevo sigue siendo de quien tiene `publish`. */}
                  {product.status === "archived" && (
                    <Can perform="catalog.product:write">
                      <ReactivateButton product={product} onReactivate={reactivate} />
                    </Can>
                  )}
                  <Can perform="catalog.product:publish">
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`${product.publishedAt ? "Despublicar" : "Publicar"} ${product.name}`}
                      onClick={() =>
                        void runPublication(
                          product.id,
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
              {actionError?.productId === product.id && (
                <p role="alert" className="mt-2 text-sm text-error">
                  {actionError.message}
                </p>
              )}
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
                          aria-label={`${variant.onlineVisible ? "Ocultar de la tienda" : "Mostrar en la tienda"} ${variant.sku}`}
                          onClick={() =>
                            void runPublication(
                              product.id,
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
