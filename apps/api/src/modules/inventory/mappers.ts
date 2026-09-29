import type {
  AdminLot,
  AdminMovement,
  AdminSerializedUnit,
  MoneyDto,
  StockAvailability,
} from "@joda/contracts";
import type {
  LotWithBalanceRow,
  MovementRow,
  SerializedUnitRow,
  StockAvailabilityRow,
} from "./repository.js";

// Fila de base → DTO (docs/api-conventions.md §1, mismo criterio que
// modules/catalog/mappers.ts): solo conversión de tipo — Decimal → number,
// BigInt → string, Date → ISO string —, ninguna regla de negocio acá.
function toDecimalNumber(value: { toNumber(): number } | null | undefined): number {
  return value ? value.toNumber() : 0;
}

export function toStockAvailability(
  variantId: string,
  row: StockAvailabilityRow | null,
): StockAvailability {
  return {
    variantId,
    onHand: toDecimalNumber(row?.on_hand),
    reserved: toDecimalNumber(row?.reserved),
    available: toDecimalNumber(row?.available),
  };
}

export function toAdminLot(row: LotWithBalanceRow): AdminLot {
  return {
    id: row.id,
    variantId: row.variant_id,
    lotCode: row.lot_code,
    batchCode: row.batch_code,
    parentLotId: row.parent_lot_id,
    status: row.status,
    uom: row.uom,
    qtyInitial: row.qty_initial.toNumber(),
    onHand: toDecimalNumber(row.inventory_balances?.on_hand),
    unitCost: {
      minor: row.unit_cost_minor.toString(),
      currency: row.currency as MoneyDto["currency"],
    },
    fxRateToPyg: row.fx_rate_to_pyg.toNumber(),
    landedCostPyg: row.landed_cost_pyg.toString(),
    unitLandedCostPyg: row.unit_landed_cost_pyg.toString(),
    manufacturedAt: row.manufactured_at?.toISOString() ?? null,
    expiryAt: row.expiry_at?.toISOString() ?? null,
    openedAt: row.opened_at?.toISOString() ?? null,
    receivedAt: row.received_at.toISOString(),
  };
}

export function toAdminMovement(row: MovementRow): AdminMovement {
  return {
    id: row.id.toString(),
    lotId: row.lot_id,
    variantId: row.variant_id,
    serialUnitId: row.serial_unit_id,
    qty: row.qty.toNumber(),
    uom: row.uom,
    movementType: row.movement_type,
    totalCostPyg: row.total_cost_pyg?.toString() ?? null,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    occurredAt: row.occurred_at.toISOString(),
    createdBy: row.created_by,
    note: row.note,
  };
}

export function toAdminSerializedUnit(row: SerializedUnitRow): AdminSerializedUnit {
  return {
    id: row.id,
    variantId: row.variant_id,
    lotId: row.lot_id,
    serialNumber: row.serial_number,
    status: row.status,
    // `warranty_until` es `date`: Prisma lo trae como medianoche UTC.
    warrantyUntil: row.warranty_until?.toISOString().slice(0, 10) ?? null,
    soldOrderLineId: row.sold_order_line_id,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
  };
}
