import type { SaleOrderReservationDto } from "@joda/contracts";
import type { ReservationRow } from "./repository.js";

export function toSaleOrderReservation(row: ReservationRow): SaleOrderReservationDto {
  return {
    id: row.id,
    variantId: row.variant_id,
    serialUnitId: row.serial_unit_id,
    qty: row.qty.toString(),
    reason: row.reason,
    expiresAt: row.expires_at.toISOString(),
    releasedAt: row.released_at?.toISOString() ?? null,
  };
}
