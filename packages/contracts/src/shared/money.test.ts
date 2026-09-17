import { describe, expect, it } from "vitest";
import { moneySchema } from "./money.js";

describe("moneySchema — dinero como string en la frontera (api-conventions.md §3)", () => {
  it("acepta un importe con minor en formato string", () => {
    expect(moneySchema.parse({ minor: "245000", currency: "PYG" })).toEqual({
      minor: "245000",
      currency: "PYG",
    });
  });

  it("acepta un minor negativo, para una nota de crédito", () => {
    expect(() => moneySchema.parse({ minor: "-1000", currency: "PYG" })).not.toThrow();
  });

  it("rechaza minor como number: el dinero no cruza la frontera como number", () => {
    expect(() => moneySchema.parse({ minor: 245000, currency: "PYG" })).toThrow();
  });

  it("rechaza una moneda no soportada", () => {
    expect(() => moneySchema.parse({ minor: "1000", currency: "EUR" })).toThrow();
  });

  it("rechaza campos no declarados (.strict())", () => {
    expect(() => moneySchema.parse({ minor: "245000", currency: "PYG", role: "owner" })).toThrow();
  });
});
