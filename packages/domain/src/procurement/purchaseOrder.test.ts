import { describe, expect, it } from "vitest";
import {
  canTransitionPurchaseOrder,
  transitionPurchaseOrder,
  type PoStatus,
} from "./purchaseOrder.js";

// Matriz completa: los 7 estados de po_status (packages/db/migrations/
// 0001_foundation.sql) contra sí mismos, 7×7 = 49 pares. Cada fila es la
// regla escrita literal, tomada de docs/domain-rules.md RN-EST-01 — no hay
// forma de "calcular" el valor esperado sin repetir la regla, así que se
// transcribe una por una.
describe("RN-EST-01 · orden de compra — matriz completa de transiciones", () => {
  it.each([
    ["draft", "draft", false],
    ["draft", "pending_approval", true],
    ["draft", "approved", false],
    ["draft", "sent", false],
    ["draft", "partially_received", false],
    ["draft", "received", false],
    ["draft", "cancelled", true],
    ["pending_approval", "draft", true],
    ["pending_approval", "pending_approval", false],
    ["pending_approval", "approved", true],
    ["pending_approval", "sent", false],
    ["pending_approval", "partially_received", false],
    ["pending_approval", "received", false],
    ["pending_approval", "cancelled", true],
    ["approved", "draft", false],
    ["approved", "pending_approval", false],
    ["approved", "approved", false],
    ["approved", "sent", true],
    ["approved", "partially_received", false],
    ["approved", "received", false],
    ["approved", "cancelled", true],
    ["sent", "draft", false],
    ["sent", "pending_approval", false],
    ["sent", "approved", false],
    ["sent", "sent", false],
    ["sent", "partially_received", true],
    ["sent", "received", true],
    ["sent", "cancelled", true],
    ["partially_received", "draft", false],
    ["partially_received", "pending_approval", false],
    ["partially_received", "approved", false],
    ["partially_received", "sent", false],
    ["partially_received", "partially_received", true],
    ["partially_received", "received", true],
    ["partially_received", "cancelled", false],
    ["received", "draft", false],
    ["received", "pending_approval", false],
    ["received", "approved", false],
    ["received", "sent", false],
    ["received", "partially_received", false],
    ["received", "received", false],
    ["received", "cancelled", false],
    ["cancelled", "draft", false],
    ["cancelled", "pending_approval", false],
    ["cancelled", "approved", false],
    ["cancelled", "sent", false],
    ["cancelled", "partially_received", false],
    ["cancelled", "received", false],
    ["cancelled", "cancelled", false],
  ] satisfies [PoStatus, PoStatus, boolean][])("%s → %s es %s", (from, to, expected) => {
    expect(canTransitionPurchaseOrder(from, to)).toBe(expected);
  });
});

describe("RN-EST-01 · orden de compra — partially_received no admite cancelled", () => {
  it("ya entró mercadería: cancelar una OC parcialmente recibida no es una transición válida", () => {
    expect(canTransitionPurchaseOrder("partially_received", "cancelled")).toBe(false);
  });

  it("received tampoco admite cancelled: es un estado terminal", () => {
    expect(canTransitionPurchaseOrder("received", "cancelled")).toBe(false);
  });

  it("pending_approval sí puede volver a draft — rechazo del aprobador, sin pasar por cancelled", () => {
    expect(canTransitionPurchaseOrder("pending_approval", "draft")).toBe(true);
  });
});

describe("RN-EST-01 · transitionPurchaseOrder — Result, no excepción", () => {
  it("una transición válida devuelve ok() con el estado destino", () => {
    expect(transitionPurchaseOrder("draft", "pending_approval")).toEqual({
      ok: true,
      value: "pending_approval",
    });
  });

  it("una transición inválida devuelve err() con el código INVALID_TRANSITION, sin lanzar", () => {
    expect(transitionPurchaseOrder("received", "cancelled")).toEqual({
      ok: false,
      error: { code: "INVALID_TRANSITION", from: "received", to: "cancelled" },
    });
  });
});
