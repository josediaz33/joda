import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ProductKind, ProductStatus } from "@joda/contracts";
import { Button } from "@joda/ui/primitives/button";
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

// Consumidor de integración de las tres primitivas. WP-E05 reemplazará esta
// vista breve con el módulo completo de altas y edición.
export default function CatalogPreview() {
  const [kind, setKind] = useState<ProductKind | undefined>();
  const [status, setStatus] = useState<ProductStatus | undefined>();
  const products = useQuery({
    queryKey: ["catalog-preview", kind, status],
    queryFn: () => api.listProducts({ kind, status, limit: 20 }),
    retry: false,
  });

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <p className="text-sm text-text-secondary">Catálogo / Vista rápida</p>
      <h1 className="mt-2 font-display text-heading-lg">Productos</h1>
      <p className="mt-2 text-text-secondary">
        Consultá los productos registrados y sus datos básicos.
      </p>
      <div className="mt-8 flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-sm font-semibold" htmlFor="kind-filter">
            Tipo de producto
          </label>
          <Select
            value={kind ?? "all"}
            onValueChange={(value) => setKind(value === "all" ? undefined : (value as ProductKind))}
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
              onClick={() => setStatus(undefined)}
            >
              Todos
            </button>
            {(["draft", "active", "archived"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className="w-full rounded-control px-2 py-2 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-focus"
                onClick={() => setStatus(value)}
              >
                {statuses[value]}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      </div>

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
              className="flex flex-wrap items-center justify-between gap-4 border-b border-border-subtle py-4 last:border-0"
            >
              <div>
                <p className="font-semibold">{product.name}</p>
                <p className="text-sm text-text-secondary">
                  {product.brandName ?? "Sin marca"} · {kinds[product.kind]} ·{" "}
                  {statuses[product.status]}
                </p>
              </div>
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
                    <dt className="text-text-secondary">Estado</dt>
                    <dd>{statuses[product.status]}</dd>
                    <dt className="text-text-secondary">Variantes</dt>
                    <dd>{product.variants.length}</dd>
                  </dl>
                </DialogContent>
              </Dialog>
            </div>
          ))}
          {products.data.nextCursor && (
            <p className="py-3 text-sm text-text-secondary">
              Se muestran los primeros 20 productos.
            </p>
          )}
        </div>
      )}
    </main>
  );
}
