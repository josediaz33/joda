import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import {
  createVariantInput,
  updateVariantInput,
  type AdminVariant,
  type CreateVariantInput,
  type UpdateVariantInput,
} from "@joda/contracts";
import { Button } from "@joda/ui/primitives/button";
import { formatPyg } from "@joda/ui/format/money";
import { api } from "../../api";

const inputClass =
  "w-full rounded-control border border-border-strong bg-surface px-3 py-2 focus-visible:outline-2 focus-visible:outline-focus aria-invalid:border-error";

function MoneyInput({
  id,
  label,
  value,
  onChange,
  onBlur,
  error,
}: {
  id: string;
  label: string;
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  onBlur: () => void;
  error?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-semibold">
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        className={inputClass}
        value={value ? formatPyg(value) : ""}
        onChange={(event) => {
          const digits = event.target.value.replace(/\D/g, "");
          onChange(digits || null);
        }}
        onBlur={onBlur}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1 text-sm text-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function CreateVariantForm({
  productId,
  onSaved,
}: {
  productId: string;
  onSaved: (variant: AdminVariant) => void;
}) {
  const [error, setError] = useState("");
  const form = useForm<CreateVariantInput>({
    resolver: zodResolver(createVariantInput),
    mode: "onBlur",
    reValidateMode: "onChange",
    defaultValues: {
      productId,
      sku: "",
      variantType: "unit",
      uom: "unit",
      sizeMl: null,
      pricePyg: "",
      compareAtPyg: null,
      vatRate: "iva_10",
      productionMode: "stocked",
      sourceVariantId: null,
      isSerialized: false,
      onlineVisible: false,
      // allocationPolicy, minStockAlert, weightG y position no tienen control
      // en WP-E05: se omiten y C08 aplica sus defaults, sin copiarlos acá.
    },
  });
  const type = form.watch("variantType");
  const mode = form.watch("productionMode");
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={form.handleSubmit(async (values) => {
        setError("");
        try {
          onSaved(
            await api.createVariant(
              createVariantInput.parse({
                ...values,
                // El granel es inventario para fraccionar, no una variante vendible.
                onlineVisible: values.variantType === "bulk" ? false : values.onlineVisible,
              }),
            ),
          );
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "No se pudo crear la variante.");
        }
      })}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="variant-sku" className="mb-1 block text-sm font-semibold">
            SKU *
          </label>
          <input
            id="variant-sku"
            className={inputClass}
            aria-invalid={!!form.formState.errors.sku}
            aria-describedby={form.formState.errors.sku ? "variant-sku-error" : undefined}
            {...form.register("sku")}
          />
          {form.formState.errors.sku && (
            <p id="variant-sku-error" role="alert" className="text-error">
              {form.formState.errors.sku.message}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="variant-type" className="mb-1 block text-sm font-semibold">
            Presentación
          </label>
          <select
            id="variant-type"
            className={inputClass}
            value={type}
            onChange={(event) => {
              const value = event.target.value as CreateVariantInput["variantType"];
              form.setValue("variantType", value, { shouldValidate: true });
              if (value === "bulk") {
                form.setValue("onlineVisible", false, { shouldValidate: true });
              }
              form.setValue("uom", value === "decant" || value === "bulk" ? "ml" : "unit", {
                shouldValidate: true,
              });
              form.setValue(
                "sizeMl",
                value === "sealed" || value === "decant" || value === "tester" ? 1 : null,
                { shouldValidate: true },
              );
            }}
          >
            <option value="unit">Unidad</option>
            <option value="sealed">Sellado</option>
            <option value="decant">Decant</option>
            <option value="tester">Tester</option>
            <option value="bulk">Granel</option>
            <option value="supply">Insumo</option>
          </select>
        </div>
        {(type === "sealed" || type === "decant" || type === "tester") && (
          <div>
            <label htmlFor="variant-size" className="mb-1 block text-sm font-semibold">
              Tamaño (ml) *
            </label>
            <input
              id="variant-size"
              type="number"
              min="0.001"
              step="any"
              className={inputClass}
              aria-invalid={!!form.formState.errors.sizeMl}
              aria-describedby={form.formState.errors.sizeMl ? "variant-size-error" : undefined}
              {...form.register("sizeMl", { valueAsNumber: true })}
            />
            {form.formState.errors.sizeMl && (
              <p id="variant-size-error" role="alert" className="text-error">
                {form.formState.errors.sizeMl.message}
              </p>
            )}
          </div>
        )}
        <Controller
          control={form.control}
          name="pricePyg"
          render={({ field, fieldState }) => (
            <MoneyInput
              id="variant-price"
              label="Precio (Gs.) *"
              value={field.value}
              onChange={(value) => field.onChange(value ?? "")}
              onBlur={field.onBlur}
              error={fieldState.error?.message}
            />
          )}
        />
        <Controller
          control={form.control}
          name="compareAtPyg"
          render={({ field, fieldState }) => (
            <MoneyInput
              id="variant-compare"
              label="Precio anterior (Gs.)"
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              error={fieldState.error?.message}
            />
          )}
        />
        <div>
          <label htmlFor="variant-vat" className="mb-1 block text-sm font-semibold">
            IVA
          </label>
          <select id="variant-vat" className={inputClass} {...form.register("vatRate")}>
            <option value="iva_10">IVA 10%</option>
            <option value="iva_5">IVA 5%</option>
            <option value="exenta">Exenta</option>
          </select>
        </div>
        <div>
          <label htmlFor="variant-mode" className="mb-1 block text-sm font-semibold">
            Producción
          </label>
          <select id="variant-mode" className={inputClass} {...form.register("productionMode")}>
            <option value="stocked">En stock</option>
            <option value="made_to_order">Bajo pedido</option>
          </select>
        </div>
        {mode === "made_to_order" && (
          <div>
            <label htmlFor="variant-source" className="mb-1 block text-sm font-semibold">
              ID de variante de origen *
            </label>
            <input
              id="variant-source"
              className={inputClass}
              aria-invalid={!!form.formState.errors.sourceVariantId}
              aria-describedby={
                form.formState.errors.sourceVariantId ? "variant-source-error" : undefined
              }
              {...form.register("sourceVariantId")}
            />
            {form.formState.errors.sourceVariantId && (
              <p id="variant-source-error" role="alert" className="text-error">
                {form.formState.errors.sourceVariantId.message}
              </p>
            )}
          </div>
        )}
      </div>
      {type !== "bulk" && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" {...form.register("onlineVisible")} /> Visible en línea
        </label>
      )}
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" {...form.register("isSerialized")} /> Requiere serie
      </label>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? "Guardando…" : "Crear variante"}
        </Button>
      </div>
    </form>
  );
}

export function EditVariantForm({
  variant,
  onSaved,
}: {
  variant: AdminVariant;
  onSaved: (variant: AdminVariant) => void;
}) {
  const [error, setError] = useState("");
  const form = useForm<UpdateVariantInput>({
    resolver: zodResolver(updateVariantInput),
    mode: "onBlur",
    reValidateMode: "onChange",
    defaultValues: {
      id: variant.id,
      sku: variant.sku,
      pricePyg: variant.pricePyg,
      compareAtPyg: variant.compareAtPyg,
      vatRate: variant.vatRate,
      onlineVisible: variant.onlineVisible,
      position: variant.position,
    },
  });
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={form.handleSubmit(async (values) => {
        setError("");
        try {
          onSaved(
            await api.updateVariant(
              updateVariantInput.parse({
                ...values,
                onlineVisible: variant.variantType === "bulk" ? false : values.onlineVisible,
              }),
            ),
          );
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "No se pudo guardar la variante.");
        }
      })}
    >
      <p className="text-sm text-text-secondary">
        La presentación y unidad se conservan. Para cambiarlas, creá otra variante.
      </p>
      <div>
        <label htmlFor="edit-variant-sku" className="mb-1 block text-sm font-semibold">
          SKU
        </label>
        <input id="edit-variant-sku" className={inputClass} {...form.register("sku")} />
        {form.formState.errors.sku && (
          <p role="alert" className="text-error">
            {form.formState.errors.sku.message}
          </p>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Controller
          control={form.control}
          name="pricePyg"
          render={({ field, fieldState }) => (
            <MoneyInput
              id="edit-variant-price"
              label="Precio (Gs.)"
              value={field.value}
              onChange={(value) => field.onChange(value ?? "")}
              onBlur={field.onBlur}
              error={fieldState.error?.message}
            />
          )}
        />
        <Controller
          control={form.control}
          name="compareAtPyg"
          render={({ field, fieldState }) => (
            <MoneyInput
              id="edit-variant-compare"
              label="Precio anterior (Gs.)"
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              error={fieldState.error?.message}
            />
          )}
        />
      </div>
      <div>
        <label htmlFor="edit-variant-vat" className="mb-1 block text-sm font-semibold">
          IVA
        </label>
        <select id="edit-variant-vat" className={inputClass} {...form.register("vatRate")}>
          <option value="iva_10">IVA 10%</option>
          <option value="iva_5">IVA 5%</option>
          <option value="exenta">Exenta</option>
        </select>
      </div>
      {variant.variantType !== "bulk" && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" {...form.register("onlineVisible")} /> Visible en línea
        </label>
      )}
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? "Guardando…" : "Guardar variante"}
        </Button>
      </div>
    </form>
  );
}
