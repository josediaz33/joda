// Motor genérico de máquina de estados (WP-A08; docs/domain-contracts.md
// §6.5). "Transiciones como dato": cada máquina concreta —orden de compra
// (procurement/purchaseOrder.ts), pedido de venta (sales/order.ts), orden de
// fraccionamiento (decant/workOrder.ts)— declara su propio mapa de estado →
// estados alcanzables y usa este motor para las dos preguntas que las tres
// necesitan (¿es válida esta transición?, transicioná o fallá) en vez de
// repetir el mismo `switch` tres veces.
//
// Una transición inválida es un fallo que el negocio contempla —alguien
// intentando aprobar una OC ya cancelada no es un bug, es una acción
// legítima mal dirigida— así que viaja en un `Result`, no como excepción
// (docs/domain-contracts.md §4.1, .claude/rules/domain.md).
import { err, ok, type Result } from "./result.js";

/** El mapa completo es la ÚNICA fuente de verdad: todo estado declarado en `S` necesita su entrada, aunque sea `[]`. */
export type StateTransitions<S extends string> = Readonly<Record<S, readonly S[]>>;

export interface TransitionError<S extends string> {
  readonly code: "INVALID_TRANSITION";
  readonly from: S;
  readonly to: S;
}

export interface StateMachine<S extends string> {
  canTransition(from: S, to: S): boolean;
  transition(from: S, to: S): Result<S, TransitionError<S>>;
}

/**
 * `transitions` es la única fuente de verdad: agregar o quitar una
 * transición es editar el mapa, nunca esta función.
 */
export function defineStateMachine<S extends string>(
  transitions: StateTransitions<S>,
): StateMachine<S> {
  function canTransition(from: S, to: S): boolean {
    return transitions[from].includes(to);
  }

  function transition(from: S, to: S): Result<S, TransitionError<S>> {
    if (!canTransition(from, to)) {
      return err({ code: "INVALID_TRANSITION", from, to });
    }
    return ok(to);
  }

  return { canTransition, transition };
}
