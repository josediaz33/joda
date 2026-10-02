import { useState, type ReactNode } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  FormProvider,
  useController,
  useForm,
  useFormContext,
  type FieldPath,
  type UseFormReturn,
} from "react-hook-form";
import {
  createProductInput,
  updateProductInput,
  type AdminCategory,
  type AdminProduct,
  type CreateProductInput,
  type UpdateProductInput,
} from "@joda/contracts";
import { Button } from "@joda/ui/primitives/button";
import { api } from "../../api";

type Props = {
  product?: AdminProduct;
  categories: AdminCategory[];
  onSaved: (product: AdminProduct) => void;
};

const inputClass =
  "w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-text focus-visible:outline-2 focus-visible:outline-focus aria-invalid:border-error";

function FieldError({ name }: { name: FieldPath<CreateProductInput> }) {
  const { getFieldState, formState } = useFormContext<CreateProductInput>();
  const error = getFieldState(name, formState).error;
  return error ? (
    <p id={`${name}-error`} role="alert" className="mt-1 text-sm text-error">
      {typeof error.message === "string" ? error.message : "Valor inválido."}
    </p>
  ) : null;
}

function TextField({
  name,
  label,
  required = false,
  multiline = false,
}: {
  name: FieldPath<CreateProductInput>;
  label: string;
  required?: boolean;
  multiline?: boolean;
}) {
  const { register, getFieldState, formState } = useFormContext<CreateProductInput>();
  const invalid = !!getFieldState(name, formState).error;
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-sm font-semibold">
        {label}
        {required ? " *" : ""}
      </label>
      {multiline ? (
        <textarea
          id={name}
          rows={3}
          className={inputClass}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${name}-error` : undefined}
          {...register(name)}
        />
      ) : (
        <input
          id={name}
          type="text"
          className={inputClass}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${name}-error` : undefined}
          {...register(name)}
        />
      )}
      <FieldError name={name} />
    </div>
  );
}

function NumberField({
  name,
  label,
  nullable = false,
  step = "any",
}: {
  name: FieldPath<CreateProductInput>;
  label: string;
  nullable?: boolean;
  step?: string;
}) {
  const { register, getFieldState, formState } = useFormContext<CreateProductInput>();
  const invalid = !!getFieldState(name, formState).error;
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-sm font-semibold">
        {label}
      </label>
      <input
        id={name}
        type="number"
        min="0"
        step={step}
        className={inputClass}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${name}-error` : undefined}
        {...register(name, {
          setValueAs: (value: string) => (value === "" && nullable ? null : Number(value)),
        })}
      />
      <FieldError name={name} />
    </div>
  );
}

function BooleanField({ name, label }: { name: FieldPath<CreateProductInput>; label: string }) {
  const { register } = useFormContext<CreateProductInput>();
  return (
    <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
      <input type="checkbox" className="size-4 accent-accent" {...register(name)} />
      {label}
    </label>
  );
}

function ListField({ name, label }: { name: FieldPath<CreateProductInput>; label: string }) {
  const { field, fieldState } = useController<CreateProductInput>({ name });
  const [display, setDisplay] = useState(() =>
    Array.isArray(field.value) ? field.value.join(", ") : "",
  );
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-sm font-semibold">
        {label}
      </label>
      <input
        id={name}
        type="text"
        className={inputClass}
        value={display}
        placeholder="Separá las notas con comas"
        aria-invalid={!!fieldState.error}
        aria-describedby={fieldState.error ? `${name}-error` : undefined}
        onChange={(event) => {
          setDisplay(event.target.value);
          field.onChange(
            event.target.value
              .split(",")
              .map((note) => note.trim())
              .filter(Boolean),
          );
        }}
        onBlur={field.onBlur}
      />
      <FieldError name={name} />
    </div>
  );
}

function Categories({ categories }: { categories: AdminCategory[] }) {
  const { watch, setValue, formState } = useFormContext<CreateProductInput>();
  const selected = watch("categoryIds") ?? [];
  const primary = watch("primaryCategoryId");
  return (
    <fieldset className="border-t border-border-subtle pt-5">
      <legend className="text-sm font-semibold">Categorías *</legend>
      <p className="mb-3 text-sm text-text-secondary">Elegí una o más y marcá una como primaria.</p>
      {categories.length === 0 && (
        <p className="text-sm text-error">No hay categorías disponibles.</p>
      )}
      <div className="max-h-44 overflow-y-auto border-y border-border-subtle">
        {categories.map((category) => (
          <div
            key={category.id}
            className="flex min-h-11 items-center justify-between gap-3 border-b border-border-subtle px-2 last:border-0"
          >
            <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(category.id)}
                aria-describedby={formState.errors.categoryIds ? "categoryIds-error" : undefined}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...selected, category.id]
                    : selected.filter((id) => id !== category.id);
                  setValue("categoryIds", next, { shouldValidate: true, shouldDirty: true });
                  if (!next.includes(primary)) {
                    setValue("primaryCategoryId", next[0] ?? "", {
                      shouldValidate: true,
                      shouldDirty: true,
                    });
                  }
                }}
              />
              <span className="truncate">{category.path}</span>
            </label>
            <label className="flex min-h-11 items-center gap-2 text-xs text-text-secondary">
              <input
                type="radio"
                name="primary-category"
                checked={primary === category.id}
                disabled={!selected.includes(category.id)}
                aria-describedby={
                  formState.errors.primaryCategoryId ? "primaryCategoryId-error" : undefined
                }
                onChange={() =>
                  setValue("primaryCategoryId", category.id, {
                    shouldValidate: true,
                    shouldDirty: true,
                  })
                }
              />
              Primaria
            </label>
          </div>
        ))}
      </div>
      {formState.errors.categoryIds && (
        <p id="categoryIds-error" role="alert" className="mt-1 text-sm text-error">
          Elegí al menos una categoría.
        </p>
      )}
      {formState.errors.primaryCategoryId && <FieldError name="primaryCategoryId" />}
    </fieldset>
  );
}

function CommonFields({ categories }: { categories: AdminCategory[] }) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="name" label="Nombre" required />
        <TextField name="slug" label="Slug" required />
      </div>
      <TextField name="description" label="Descripción" multiline />
      <Categories categories={categories} />
    </>
  );
}

async function saveProduct(
  input: CreateProductInput,
  product?: AdminProduct,
): Promise<AdminProduct> {
  if (!product) return api.createProduct(createProductInput.parse(input));
  const common = {
    id: product.id,
    slug: input.slug,
    name: input.name,
    description: input.description ?? null,
    brandId: input.brandId ?? null,
    categoryIds: input.categoryIds,
    primaryCategoryId: input.primaryCategoryId,
    tagIds: input.tagIds ?? [],
  };
  let update: UpdateProductInput;
  switch (input.kind) {
    case "perfume":
      update = { ...common, perfumeDetails: input.perfumeDetails };
      break;
    case "watch":
      update = { ...common, watchDetails: input.watchDetails };
      break;
    case "accessory":
      update = { ...common, accessoryDetails: input.accessoryDetails };
      break;
  }
  return api.updateProduct(updateProductInput.parse(update));
}

function EditorShell({
  form,
  product,
  categories,
  onSaved,
  children,
}: Props & { form: UseFormReturn<CreateProductInput>; children: ReactNode }) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <FormProvider {...form}>
      <form
        noValidate
        className="space-y-5"
        onSubmit={form.handleSubmit(async (values) => {
          setError("");
          setSaving(true);
          try {
            onSaved(await saveProduct(values, product));
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "No se pudo guardar el producto.");
          } finally {
            setSaving(false);
          }
        })}
      >
        <CommonFields categories={categories} />
        <div className="border-t border-border-subtle pt-5">{children}</div>
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
        <div className="sticky bottom-0 -mx-4 flex justify-end border-t border-border-subtle bg-surface px-4 py-3">
          <Button
            type="submit"
            disabled={saving || form.formState.isSubmitting || categories.length === 0}
          >
            {saving ? "Guardando…" : product ? "Guardar cambios" : "Crear producto"}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}

function productDefaults(product?: AdminProduct) {
  return {
    slug: product?.slug ?? "",
    name: product?.name ?? "",
    description: product?.description ?? "",
    brandId: product?.brandId ?? null,
    categoryIds: product?.categoryIds ?? [],
    primaryCategoryId: product?.primaryCategoryId ?? "",
    tagIds: product?.tagIds ?? [],
  };
}

export function PerfumeForm(props: Props) {
  const details = props.product?.kind === "perfume" ? props.product.perfumeDetails : undefined;
  const form = useForm<CreateProductInput>({
    resolver: zodResolver(createProductInput),
    mode: "onBlur",
    reValidateMode: "onChange",
    defaultValues: {
      ...productDefaults(props.product),
      kind: "perfume",
      perfumeDetails: details ?? {
        concentration: "edp",
        nominalVolumeMl: 100,
        olfactoryFamily: "",
        notesTop: [],
        notesHeart: [],
        notesBase: [],
        isDecantable: false,
        wasteFactor: 0,
        unusableResidueMl: 0,
        evaporationMlYear: 0,
      },
    },
  });
  return (
    <EditorShell {...props} form={form}>
      <h3 className="mb-4 font-semibold">Perfume</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label
            htmlFor="perfumeDetails.concentration"
            className="mb-1 block text-sm font-semibold"
          >
            Concentración
          </label>
          <select
            id="perfumeDetails.concentration"
            className={inputClass}
            {...form.register("perfumeDetails.concentration")}
          >
            <option value="parfum">Parfum</option>
            <option value="extrait">Extrait</option>
            <option value="edp">EDP</option>
            <option value="edt">EDT</option>
            <option value="edc">EDC</option>
            <option value="oil">Oil</option>
            <option value="attar">Attar</option>
          </select>
        </div>
        <NumberField name="perfumeDetails.nominalVolumeMl" label="Volumen nominal (ml)" />
        <TextField name="perfumeDetails.olfactoryFamily" label="Familia olfativa" />
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <ListField name="perfumeDetails.notesTop" label="Notas de salida" />
        <ListField name="perfumeDetails.notesHeart" label="Notas de corazón" />
        <ListField name="perfumeDetails.notesBase" label="Notas de fondo" />
      </div>
      <BooleanField name="perfumeDetails.isDecantable" label="Permite decants" />
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <NumberField name="perfumeDetails.wasteFactor" label="Factor de merma" />
        <NumberField name="perfumeDetails.unusableResidueMl" label="Residuo inutilizable (ml)" />
        <NumberField name="perfumeDetails.evaporationMlYear" label="Evaporación (ml/año)" />
      </div>
    </EditorShell>
  );
}

export function WatchForm(props: Props) {
  const details = props.product?.kind === "watch" ? props.product.watchDetails : undefined;
  const form = useForm<CreateProductInput>({
    resolver: zodResolver(createProductInput),
    mode: "onBlur",
    reValidateMode: "onChange",
    defaultValues: {
      ...productDefaults(props.product),
      kind: "watch",
      watchDetails: details ?? {
        movement: "quartz",
        caseMaterial: "",
        caseDiameterMm: null,
        waterResistanceM: null,
        strapMaterial: null,
        crystal: null,
        warrantyMonths: 0,
        requiresSerial: false,
      },
    },
  });
  return (
    <EditorShell {...props} form={form}>
      <h3 className="mb-4 font-semibold">Reloj</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="watchDetails.movement" className="mb-1 block text-sm font-semibold">
            Movimiento
          </label>
          <select
            id="watchDetails.movement"
            className={inputClass}
            {...form.register("watchDetails.movement")}
          >
            <option value="quartz">Cuarzo</option>
            <option value="automatic">Automático</option>
            <option value="manual">Manual</option>
            <option value="solar">Solar</option>
            <option value="kinetic">Cinético</option>
            <option value="spring_drive">Spring Drive</option>
          </select>
        </div>
        <TextField name="watchDetails.caseMaterial" label="Material de caja" />
        <NumberField name="watchDetails.caseDiameterMm" label="Diámetro (mm)" nullable />
        <NumberField
          name="watchDetails.waterResistanceM"
          label="Resistencia al agua (m)"
          nullable
          step="1"
        />
        <TextField name="watchDetails.strapMaterial" label="Material de correa" />
        <TextField name="watchDetails.crystal" label="Cristal" />
        <NumberField name="watchDetails.warrantyMonths" label="Garantía (meses)" step="1" />
      </div>
      <BooleanField name="watchDetails.requiresSerial" label="Requiere número de serie" />
    </EditorShell>
  );
}

export function AccessoryForm(props: Props) {
  const details = props.product?.kind === "accessory" ? props.product.accessoryDetails : undefined;
  const form = useForm<CreateProductInput>({
    resolver: zodResolver(createProductInput),
    mode: "onBlur",
    reValidateMode: "onChange",
    defaultValues: {
      ...productDefaults(props.product),
      kind: "accessory",
      accessoryDetails: details ?? { material: null, color: null, sizeLabel: null },
    },
  });
  return (
    <EditorShell {...props} form={form}>
      <h3 className="mb-4 font-semibold">Accesorio</h3>
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField name="accessoryDetails.material" label="Material" />
        <TextField name="accessoryDetails.color" label="Color" />
        <TextField name="accessoryDetails.sizeLabel" label="Tamaño" />
      </div>
    </EditorShell>
  );
}
