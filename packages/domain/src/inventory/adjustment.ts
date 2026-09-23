// Ajuste manual de inventario (RF-INV-04; docs/domain-rules.md, catálogo de
// casos borde #16: "Ajuste de inventario que dejaría saldo negativo → Rechazar.
// El saldo nunca es negativo."). A diferencia de allocation.ts/costing.ts
// (selección de lotes POR POLÍTICA, para una salida que puede tocar varios
// lotes), un ajuste manual ya viene anclado a UN lote explícito — el que el
// depósito recontó — así que no hay política que aplicar ni varias capas que
// construir: como mucho, una.
import { Money } from "../shared/money.js";
import type { Quantity } from "../shared/quantity.js";
import { err, ok, type Result } from "../shared/result.js";
import type { CostLayer } from "./costing.js";

export interface PlanInventoryAdjustmentInput {
  readonly lotId: string;
  readonly currentOnHand: Quantity;
  /** Con signo: positivo halló más stock que el proyectado, negativo halló menos. */
  readonly delta: Quantity;
  /** `unit_landed_cost_pyg` del lote — el costo ya puesto, nunca se recalcula acá. */
  readonly unitCost: Money;
}

export type InventoryAdjustmentError = {
  readonly code: "NEGATIVE_BALANCE";
  readonly resulting: Quantity;
};

export interface InventoryAdjustmentPlan {
  readonly resulting: Quantity;
  /**
   * Capa de costo a registrar en `movement_cost_allocations` — solo cuando
   * el ajuste ES una salida (`delta` negativo). Un ajuste positivo no
   * consume ninguna capa: ADR-008 define las capas como "qué lote consumió
   * cada SALIDA", y encontrar más stock del proyectado no consume nada.
   */
  readonly costLayer: CostLayer | null;
  /**
   * `total_cost_pyg` del movimiento, con el mismo signo que `delta` — `null`
   * cuando el ajuste no tiene costo que registrar (positivo).
   */
  readonly totalCost: Money | null;
}

/**
 * Caso borde #16 · calcula el saldo resultante y, si el ajuste es una salida
 * (`delta` negativo), la única capa de costo que necesita (RN-COS-05,
 * ADR-008: la suma de las capas de un movimiento tiene que igualar su costo
 * declarado — acá la suma es, trivialmente, esa única capa). Rechaza con
 * `Result` cuando el saldo resultante sería negativo: es un fallo que el
 * negocio contempla (alguien puede pedir de más un ajuste), no un bug.
 */
export function planInventoryAdjustment(
  input: PlanInventoryAdjustmentInput,
): Result<InventoryAdjustmentPlan, InventoryAdjustmentError> {
  const resulting = input.currentOnHand.plus(input.delta);
  if (resulting.isNegative()) {
    return err({ code: "NEGATIVE_BALANCE", resulting });
  }

  if (!input.delta.isNegative()) {
    return ok({ resulting, costLayer: null, totalCost: null });
  }

  const qtyOut = input.delta.times(-1);
  const totalCostOut = input.unitCost.times(qtyOut.value);
  return ok({
    resulting,
    costLayer: {
      lotId: input.lotId,
      qty: qtyOut,
      unitCost: input.unitCost,
      totalCost: totalCostOut,
    },
    totalCost: Money.of(-totalCostOut.minor, totalCostOut.currency),
  });
}
