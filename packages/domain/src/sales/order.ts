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
// La máquina de estados y los totales (WP-A09) comparten archivo a
// propósito (ver la nota en la sesión 11 del playbook): TTL de reserva y
// señas sí son archivos aparte, `sales/reservation.ts` y `sales/deposit.ts`.
// "Precio por canal" (docs/domain-contracts.md §2, `sales/pricing.ts`)
// queda fuera de WP-A09: no hay ninguna regla RN-XXX en docs/domain-rules.md
// que lo cubra y el criterio de aceptación del backlog no lo cita —
// `channel_listings.price_override_pyg` (packages/db/migrations/0006_sales.sql)
// es hoy un simple override nullable sin lógica de negocio documentada
// encima. Sin WP asignado todavía en docs/backlog.md — sí está listado como
// módulo futuro en docs/domain-contracts.md §2, así que no es un módulo
// inventado, pero nadie lo tiene tomado.
//
// "Descuentos" en el objetivo de WP-A09 (docs/backlog.md) es lo que valida
// `computeSaleOrderTotals` (que `discountPyg` no deje `total_pyg` negativo),
// no cómo se CALCULA un descuento: no hay ningún RN-XXX de reglas de
// descuento (por volumen, por cliente, por cupón) en docs/domain-rules.md,
// así que `discountPyg` entra como `Money` ya resuelto desde afuera. Es un
// alcance diferido, no una omisión — igual que "precio por canal" arriba,
// no lo inventé porque no hay regla que lo respalde.
import { Money } from "../shared/money.js";
import { err, ok, type Result } from "../shared/result.js";
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

export interface SaleOrderTotalsInput {
  readonly subtotalPyg: Money;
  readonly discountPyg: Money;
  readonly shippingPyg: Money;
}

export interface SaleOrderTotals extends SaleOrderTotalsInput {
  readonly totalPyg: Money;
}

/**
 * Caso borde #19 del catálogo (docs/domain-rules.md): `total_pyg` negativo
 * se rechaza, nunca se trunca a cero. Objeto plano con `code` — igual
 * criterio que `FreightError` (procurement/freight.ts): esto se devuelve
 * dentro de un `Result`, nadie lo lanza.
 */
export type SaleOrderTotalsError = {
  readonly code: "NEGATIVE_TOTAL";
  readonly subtotalPyg: Money;
  readonly discountPyg: Money;
  readonly shippingPyg: Money;
};

/**
 * RN-VTA-01 · `total_pyg = subtotal_pyg − discount_pyg + shipping_pyg`,
 * literal — el IVA lo calcula tax/vat.ts por línea, no esta función
 * ("impuesto por la base": RN-VTA-01 dice explícitamente que el impuesto
 * no es parte de esta fórmula). Mismo constraint que
 * `order_total_consistent` en packages/db/migrations/0006_sales.sql; esta
 * función lo valida ANTES de llegar a la base — el descuento puede superar
 * el subtotal y el total seguir siendo válido si el envío lo compensa, así
 * que lo que se rechaza es `total_pyg < 0`, no "descuento > subtotal" como
 * atajo.
 */
export function computeSaleOrderTotals(
  input: SaleOrderTotalsInput,
): Result<SaleOrderTotals, SaleOrderTotalsError> {
  const totalPyg = input.subtotalPyg.minus(input.discountPyg).plus(input.shippingPyg);

  if (totalPyg.isNegative()) {
    return err({
      code: "NEGATIVE_TOTAL",
      subtotalPyg: input.subtotalPyg,
      discountPyg: input.discountPyg,
      shippingPyg: input.shippingPyg,
    });
  }

  return ok({ ...input, totalPyg });
}
