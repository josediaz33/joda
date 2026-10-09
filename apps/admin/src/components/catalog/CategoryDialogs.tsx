import { useState, type ReactNode } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  createCategoryInput,
  updateCategoryInput,
  type AdminCategory,
  type CreateCategoryInput,
  type UpdateCategoryInput,
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
import { moveTargets, nextPosition } from "./categoryTree";

// Altas, renombrado y reubicación de categorías (WP-E05b, RF-CAT-03). Cada
// diálogo valida con el esquema de `packages/contracts` y le deja a la API la
// última palabra: un destino ajeno o un ciclo se rechazan allá, no acá.

const inputClass =
  "w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-text focus-visible:outline-2 focus-visible:outline-focus aria-invalid:border-error";

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function DialogFrame({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[min(88vh,40rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function FormActions({
  submitting,
  submitLabel,
  submittingLabel,
  error,
  onClose,
}: {
  submitting: boolean;
  submitLabel: string;
  submittingLabel: string;
  error: string;
  onClose: () => void;
}) {
  return (
    <>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancelar
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? submittingLabel : submitLabel}
        </Button>
      </div>
    </>
  );
}

function FieldMessage({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-sm text-error">
      {message}
    </p>
  );
}

/** Alta de una categoría raíz (`parent` nulo) o de una subcategoría. Entra al final de sus hermanas. */
export function CreateCategoryDialog({
  parent,
  siblings,
  onClose,
  onSaved,
}: {
  parent: AdminCategory | null;
  siblings: readonly AdminCategory[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState("");
  const form = useForm<CreateCategoryInput>({
    resolver: zodResolver(createCategoryInput),
    mode: "onBlur",
    reValidateMode: "onChange",
    defaultValues: { name: "", slug: "" },
  });
  const { errors, isSubmitting } = form.formState;

  return (
    <DialogFrame
      title={parent ? `Nueva subcategoría de ${parent.name}` : "Nueva categoría raíz"}
      description={
        parent ? `Va dentro de ${parent.path}.` : "Una categoría raíz no depende de ninguna otra."
      }
      onClose={onClose}
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={form.handleSubmit(async (values) => {
          setError("");
          try {
            await api.createCategory(
              createCategoryInput.parse({
                ...values,
                ...(parent ? { parentId: parent.id } : {}),
                position: nextPosition(siblings),
              }),
            );
            onSaved();
          } catch (cause) {
            setError(messageOf(cause, "No se pudo crear la categoría."));
          }
        })}
      >
        <div>
          <label htmlFor="category-name" className="mb-1 block text-sm font-semibold">
            Nombre *
          </label>
          <input
            id="category-name"
            className={inputClass}
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? "category-name-error" : undefined}
            {...form.register("name")}
          />
          <FieldMessage id="category-name-error" message={errors.name?.message} />
        </div>
        <div>
          <label htmlFor="category-slug" className="mb-1 block text-sm font-semibold">
            Slug *
          </label>
          <input
            id="category-slug"
            className={inputClass}
            aria-invalid={!!errors.slug}
            aria-describedby={
              errors.slug ? "category-slug-error category-slug-hint" : "category-slug-hint"
            }
            {...form.register("slug")}
          />
          <p id="category-slug-hint" className="mt-1 text-sm text-text-secondary">
            Forma parte de la dirección de la categoría. No se puede cambiar después.
          </p>
          <FieldMessage id="category-slug-error" message={errors.slug?.message} />
        </div>
        <FormActions
          submitting={isSubmitting}
          submitLabel="Crear categoría"
          submittingLabel="Creando…"
          error={error}
          onClose={onClose}
        />
      </form>
    </DialogFrame>
  );
}

/** Cambia el nombre que se muestra. El slug, y con él el `path`, no cambian. */
export function RenameCategoryDialog({
  category,
  onClose,
  onSaved,
}: {
  category: AdminCategory;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState("");
  const form = useForm<Pick<UpdateCategoryInput, "name">>({
    resolver: zodResolver(updateCategoryInput.pick({ name: true })),
    mode: "onBlur",
    reValidateMode: "onChange",
    defaultValues: { name: category.name },
  });
  const { errors, isSubmitting } = form.formState;

  return (
    <DialogFrame
      title="Renombrar categoría"
      description="El nombre se muestra en el menú. La dirección (slug) no cambia."
      onClose={onClose}
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={form.handleSubmit(async (values) => {
          setError("");
          try {
            await api.updateCategory(
              updateCategoryInput.parse({ id: category.id, name: values.name }),
            );
            onSaved();
          } catch (cause) {
            setError(messageOf(cause, "No se pudo renombrar la categoría."));
          }
        })}
      >
        <div>
          <label htmlFor="category-rename" className="mb-1 block text-sm font-semibold">
            Nombre *
          </label>
          <input
            id="category-rename"
            className={inputClass}
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? "category-rename-error" : undefined}
            {...form.register("name")}
          />
          <FieldMessage id="category-rename-error" message={errors.name?.message} />
        </div>
        <FormActions
          submitting={isSubmitting}
          submitLabel="Guardar nombre"
          submittingLabel="Guardando…"
          error={error}
          onClose={onClose}
        />
      </form>
    </DialogFrame>
  );
}

const ROOT_OPTION = "";

/**
 * Reubica una categoría con todo lo que cuelga de ella. El selector ofrece
 * todas menos ella y su subárbol; la dirección (`path`) de cada una cambia
 * junto con el padre.
 */
export function MoveCategoryDialog({
  category,
  categories,
  onClose,
  onSaved,
}: {
  category: AdminCategory;
  categories: readonly AdminCategory[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [parentId, setParentId] = useState(category.parentId ?? ROOT_OPTION);
  const targets = moveTargets(categories, category.id);

  async function save() {
    setError("");
    if (parentId === (category.parentId ?? ROOT_OPTION)) {
      onClose();
      return;
    }
    setSubmitting(true);
    try {
      await api.updateCategory(
        updateCategoryInput.parse({
          id: category.id,
          parentId: parentId === ROOT_OPTION ? null : parentId,
        }),
      );
      onSaved();
    } catch (cause) {
      setError(messageOf(cause, "No se pudo mover la categoría."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DialogFrame
      title={`Mover ${category.name}`}
      description="Sus subcategorías se mueven con ella y la dirección de todas cambia."
      onClose={onClose}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div>
          <label htmlFor="category-parent" className="mb-1 block text-sm font-semibold">
            Dentro de
          </label>
          <select
            id="category-parent"
            className={inputClass}
            value={parentId}
            onChange={(event) => setParentId(event.target.value)}
          >
            <option value={ROOT_OPTION}>Ninguna (categoría raíz)</option>
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.path}
              </option>
            ))}
          </select>
        </div>
        <FormActions
          submitting={submitting}
          submitLabel="Mover"
          submittingLabel="Moviendo…"
          error={error}
          onClose={onClose}
        />
      </form>
    </DialogFrame>
  );
}
