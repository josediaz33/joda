import { describe, expect, it } from "vitest";
import { formatCalendarDate, formatInstantDate } from "./date";

describe("frontend-spec.md §4 · fechas en America/Asuncion", () => {
  it("conserva una fecha calendario del DTO de inventario", () => {
    expect(formatCalendarDate("2025-01-01T00:00:00.000Z")).toBe("01/01/2025");
    expect(formatCalendarDate("2025-01-01")).toBe("01/01/2025");
  });

  it("usa UTC−3 en enero luego del cambio legal de 2024", () => {
    expect(formatInstantDate("2025-01-01T03:30:00Z")).toBe("01/01/2025");
    expect(formatInstantDate("2025-01-01T02:30:00Z")).toBe("31/12/2024");
  });

  it("usa UTC−3 también en julio", () => {
    expect(formatInstantDate(new Date("2025-07-01T03:30:00Z"))).toBe("01/07/2025");
    expect(formatInstantDate("2025-07-01T02:30:00Z")).toBe("30/06/2025");
  });

  it("rechaza fechas calendario imposibles y representaciones ambiguas", () => {
    expect(() => formatCalendarDate("2025-02-30")).toThrow(RangeError);
    expect(() => formatCalendarDate("2025-02-30T00:00:00.000Z")).toThrow(RangeError);
    expect(() => formatCalendarDate("2025-01-01T03:00:00.000Z")).toThrow(RangeError);
  });

  it("rechaza instantes sin zona y fechas imposibles", () => {
    expect(() => formatInstantDate("2025-01-01")).toThrow(RangeError);
    expect(() => formatInstantDate("2025-01-01T03:30:00")).toThrow(RangeError);
    expect(() => formatInstantDate("2025-02-30T12:00:00Z")).toThrow(RangeError);
    expect(() => formatInstantDate(new Date(Number.NaN))).toThrow(RangeError);
  });
});
