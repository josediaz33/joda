import { describe, expect, it } from "vitest";
import { formatDate } from "./date";

describe("frontend-spec.md §4 · fechas en America/Asuncion", () => {
  it("usa UTC−3 en enero luego del cambio legal de 2024", () => {
    expect(formatDate("2025-01-01T03:30:00Z")).toBe("01/01/2025");
    expect(formatDate("2025-01-01T02:30:00Z")).toBe("31/12/2024");
  });

  it("usa UTC−3 también en julio", () => {
    expect(formatDate(new Date("2025-07-01T03:30:00Z"))).toBe("01/07/2025");
    expect(formatDate("2025-07-01T02:30:00Z")).toBe("30/06/2025");
  });

  it("rechaza strings sin zona y fechas inválidas", () => {
    expect(() => formatDate("2025-01-01")).toThrow(RangeError);
    expect(() => formatDate("2025-01-01T03:30:00")).toThrow(RangeError);
    expect(() => formatDate(new Date(Number.NaN))).toThrow(RangeError);
  });
});
