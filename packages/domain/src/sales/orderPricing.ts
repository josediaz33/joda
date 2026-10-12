// Armado de un pedido de venta: líneas, subtotal, total e IVA (WP-C17;
// docs/domain-rules.md RN-VTA-01, RN-IVA-01…04, caso borde 19). Junta lo que
// WP-A04 (`tax/vat.ts`) y WP-A09 (`computeSaleOrderTotals`) ya resuelven por
// separado, para que la API no tenga que repetir ninguna cuenta: lee, pide
// esto, y escribe lo que devuelve.
//
// Lo que NO entra, a propósito:
//   · El envío. Una venta de mostrador no lo tiene y ninguna regla dice qué IVA
//     lleva un envío (RN-IVA solo habla de precios de productos). Meterlo
//     obligaría a inventar esa tasa, así que el total se arma con envío cero y
//     el IVA del envío queda como decisión pendiente del checkout (bloque G):
//     `docs/backlog.md`, fila de WP-C17. `computeSaleOrderTotals` ya lo admite
//     cuando se decida.
//   · El descuento por línea (`sale_order_lines.discount_pyg` queda en cero) y
//     cómo se CALCULA un descuento: no hay ninguna regla que lo cubra (ver la
//     nota al tope de `order.ts`). Entra uno solo, a nivel de pedido, ya
//     resuelto desde afuera: es el `discount_pyg` de RN-VTA-01.
import { InvalidSaleOrderInputError } from "../shared/errors.js";
import { Money } from "../shared/money.js";
import type { Quantity } from "../shared/quantity.js";
import { err, ok, type Result } from "../shared/result.js";
import { breakdownDocument, type VatRate } from "../tax/vat.js";
import { computeSaleOrderTotals, type SaleOrderTotalsError } from "./order.js";

/**
 * `Money.allocate` escala cada peso por 1.000.000 antes de repartir
 * (shared/money.ts), y un `number` solo es exacto hasta 2^53. Por encima de
 * este subtotal el reparto del descuento entre líneas dejaría de ser exacto:
 * floor(2^53 / 1.000.000) = 9.007.199.254 Gs. Redondeado hacia abajo a un
 * número que se lee en una factura: nueve mil millones. Es un límite técnico,
 * no comercial — ninguna venta de mostrador se le acerca.
 */
export const SALE_ORDER_MAX_SUBTOTAL_PYG = 9_000_000_000n;

export interface SaleOrderLineDraft {
  /** Precio de lista por unidad vendida, con IVA incluido (RN-IVA-01). */
  readonly unitPrice: Money;
  /** Unidades vendidas: un entero positivo. Para un decant, cantidad de decants, no de ml. */
  readonly qty: Quantity;
  readonly vatRate: VatRate;
}

export interface PricedSaleOrderLine {
  /** `qty × unitPrice`, antes del descuento del pedido: lo que se guarda en `sale_order_lines.line_total_pyg`. */
  readonly lineTotalPyg: Money;
  /** IVA contenido en lo que el cliente paga por esta línea, ya con el descuento y con el ajuste de redondeo de RN-IVA-03. */
  readonly vatPyg: Money;
}

export interface PricedSaleOrder {
  readonly lines: readonly PricedSaleOrderLine[];
  readonly subtotalPyg: Money;
  readonly discountPyg: Money;
  readonly shippingPyg: Money;
  readonly totalPyg: Money;
  /** IVA 10% contenido en el total (`sale_orders.vat_10_pyg`). */
  readonly vat10Pyg: Money;
  /** IVA 5% contenido en el total (`sale_orders.vat_5_pyg`). */
  readonly vat5Pyg: Money;
  /** Monto exento, bruto y ya con el descuento: lo que el documento fiscal declara como exento (`fiscal_documents.exempt_pyg`). */
  readonly exemptPyg: Money;
}

export type SaleOrderPricingError =
  SaleOrderTotalsError | { readonly code: "SUBTOTAL_TOO_LARGE"; readonly subtotalPyg: Money };

function lineTotal(line: SaleOrderLineDraft): Money {
  const units = line.qty.value;
  if (!Number.isInteger(units) || units < 1) {
    throw new InvalidSaleOrderInputError(
      `Una línea de venta lleva un entero positivo de unidades, recibido ${units}.`,
    );
  }
  // Entero por entero: no hay nada que redondear (el redondeo vive en money.ts).
  return Money.pyg(line.unitPrice.minor * BigInt(units));
}

/**
 * El descuento del pedido se reparte entre las líneas en proporción a su
 * importe, por el método del mayor resto (`Money.allocate`, el mismo de todo el
 * sistema): el IVA depende de la tasa de cada línea, así que hay que saber
 * cuánto del descuento le toca a cada una. Si el descuento se lleva todo el
 * subtotal, cada línea se lleva su importe exacto sin pasar por el reparto.
 */
function allocateDiscount(lineTotals: readonly Money[], discount: Money, subtotal: Money): Money[] {
  if (discount.isZero()) return lineTotals.map(() => Money.zero(discount.currency));
  if (discount.compare(subtotal) === 0) return [...lineTotals];
  return discount.allocate(lineTotals.map((total) => Number(total.minor)));
}

/**
 * RN-VTA-01 + RN-IVA-01…04 · `total = subtotal − descuento + envío` y el IVA
 * del pedido, desde las líneas.
 *
 * RN-IVA-02/03: el IVA se resuelve a nivel de documento. Cada línea se toma por
 * lo que realmente paga el cliente (importe menos su parte del descuento), se
 * desglosa con `breakdownDocument` y la diferencia de redondeo va a la última
 * línea de su tasa. El IVA de cada línea suma exactamente el del pedido.
 *
 * Caso borde 19: un descuento que deja el total negativo se rechaza con
 * `NEGATIVE_TOTAL`, nunca se trunca a cero.
 */
export function priceSaleOrder(input: {
  readonly lines: readonly SaleOrderLineDraft[];
  readonly discountPyg: Money;
}): Result<PricedSaleOrder, SaleOrderPricingError> {
  if (input.lines.length === 0) {
    throw new InvalidSaleOrderInputError("Un pedido de venta lleva al menos una línea.");
  }

  const zero = Money.zero("PYG");
  const lineTotals = input.lines.map(lineTotal);
  const subtotalPyg = lineTotals.reduce((sum, total) => sum.plus(total), zero);

  if (subtotalPyg.minor > SALE_ORDER_MAX_SUBTOTAL_PYG) {
    return err({ code: "SUBTOTAL_TOO_LARGE", subtotalPyg });
  }

  const totals = computeSaleOrderTotals({
    subtotalPyg,
    discountPyg: input.discountPyg,
    shippingPyg: zero,
  });
  if (!totals.ok) return err(totals.error);

  const shares = allocateDiscount(lineTotals, input.discountPyg, subtotalPyg);
  const document = breakdownDocument(
    input.lines.map((line, index) => ({
      gross: lineTotals[index]!.minus(shares[index]!),
      rate: line.vatRate,
    })),
  );

  const sumOf = (rate: VatRate, pick: "vat" | "gross"): Money =>
    document.lines
      .filter((line) => line.rate === rate)
      .reduce((sum, line) => sum.plus(line[pick]), zero);

  return ok({
    lines: document.lines.map((line, index) => ({
      lineTotalPyg: lineTotals[index]!,
      vatPyg: line.vat,
    })),
    subtotalPyg,
    discountPyg: input.discountPyg,
    shippingPyg: totals.value.shippingPyg,
    totalPyg: totals.value.totalPyg,
    vat10Pyg: sumOf("iva_10", "vat"),
    vat5Pyg: sumOf("iva_5", "vat"),
    exemptPyg: sumOf("exenta", "gross"),
  });
}
