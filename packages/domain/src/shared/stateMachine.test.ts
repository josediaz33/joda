import { describe, expect, it } from "vitest";
import { defineStateMachine } from "./stateMachine.js";

// Motor genérico — docs/domain-contracts.md §6.5. Las tres máquinas
// concretas (procurement/purchaseOrder.ts, sales/order.ts,
// decant/workOrder.ts) ya cubren esto exhaustivamente con sus propios
// estados; acá se prueba el motor aislado, con un estado sintético de tres
// nodos, para no depender de ningún RN-XXX concreto.
type Light = "red" | "yellow" | "green";

const TRAFFIC_LIGHT = {
  red: ["green"],
  green: ["yellow"],
  yellow: ["red"],
} as const satisfies Record<Light, readonly Light[]>;

describe("defineStateMachine — docs/domain-contracts.md §6.5", () => {
  const machine = defineStateMachine<Light>(TRAFFIC_LIGHT);

  it("canTransition es true para un par presente en el mapa", () => {
    expect(machine.canTransition("red", "green")).toBe(true);
  });

  it("canTransition es false para un par ausente del mapa", () => {
    expect(machine.canTransition("red", "yellow")).toBe(false);
  });

  it("canTransition es false incluso para el propio estado, si no está en su lista", () => {
    expect(machine.canTransition("red", "red")).toBe(false);
  });

  it("transition() de un par válido devuelve ok() con el estado destino", () => {
    expect(machine.transition("red", "green")).toEqual({ ok: true, value: "green" });
  });

  it("transition() de un par inválido devuelve err() con INVALID_TRANSITION, sin lanzar", () => {
    expect(machine.transition("red", "yellow")).toEqual({
      ok: false,
      error: { code: "INVALID_TRANSITION", from: "red", to: "yellow" },
    });
  });

  it("un estado con lista vacía no admite ninguna transición", () => {
    const terminal = defineStateMachine<Light>({ red: [], green: [], yellow: [] });

    expect(terminal.canTransition("red", "green")).toBe(false);
  });
});
