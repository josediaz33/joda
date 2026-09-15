import { describe, expect, it } from "vitest";
import {
  canTransitionDecantWorkOrder,
  transitionDecantWorkOrder,
  type DecantWoStatus,
} from "./workOrder.js";

// Matriz completa: los 4 estados de decant_wo_status (packages/db/
// migrations/0001_foundation.sql) contra sí mismos, 4×4 = 16 pares. Cada
// fila es la regla escrita literal, tomada de docs/domain-rules.md
// RN-EST-03.
describe("RN-EST-03 · orden de fraccionamiento — matriz completa de transiciones", () => {
  it.each([
    ["pending", "pending", false],
    ["pending", "in_progress", true],
    ["pending", "done", false],
    ["pending", "cancelled", true],
    ["in_progress", "pending", false],
    ["in_progress", "in_progress", false],
    ["in_progress", "done", true],
    ["in_progress", "cancelled", true],
    ["done", "pending", false],
    ["done", "in_progress", false],
    ["done", "done", false],
    ["done", "cancelled", false],
    ["cancelled", "pending", false],
    ["cancelled", "in_progress", false],
    ["cancelled", "done", false],
    ["cancelled", "cancelled", false],
  ] satisfies [DecantWoStatus, DecantWoStatus, boolean][])(
    "%s → %s es %s",
    (from, to, expected) => {
      expect(canTransitionDecantWorkOrder(from, to)).toBe(expected);
    },
  );
});

describe("RN-EST-03 · orden de fraccionamiento — done es terminal", () => {
  it("done no admite cancelled: los movimientos de la ejecución ya están en el ledger append-only (RN-FRA-03)", () => {
    expect(canTransitionDecantWorkOrder("done", "cancelled")).toBe(false);
  });

  it("in_progress sí admite cancelled: todavía no se ejecutó el fraccionamiento", () => {
    expect(canTransitionDecantWorkOrder("in_progress", "cancelled")).toBe(true);
  });
});

describe("RN-EST-03 · transitionDecantWorkOrder — Result, no excepción", () => {
  it("una transición válida devuelve ok() con el estado destino", () => {
    expect(transitionDecantWorkOrder("pending", "in_progress")).toEqual({
      ok: true,
      value: "in_progress",
    });
  });

  it("una transición inválida devuelve err() con el código INVALID_TRANSITION, sin lanzar", () => {
    expect(transitionDecantWorkOrder("done", "cancelled")).toEqual({
      ok: false,
      error: { code: "INVALID_TRANSITION", from: "done", to: "cancelled" },
    });
  });
});
