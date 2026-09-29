const asuncionDate = new Intl.DateTimeFormat("es-PY", {
  timeZone: "America/Asuncion",
  numberingSystem: "latn",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const calendarDatePattern = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.0+)?Z)?$/;
const instantPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

function assertCalendarDate(year: number, month: number, day: number): void {
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]!) {
    throw new RangeError("La fecha calendario debe ser válida.");
  }
}

/** Fecha SQL date: YYYY-MM-DD o el ISO de medianoche UTC que emite Prisma para @db.Date. */
export function formatCalendarDate(value: string): string {
  const match = calendarDatePattern.exec(value);
  if (!match) {
    throw new RangeError("La fecha calendario debe ser YYYY-MM-DD o ISO de medianoche UTC.");
  }
  const [, year, month, day] = match;
  assertCalendarDate(Number(year), Number(month), Number(day));
  return `${day}/${month}/${year}`;
}

/** Fecha de un instante (timestamptz), convertida a America/Asuncion. */
export function formatInstantDate(value: Date | string): string {
  if (typeof value === "string") {
    const match = instantPattern.exec(value);
    if (!match) {
      throw new RangeError("El instante debe ser ISO con zona horaria u offset.");
    }
    assertCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) {
      throw new RangeError("La hora del instante debe ser válida.");
    }
  }

  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("El instante debe ser válido.");
  }

  const parts = asuncionDate.formatToParts(date);
  const day = parts.find((part) => part.type === "day")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const year = parts.find((part) => part.type === "year")?.value;
  return `${day}/${month}/${year}`;
}
