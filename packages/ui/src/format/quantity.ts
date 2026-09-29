export type QuantityUom = "ml" | "unit";

const mlFormatter = new Intl.NumberFormat("es-PY", {
  numberingSystem: "latn",
  maximumFractionDigits: 3,
});
const unitFormatter = new Intl.NumberFormat("es-PY", {
  numberingSystem: "latn",
  maximumFractionDigits: 0,
});

/** Presenta cantidades ya validadas por el dominio, sin redondear un dato inválido. */
export function formatQuantity(value: number, uom: QuantityUom): string {
  if (!Number.isFinite(value)) {
    throw new RangeError("La cantidad debe ser finita.");
  }
  if (uom === "unit" && !Number.isInteger(value)) {
    throw new RangeError("Las unidades deben ser enteras.");
  }
  if (uom === "ml" && Math.abs(value * 1000 - Math.round(value * 1000)) > 1e-9) {
    throw new RangeError("Los mililitros admiten hasta tres decimales.");
  }

  const parts = (uom === "ml" ? mlFormatter : unitFormatter).formatToParts(value);
  const amount = parts
    .map((part) => (part.type === "group" ? "." : part.type === "decimal" ? "," : part.value))
    .join("");
  return uom === "ml" ? `${amount} ml` : `${amount} ${value === 1 ? "unidad" : "unidades"}`;
}
