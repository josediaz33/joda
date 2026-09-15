// Máquina de estados de la orden de fraccionamiento (WP-A08;
// docs/domain-contracts.md §6.5, docs/domain-rules.md RN-EST-03, RN-FRA-01).
//
// Camino feliz: pending → in_progress → done
//
// Cancelable desde `pending` e `in_progress`. **No** desde `done`: los
// movimientos de la ejecución (RN-FRA-03) ya están en el ledger append-only
// (`inventory_movements`) y son inmutables (RN-EST-03).
//
// Solo el estado. La reserva (planning.ts) y la ejecución con merma real
// (execution.ts) son los otros dos módulos de decant/ — WP-A07, no se tocan
// acá.
import { defineStateMachine, type TransitionError } from "../shared/stateMachine.js";

export type DecantWoStatus = "pending" | "in_progress" | "done" | "cancelled";

export const DECANT_WORK_ORDER_TRANSITIONS: Readonly<
  Record<DecantWoStatus, readonly DecantWoStatus[]>
> = {
  pending: ["in_progress", "cancelled"],
  in_progress: ["done", "cancelled"],
  done: [],
  cancelled: [],
};

const machine = defineStateMachine(DECANT_WORK_ORDER_TRANSITIONS);

/** Ver el comentario homólogo en procurement/purchaseOrder.ts sobre el sufijo `DecantWorkOrder`. */
export const canTransitionDecantWorkOrder = machine.canTransition;
export const transitionDecantWorkOrder = machine.transition;
export type DecantWorkOrderTransitionError = TransitionError<DecantWoStatus>;
