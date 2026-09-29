const asuncionDate = new Intl.DateTimeFormat("es-PY", {
  timeZone: "America/Asuncion",
  numberingSystem: "latn",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/** Fecha de un instante; los strings ISO deben incluir zona u offset. */
export function formatDate(value: Date | string): string {
  if (typeof value === "string" && !/T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new RangeError("La fecha debe incluir zona horaria u offset.");
  }
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("La fecha debe ser válida.");
  }

  const parts = asuncionDate.formatToParts(date);
  const day = parts.find((part) => part.type === "day")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const year = parts.find((part) => part.type === "year")?.value;
  return `${day}/${month}/${year}`;
}
