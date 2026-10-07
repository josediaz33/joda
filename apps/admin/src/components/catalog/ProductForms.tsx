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
  PERFUME_DEFAULTS,
  WATCH_DEFAULTS,
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

// Los campos compartidos aceptan la unión; cada detalle se instancia con la
// rama correspondiente para que TS rechace paths de otra vertical.
type PerfumeInput = Extract<CreateProductInput, { kind: "perfume" }>;
type WatchInput = Extract<CreateProductInput, { kind: "watch" }>;
type AccessoryInput = Extract<CreateProductInput, { kind: "accessory" }>;

const inputClass =
  "w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-text focus-visible:outline-2 focus-visible:outline-focus aria-invalid:border-error";

function FieldError<T extends CreateProductInput>({ name }: { name: FieldPath<T> }) {
  const { getFieldState, formState } = useFormContext<T>();
  const error = getFieldState(name, formState).error;
  return error ? (
    <p id={`${name}-error`} role="alert" className="mt-1 text-sm text-error">
      {typeof error.message === "string" ? error.message : "Valor inválido."}
    </p>
  ) : null;
}

function TextField<T extends CreateProductInput>({
  name,
  label,
  required = false,
  multiline = false,
}: {
  name: FieldPath<T>;
  label: string;
  required?: boolean;
  multiline?: boolean;
}) {
  const { register, getFieldState, formState } = useFormContext<T>();
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
      <FieldError<T> name={name} />
    </div>
  );
}

// Vacío es `null`, nunca `0`: un campo numérico sin cargar no puede llegar a la
// API como cero (la merma de un perfume o la resistencia de un reloj quedarían
// en cero sin que nadie lo vea). Si el esquema admite `null`, se guarda así; si
// no, el esquema rechaza el envío y el error se muestra junto al campo.
function NumberField<T extends CreateProductInput>({
  name,
  label,
  step = "any",
}: {
  name: FieldPath<T>;
  label: string;
  step?: string;
}) {
  const { field, fieldState } = useController<T>({ name });
  const invalid = !!fieldState.error;
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
        value={String(field.value ?? "")}
        ref={field.ref}
        name={field.name}
        onBlur={field.onBlur}
        onChange={(event) => {
          const raw = event.target.value;
          field.onChange(raw === "" ? null : Number(raw));
        }}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${name}-error` : undefined}
      />
      <FieldError<T> name={name} />
    </div>
  );
}

function SelectField<T extends CreateProductInput>({
  name,
  label,
  options,
}: {
  name: FieldPath<T>;
  label: string;
  options: readonly { value: string; label: string }[];
}) {
  const { register, getFieldState, formState } = useFormContext<T>();
  const invalid = !!getFieldState(name, formState).error;
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-sm font-semibold">
        {label}
      </label>
      <select
        id={name}
        className={inputClass}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${name}-error` : undefined}
        {...register(name)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <FieldError<T> name={name} />
    </div>
  );
}

function BooleanField<T extends CreateProductInput>({
  name,
  label,
}: {
  name: FieldPath<T>;
  label: string;
}) {
  const { register } = useFormContext<T>();
  return (
    <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
      <input type="checkbox" className="size-4 accent-accent" {...register(name)} />
      {label}
    </label>
  );
}

// Sin opción preseleccionada: "no elegido" y "No" son estados distintos. El
// reloj no es serializable por defecto, y tampoco lo es por omisión — el
// operador tiene que marcar Sí o No, o el esquema rechaza el envío (no todos
// los relojes llevan número de serie).
function RadioBooleanField<T extends CreateProductInput>({
  name,
  label,
  trueLabel = "Sí",
  falseLabel = "No",
}: {
  name: FieldPath<T>;
  label: string;
  trueLabel?: string;
  falseLabel?: string;
}) {
  const { field, fieldState } = useController<T>({ name });
  const invalid = !!fieldState.error;
  return (
    <fieldset>
      <legend className="mb-1 block text-sm font-semibold">{label} *</legend>
      <div className="flex gap-4" aria-describedby={invalid ? `${name}-error` : undefined}>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="radio"
            name={field.name}
            checked={field.value === true}
            onChange={() => field.onChange(true)}
            onBlur={field.onBlur}
          />
          {trueLabel}
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="radio"
            name={field.name}
            checked={field.value === false}
            onChange={() => field.onChange(false)}
            onBlur={field.onBlur}
          />
          {falseLabel}
        </label>
      </div>
      <FieldError<T> name={name} />
    </fieldset>
  );
}

function ListField<T extends CreateProductInput>({
  name,
  label,
}: {
  name: FieldPath<T>;
  label: string;
}) {
  const { field, fieldState } = useController<T>({ name });
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
      <FieldError<T> name={name} />
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
      {formState.errors.primaryCategoryId && (
        <FieldError<CreateProductInput> name="primaryCategoryId" />
      )}
    </fieldset>
  );
}

function CommonFields({ categories }: { categories: AdminCategory[] }) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField<CreateProductInput> name="name" label="Nombre" required />
        <TextField<CreateProductInput> name="slug" label="Slug" required />
      </div>
      <TextField<CreateProductInput> name="description" label="Descripción" multiline />
      <Categories categories={categories} />
    </>
  );
}

async function saveProduct(
  input: CreateProductInput,
  product?: AdminProduct,
): Promise<AdminProduct> {
  if (!product) return api.createProduct(createProductInput.parse(input));
  // El editor carga un producto completo en ambas modalidades para que el
  // resolver de create valide juntos detalles y categoría primaria. `kind` es
  // inmutable: al editar proyectamos esos valores al contrato parcial de update.
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
        // Merma y decantable: de PERFUME_DEFAULTS, nunca de ceros. Un cero acá
        // dejaría el perfume sin merma y no decantable sin que nadie lo note.
        isDecantable: PERFUME_DEFAULTS.isDecantable,
        wasteFactor: PERFUME_DEFAULTS.wasteFactor,
        unusableResidueMl: PERFUME_DEFAULTS.unusableResidueMl,
        evaporationMlYear: PERFUME_DEFAULTS.evaporationMlYear,
      },
    },
  });
  return (
    <EditorShell {...props} form={form}>
      <h3 className="mb-4 font-semibold">Perfume</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField<PerfumeInput>
          name="perfumeDetails.concentration"
          label="Concentración"
          options={[
            { value: "parfum", label: "Parfum" },
            { value: "extrait", label: "Extrait" },
            { value: "edp", label: "EDP" },
            { value: "edt", label: "EDT" },
            { value: "edc", label: "EDC" },
            { value: "oil", label: "Oil" },
            { value: "attar", label: "Attar" },
          ]}
        />
        <NumberField<PerfumeInput>
          name="perfumeDetails.nominalVolumeMl"
          label="Volumen nominal (ml)"
        />
        <TextField<PerfumeInput> name="perfumeDetails.olfactoryFamily" label="Familia olfativa" />
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <ListField<PerfumeInput> name="perfumeDetails.notesTop" label="Notas de salida" />
        <ListField<PerfumeInput> name="perfumeDetails.notesHeart" label="Notas de corazón" />
        <ListField<PerfumeInput> name="perfumeDetails.notesBase" label="Notas de fondo" />
      </div>
      <BooleanField<PerfumeInput> name="perfumeDetails.isDecantable" label="Permite decants" />
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <NumberField<PerfumeInput> name="perfumeDetails.wasteFactor" label="Factor de merma" />
        <NumberField<PerfumeInput>
          name="perfumeDetails.unusableResidueMl"
          label="Residuo inutilizable (ml)"
        />
        <NumberField<PerfumeInput>
          name="perfumeDetails.evaporationMlYear"
          label="Evaporación (ml/año)"
        />
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
        // Garantía: de WATCH_DEFAULTS. La serie NO tiene valor por defecto ni
        // acá ni en la columna (0035_business_defaults_decisions.sql): no
        // todos los relojes la llevan. Queda sin elegir (`requiresSerial`
        // ausente) hasta que el operador marque Sí o No; el esquema rechaza
        // el envío si no lo hizo.
        warrantyMonths: WATCH_DEFAULTS.warrantyMonths,
      },
    },
  });
  return (
    <EditorShell {...props} form={form}>
      <h3 className="mb-4 font-semibold">Reloj</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField<WatchInput>
          name="watchDetails.movement"
          label="Movimiento"
          options={[
            { value: "quartz", label: "Cuarzo" },
            { value: "automatic", label: "Automático" },
            { value: "manual", label: "Manual" },
            { value: "solar", label: "Solar" },
            { value: "kinetic", label: "Cinético" },
            { value: "spring_drive", label: "Spring Drive" },
          ]}
        />
        <TextField<WatchInput> name="watchDetails.caseMaterial" label="Material de caja" />
        <NumberField<WatchInput> name="watchDetails.caseDiameterMm" label="Diámetro (mm)" />
        <NumberField<WatchInput>
          name="watchDetails.waterResistanceM"
          label="Resistencia al agua (m)"
          step="1"
        />
        <TextField<WatchInput> name="watchDetails.strapMaterial" label="Material de correa" />
        <TextField<WatchInput> name="watchDetails.crystal" label="Cristal" />
        <NumberField<WatchInput>
          name="watchDetails.warrantyMonths"
          label="Garantía (meses)"
          step="1"
        />
      </div>
      <RadioBooleanField<WatchInput>
        name="watchDetails.requiresSerial"
        label="Requiere número de serie"
      />
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
        <TextField<AccessoryInput> name="accessoryDetails.material" label="Material" />
        <TextField<AccessoryInput> name="accessoryDetails.color" label="Color" />
        <TextField<AccessoryInput> name="accessoryDetails.sizeLabel" label="Tamaño" />
      </div>
    </EditorShell>
  );
}
