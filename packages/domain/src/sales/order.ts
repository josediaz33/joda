// Máquina de estados del pedido de venta (WP-A08; docs/domain-contracts.md
// §6.5, §2 mapa de módulos, docs/domain-rules.md RN-EST-02, GLOSARIO.md
// "Pedido").
//
// Camino feliz:
//   draft → awaiting_payment → paid → preparing → ready → shipped → delivered
//
// Cancelable solo desde `draft`, `awaiting_payment` y `paid`: en esos tres
// estados RN-VTA-02 todavía no consumió inventario. Desde `preparing` en
// adelante ya se consumió inventario o se fraccionó, así que la única salida
// lateral es `refunded` (alcanzable desde `paid`, `preparing`, `ready`,
// `shipped` y `delivered`), nunca `cancelled` (RN-EST-02).
//
// Solo la máquina de estados. Totales, descuentos, TTL de reserva y señas
// son `sales/pricing.ts`, `sales/reservation.ts` y `sales/deposit.ts` —
// WP-A09, fuera de alcance acá.
import { defineStateMachine, type TransitionError } from "../shared/stateMachine.js";

export type SaleOrderStatus =
  | "draft"
  | "awaiting_payment"
  | "paid"
  | "preparing"
  | "ready"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "refunded";

export const SALE_ORDER_TRANSITIONS: Readonly<Record<SaleOrderStatus, readonly SaleOrderStatus[]>> =
  {
    draft: ["awaiting_payment", "cancelled"],
    awaiting_payment: ["paid", "cancelled"],
    paid: ["preparing", "cancelled", "refunded"],
    preparing: ["ready", "refunded"],
    ready: ["shipped", "refunded"],
    shipped: ["delivered", "refunded"],
    delivered: ["refunded"],
    cancelled: [],
    refunded: [],
  };

const machine = defineStateMachine(SALE_ORDER_TRANSITIONS);

/** Ver el comentario homólogo en procurement/purchaseOrder.ts sobre el sufijo `SaleOrder`. */
export const canTransitionSaleOrder = machine.canTransition;
export const transitionSaleOrder = machine.transition;
export type SaleOrderTransitionError = TransitionError<SaleOrderStatus>;
