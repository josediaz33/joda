import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  createCategoryInput,
  type AdminCategory,
  type AdminProduct,
  type AdminVariant,
  type CreateCategoryInput,
  type ProductKind,
} from "@joda/contracts";
import { Button } from "@joda/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@joda/ui/primitives/dialog";
import { api } from "../../api";
import { AccessoryForm, PerfumeForm, WatchForm } from "./ProductForms";
import { CreateVariantForm, EditVariantForm } from "./VariantForms";

const kindNames: Record<ProductKind, string> = {
  perfume: "perfume",
  watch: "reloj",
  accessory: "accesorio",
};

async function loadCategories(): Promise<AdminCategory[]> {
  const categories: AdminCategory[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listCategories(cursor);
    categories.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return categories;
}

function InitialCategoryForm() {
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const form = useForm<CreateCategoryInput>({
    resolver: zodResolver(createCategoryInput),
    mode: "onBlur",
    reValidateMode: "onChange",
    defaultValues: { name: "", slug: "" },
  });
  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={form.handleSubmit(async (values) => {
        setError("");
        try {
          await api.createCategory(createCategoryInput.parse(values));
          await queryClient.invalidateQueries({ queryKey: ["catalog-categories"] });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "No se pudo crear la categoría.");
        }
      })}
    >
      <p className="text-sm text-text-secondary">
        Para cargar el primer producto, creá una categoría raíz.
      </p>
      <div>
        <label htmlFor="initial-category-name" className="mb-1 block text-sm font-semibold">
          Nombre de la categoría *
        </label>
        <input
          id="initial-category-name"
          className="w-full rounded-control border border-border-strong bg-surface px-3 py-2 focus-visible:outline-2 focus-visible:outline-focus"
          aria-invalid={!!form.formState.errors.name}
          aria-describedby={form.formState.errors.name ? "initial-category-name-error" : undefined}
          {...form.register("name")}
        />
        {form.formState.errors.name && (
          <p id="initial-category-name-error" role="alert" className="text-sm text-error">
            {form.formState.errors.name.message}
          </p>
        )}
      </div>
      <div>
        <label htmlFor="initial-category-slug" className="mb-1 block text-sm font-semibold">
          Slug de la categoría *
        </label>
        <input
          id="initial-category-slug"
          className="w-full rounded-control border border-border-strong bg-surface px-3 py-2 focus-visible:outline-2 focus-visible:outline-focus"
          aria-invalid={!!form.formState.errors.slug}
          aria-describedby={form.formState.errors.slug ? "initial-category-slug-error" : undefined}
          {...form.register("slug")}
        />
        {form.formState.errors.slug && (
          <p id="initial-category-slug-error" role="alert" className="text-sm text-error">
            {form.formState.errors.slug.message}
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <Button type="submit" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? "Creando…" : "Crear primera categoría"}
      </Button>
    </form>
  );
}

export function ProductEditor({
  kind,
  product,
  onSaved,
  onClose,
}: {
  kind: ProductKind;
  product?: AdminProduct;
  onSaved: () => void;
  onClose: () => void;
}) {
  const categories = useQuery({
    queryKey: ["catalog-categories"],
    queryFn: loadCategories,
    retry: false,
  });
  const props = { product, categories: categories.data ?? [], onSaved };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[min(88vh,48rem)] w-full flex-col overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {product ? "Editar" : "Nuevo"} {kindNames[kind]}
          </DialogTitle>
          <DialogDescription>
            Completá los datos del producto y su categoría primaria.
          </DialogDescription>
        </DialogHeader>
        {categories.isPending && <p role="status">Cargando categorías…</p>}
        {categories.isError && (
          <p role="alert" className="text-error">
            No se pudieron cargar las categorías.{" "}
            <Button type="button" variant="outline" onClick={() => void categories.refetch()}>
              Reintentar
            </Button>
          </p>
        )}
        {categories.data?.length === 0 && <InitialCategoryForm />}
        {categories.data && categories.data.length > 0 && kind === "perfume" && (
          <PerfumeForm key={product?.id ?? "new-perfume"} {...props} />
        )}
        {categories.data && categories.data.length > 0 && kind === "watch" && (
          <WatchForm key={product?.id ?? "new-watch"} {...props} />
        )}
        {categories.data && categories.data.length > 0 && kind === "accessory" && (
          <AccessoryForm key={product?.id ?? "new-accessory"} {...props} />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function VariantEditor({
  product,
  variant,
  onSaved,
  onClose,
}: {
  product: AdminProduct;
  variant?: AdminVariant;
  onSaved: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[min(88vh,42rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{variant ? "Editar variante" : "Nueva variante"}</DialogTitle>
          <DialogDescription>{product.name}</DialogDescription>
        </DialogHeader>
        {variant ? (
          <EditVariantForm variant={variant} onSaved={onSaved} />
        ) : (
          <CreateVariantForm product={product} onSaved={onSaved} />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ImageUpload({ product, onClose }: { product: AdminProduct; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [altText, setAltText] = useState("");
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState<Awaited<
    ReturnType<typeof api.uploadProductMedia>
  > | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !altText.trim()) return;
    setError("");
    setUploading(true);
    try {
      setUploaded(
        await api.uploadProductMedia({ productId: product.id, file, altText: altText.trim() }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo subir la imagen.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[min(88vh,40rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Imagen de {product.name}</DialogTitle>
          <DialogDescription>La imagen se sube al producto guardado.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <div>
            <label htmlFor="product-image" className="mb-1 block text-sm font-semibold">
              Archivo de imagen *
            </label>
            <input
              id="product-image"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              required
              className="block w-full text-sm"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </div>
          <div>
            <label htmlFor="image-alt" className="mb-1 block text-sm font-semibold">
              Descripción de la imagen *
            </label>
            <input
              id="image-alt"
              required
              maxLength={500}
              value={altText}
              onChange={(event) => setAltText(event.target.value)}
              className="w-full rounded-control border border-border-strong px-3 py-2 focus-visible:outline-2 focus-visible:outline-focus"
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          )}
          <Button type="submit" disabled={uploading || !file || !altText.trim()}>
            {uploading ? "Subiendo…" : "Subir imagen"}
          </Button>
        </form>
        {uploaded && (
          <div role="status" className="border-t border-border-subtle pt-4">
            <p className="mb-2 text-sm">Imagen subida.</p>
            {uploaded.derivatives[0] && uploaded.width !== null && uploaded.height !== null && (
              <img
                src={uploaded.derivatives[0].url}
                alt={uploaded.altText ?? ""}
                width={uploaded.width}
                height={uploaded.height}
                className="max-h-52 w-auto object-contain"
              />
            )}
            {(uploaded.width === null || uploaded.height === null) && (
              <p className="text-sm text-text-secondary">
                La vista previa no tiene dimensiones disponibles.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
