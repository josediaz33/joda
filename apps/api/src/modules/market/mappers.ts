import type { PurchaseOrderDto, SupplierDto } from "@joda/contracts";
import type { PurchaseOrderRow, SupplierRow } from "./repository.js";

export function toSupplier(row: SupplierRow): SupplierDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    country: row.country,
    defaultCurrency: row.default_currency as SupplierDto["defaultCurrency"],
    paymentTermsDays: row.payment_terms_days,
    leadTimeDays: row.lead_time_days,
    isActive: row.is_active,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toPurchaseOrder(row: PurchaseOrderRow): PurchaseOrderDto {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    code: row.code,
    status: row.status,
    currency: row.currency as PurchaseOrderDto["currency"],
    fxRateToPyg: row.fx_rate_to_pyg?.toString() ?? null,
    freightMinor: row.freight_minor.toString(),
    customsMinor: row.customs_minor.toString(),
    otherCostsMinor: row.other_costs_minor.toString(),
    freightMethod: row.freight_method,
    expectedAt: row.expected_at?.toISOString().slice(0, 10) ?? null,
    notes: row.notes,
    createdBy: row.created_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lines: row.purchase_order_lines.map((line) => ({
      id: line.id,
      variantId: line.variant_id,
      qtyOrdered: line.qty_ordered.toString(),
      qtyReceived: line.qty_received.toString(),
      uom: line.uom,
      unitPriceMinor: line.unit_price_minor.toString(),
      destination: line.destination,
      position: line.position,
    })),
    transitions: row.purchase_order_transitions.map((transition) => ({
      id: transition.id.toString(),
      fromStatus: transition.from_status,
      toStatus: transition.to_status,
      actorId: transition.actor_id,
      reason: transition.reason,
      occurredAt: transition.occurred_at.toISOString(),
    })),
  };
}
