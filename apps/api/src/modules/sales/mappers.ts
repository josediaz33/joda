import type { SaleOrderDto } from "@joda/contracts";
import type { SaleOrderRow } from "./repository.js";

export function toSaleOrder(row: SaleOrderRow): SaleOrderDto {
  return {
    id: row.id,
    channelId: row.channel_id,
    customerId: row.customer_id,
    code: row.code,
    status: row.status,
    subtotalPyg: row.subtotal_pyg.toString(),
    discountPyg: row.discount_pyg.toString(),
    shippingPyg: row.shipping_pyg.toString(),
    totalPyg: row.total_pyg.toString(),
    vat10Pyg: row.vat_10_pyg.toString(),
    vat5Pyg: row.vat_5_pyg.toString(),
    exemptPyg: row.exempt_pyg.toString(),
    notes: row.notes,
    placedAt: row.placed_at?.toISOString() ?? null,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lines: row.sale_order_lines.map((line) => ({
      id: line.id,
      variantId: line.variant_id,
      serialUnitId: line.serial_unit_id,
      qty: line.qty.toString(),
      uom: line.uom,
      unitPricePyg: line.unit_price_pyg.toString(),
      discountPyg: line.discount_pyg.toString(),
      lineTotalPyg: line.line_total_pyg.toString(),
      vatRate: line.vat_rate,
      vatPyg: line.vat_pyg.toString(),
      position: line.position,
    })),
    transitions: row.sale_order_transitions.map((transition) => ({
      id: transition.id.toString(),
      fromStatus: transition.from_status,
      toStatus: transition.to_status,
      actorId: transition.actor_id,
      audience: transition.audience,
      reason: transition.reason,
      occurredAt: transition.occurred_at.toISOString(),
    })),
  };
}
