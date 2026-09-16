// Máquina de estados de la orden de compra (WP-A08; docs/domain-contracts.md
// §6.5, docs/domain-rules.md RN-EST-01, GLOSARIO.md "Orden de compra / OC").
//
// Camino feliz:
//   draft → pending_approval → approved → sent → partially_received → received
//
// `pending_approval` puede volver a `draft` (rechazo del aprobador para
// corrección) sin pasar por `cancelled`. `partially_received` puede
// repetirse a sí mismo: una OC puede llegar en varias tandas (ver
// `goods_receipts`, packages/db/migrations/0005_procurement.sql) sin cambiar
// de estado entre una y otra.
//
// Cancelable solo hasta `sent`. Ni `partially_received` ni `received`
// admiten `cancelled`: ya entró mercadería y hay lotes creados a partir de
// la recepción (RN-EST-01). Revertir una OC que ya recibió algo es una
// devolución a proveedor, no una cancelación de la orden — y eso no es
// responsabilidad de esta máquina.
import { defineStateMachine, type TransitionError } from "../shared/stateMachine.js";

export type PoStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "sent"
  | "partially_received"
  | "received"
  | "cancelled";

export const PURCHASE_ORDER_TRANSITIONS: Readonly<Record<PoStatus, readonly PoStatus[]>> = {
  draft: ["pending_approval", "cancelled"],
  pending_approval: ["approved", "draft", "cancelled"],
  approved: ["sent", "cancelled"],
  sent: ["partially_received", "received", "cancelled"],
  partially_received: ["partially_received", "received"],
  received: [],
  cancelled: [],
};

const machine = defineStateMachine(PURCHASE_ORDER_TRANSITIONS);

// docs/domain-contracts.md §6.5 nombra estas funciones `canTransition` /
// `transition` a secas. Acá llevan el sufijo `PurchaseOrder` porque
// packages/domain/src/index.ts junta procurement/, sales/ y decant/ en un
// solo barrel con `export *`, y las tres máquinas de WP-A08 necesitarían el
// mismo nombre —colisión que el compilador rechaza—. Mismo criterio en
// sales/order.ts y decant/workOrder.ts.
export const canTransitionPurchaseOrder = machine.canTransition;
export const transitionPurchaseOrder = machine.transition;
export type PurchaseOrderTransitionError = TransitionError<PoStatus>;
