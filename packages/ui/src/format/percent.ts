const percentFormatter = new Intl.NumberFormat("es-PY", {
  numberingSystem: "latn",
  maximumFractionDigits: 3,
  minimumFractionDigits: 0,
});

/** Porcentaje ya calculado por el dominio (19,7 = 19,7%) — puede ser negativo (RN-SRC-02: una línea en pérdida). */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError("El porcentaje debe ser finito.");
  }

  return `${percentFormatter.format(value)}%`;
}
