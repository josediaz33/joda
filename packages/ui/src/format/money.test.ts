import { describe, expect, it } from "vitest";
import { formatPyg } from "./money";

describe("frontend-spec.md §4 · presentación de guaraníes", () => {
  it("usa el prefijo y los puntos exigidos, con espacio normal", () => {
    expect(formatPyg("245000")).toBe("Gs. 245.000");
    expect(formatPyg("0")).toBe("Gs. 0");
    expect(formatPyg("-245000")).toBe("-Gs. 245.000");
  });

  it("conserva los dígitos que exceden la precisión segura de Number", () => {
    expect(formatPyg("9007199254740993")).toBe("Gs. 9.007.199.254.740.993");
  });

  it("rechaza strings que no representan unidades enteras", () => {
    expect(() => formatPyg("")).toThrow(RangeError);
    expect(() => formatPyg("245000.5")).toThrow(RangeError);
  });
});
