import type { AdminDecantWorkOrder, DecantQueueGroup } from "@joda/contracts";
import type { DecantWorkOrderRow, QueueOrderRow } from "./repository.js";

// Fila de base → DTO (docs/api-conventions.md §1, mismo criterio que
// modules/inventory/mappers.ts): solo conversión de tipo — Decimal → number,
// Date → ISO string —, ninguna regla de negocio acá. La única cuenta es la
// agrupación de la cola (RF-FRA-06), que es presentación, no una regla.
export function toAdminDecantWorkOrder(row: DecantWorkOrderRow): AdminDecantWorkOrder {
  return {
    id: row.id,
    saleOrderId: row.sale_order_id,
    sourceLotId: row.source_lot_id,
    targetVariantId: row.target_variant_id,
    qtyUnits: row.qty_units,
    mlPerUnit: row.ml_per_unit.toNumber(),
    mlExpected: row.ml_expected.toNumber(),
    wasteExpected: row.waste_expected.toNumber(),
    wasteActual: row.waste_actual?.toNumber() ?? null,
    status: row.status,
    executedBy: row.executed_by,
    executedAt: row.executed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
  };
}

// Los ml tienen hasta 3 decimales: se suman en milésimas ENTERAS para que la
// suma de la cola no arrastre el error de coma flotante de 0,1 + 0,2.
const ML_SCALE = 1000;

function toThousandths(ml: number): number {
  return Math.round(ml * ML_SCALE);
}

/**
 * RF-FRA-06 · agrupa las órdenes por frasco de origen. Las agrupaciones van
 * de la apertura más antigua a la más nueva (el id desempata; un frasco sin
 * `opened_at` iría al final), y dentro de cada una las órdenes conservan el
 * orden de llegada de la consulta: más antigua primero.
 */
export function toDecantQueueGroups(rows: readonly QueueOrderRow[]): DecantQueueGroup[] {
  const byLot = new Map<string, QueueOrderRow[]>();
  for (const row of rows) {
    const group = byLot.get(row.source_lot_id);
    if (group) group.push(row);
    else byLot.set(row.source_lot_id, [row]);
  }

  const groups = [...byLot.values()].map((orders) => {
    const lot = orders[0]!.inventory_lots;
    const committedThousandths = orders.reduce(
      (sum, order) =>
        sum +
        toThousandths(order.ml_expected.toNumber()) +
        toThousandths(order.waste_expected.toNumber()),
      0,
    );
    return {
      sourceLotId: lot.id,
      sourceLotCode: lot.lot_code,
      openedAt: lot.opened_at?.toISOString() ?? null,
      onHandMl: lot.inventory_balances?.on_hand.toNumber() ?? 0,
      committedMl: committedThousandths / ML_SCALE,
      orders: orders.map(toAdminDecantWorkOrder),
    };
  });

  return groups.sort((a, b) => {
    if (a.openedAt !== b.openedAt) {
      if (a.openedAt === null) return 1;
      if (b.openedAt === null) return -1;
      return a.openedAt < b.openedAt ? -1 : 1;
    }
    return a.sourceLotId < b.sourceLotId ? -1 : a.sourceLotId > b.sourceLotId ? 1 : 0;
  });
}
