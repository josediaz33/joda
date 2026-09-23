import { describe, expect, it } from "vitest";
import { createAdjustmentInput, movementIdSchema } from "./inventory.js";

describe("inventory — movementIdSchema (docs/api-conventions.md §3, bigint identity como string)", () => {
  it("acepta un entero positivo en formato string", () => {
    expect(() => movementIdSchema.parse("42")).not.toThrow();
  });

  it("rechaza un negativo — inventory_movements.id es GENERATED ALWAYS AS IDENTITY, siempre positivo", () => {
    expect(() => movementIdSchema.parse("-1")).toThrow();
  });

  it("rechaza un number crudo — tiene que viajar como string (bigint no sobrevive JSON.stringify)", () => {
    expect(() => movementIdSchema.parse(42)).toThrow();
  });
});

describe("inventory — createAdjustmentInput (RF-INV-04, motivo obligatorio)", () => {
  const base = { lotId: "11111111-1111-4111-a111-111111111111" };

  it("qty en cero se rechaza — un ajuste sin cambio no es un ajuste", () => {
    expect(() => createAdjustmentInput.parse({ ...base, qty: 0, reason: "recuento" })).toThrow();
  });

  it("reason vacío se rechaza — el motivo es obligatorio", () => {
    expect(() => createAdjustmentInput.parse({ ...base, qty: -5, reason: "" })).toThrow();
  });

  it("reason con solo espacios se rechaza — .trim() antes de min(1)", () => {
    expect(() => createAdjustmentInput.parse({ ...base, qty: -5, reason: "   " })).toThrow();
  });

  it("un campo no declarado se rechaza (.strict())", () => {
    expect(() =>
      createAdjustmentInput.parse({ ...base, qty: -5, reason: "rotura", uom: "ml" }),
    ).toThrow();
  });

  it("qty negativo con motivo no vacío se acepta", () => {
    expect(() =>
      createAdjustmentInput.parse({ ...base, qty: -5, reason: "rotura en depósito" }),
    ).not.toThrow();
  });

  it("qty positivo (recuento halló más stock) se acepta", () => {
    expect(() =>
      createAdjustmentInput.parse({ ...base, qty: 3, reason: "conteo físico" }),
    ).not.toThrow();
  });

  it("qty con más de 3 decimales se rechaza — mismo límite que Quantity.ml", () => {
    expect(() =>
      createAdjustmentInput.parse({ ...base, qty: -12.5001, reason: "rotura" }),
    ).toThrow();
  });

  it("qty con exactamente 3 decimales se acepta", () => {
    expect(() =>
      createAdjustmentInput.parse({ ...base, qty: -12.501, reason: "rotura" }),
    ).not.toThrow();
  });
});
