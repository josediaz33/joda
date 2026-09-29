const pygDigits = new Intl.NumberFormat("es-PY", {
  numberingSystem: "latn",
  useGrouping: false,
  maximumFractionDigits: 0,
});

/** Importe PYG en unidades enteras recibido como string desde la API. */
export function formatPyg(minor: string): string {
  if (!/^-?\d+$/.test(minor)) {
    throw new RangeError("El importe PYG debe ser un string de unidades enteras.");
  }

  const amount = BigInt(minor);
  const digits = pygDigits.format(amount < 0n ? -amount : amount);
  // El símbolo, el espacio y el separador de es-PY difieren entre versiones de ICU.
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${amount < 0n ? "-" : ""}Gs. ${grouped}`;
}
