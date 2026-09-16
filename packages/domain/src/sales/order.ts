// Máquina de estados del pedido de venta (WP-A08; docs/domain-contracts.md
// §6.5, §2 mapa de módulos, docs/domain-rules.md RN-EST-02, GLOSARIO.md
// "Pedido").
//
// Camino feliz:
//   draft → awaiting_payment → paid → preparing → ready → shipped → delivered
//
// Cancelable SOLO desde `draft` y `awaiting_payment`: son los dos únicos
// estados donde RN-VTA-02 garantiza que todavía no se tocó el libro de
// inventario. Desde `paid` en adelante ya hubo cobro y, por RN-VTA-02, el
// inventario se consume "al confirmarse el pago" — es decir, en el mismo
// momento en que el pedido ENTRA a `paid`, no después. Para cuando el pedido
// está en `paid`, revertirlo ya no es un no-op: es la anulación de RN-VTA-03
// (movimientos `return_in` de reversión), así que la única salida lateral
// desde `paid` en adelante es `refunded` (alcanzable desde `paid`,
// `preparing`, `ready`, `shipped` y `delivered`), nunca `cancelled`
// (RN-EST-02).
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
    paid: ["preparing", "refunded"],
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
