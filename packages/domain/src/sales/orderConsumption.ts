// Consumo de inventario al confirmar la venta (RF-VTA-05, RF-VTA-06; RN-VTA-02,
// RN-VTA-04, RN-COS-04, RN-COS-05, RN-LOT-05; ADR-008). El pedido pasa a `paid`
// y la mercadería sale: esta función decide DE QUÉ LOTES sale cada línea y a qué
// costo, y devuelve las capas de costo y el COGS de cada línea y del pedido. No
// escribe nada ni lee la base: quien orquesta (apps/api) bloquea las variantes y
// los lotes ANTES de leer el saldo (RN-RES-07) y le pasa lo leído.
//
// QUÉ DECIDE
//   · una línea común consume por la política de la variante (RN-LOT-05: `fifo` o
//     `fefo`), repartida en las capas que haga falta, una por lote tocado
//     (RN-COS-04). El COGS de la línea es la suma de sus capas, sin promedios;
//   · una línea serializada mueve exactamente UNA unidad (RN-VTA-04), la que la
//     línea eligió: el lote de esa unidad, una capa de cantidad 1. La política de
//     la variante no interviene (la unidad se elige, no se calcula);
//   · varias líneas de la misma variante consumen una tras otra, en el orden en
//     que llegan: cada una ve el saldo que dejó la anterior;
//   · el COGS del pedido es la suma del COGS de sus líneas, y por construcción es
//     la suma de TODAS las capas (RN-COS-05: lo que la base verifica por
//     movimiento, acá cuadra por pedido).
//
// QUÉ NO DECIDE
//   · `manual` no tiene a quién preguntar en una venta (la línea no lleva lote
//     elegido) y `serial` sin unidad no tiene qué consumir: ninguna se resuelve
//     sola por id ascendente, se rechazan con `ALLOCATION_NEEDS_LOT_CHOICE`;
//   · los decants bajo pedido NO pasan por acá: no tienen saldo propio y su costo
//     se asienta al ejecutar el fraccionamiento (RN-FRA-03/04). Quien arma la
//     entrada los deja afuera;
//   · el disponible por variante (saldo menos las reservas de OTROS pedidos) lo
//     calcula quien orquesta y entra por `availability`: una reserva ajena no se
//     consume aunque el lote tenga saldo físico.
//
// El redondeo de importes vive en `shared/money.ts`: `CostLayer.totalCost` sale de
// `Money.times`, nunca de una multiplicación acá.
import { InvalidAllocationRequestError } from "../shared/errors.js";
import { Money } from "../shared/money.js";
import type { Quantity } from "../shared/quantity.js";
import { err, ok, type Result } from "../shared/result.js";
import type { AllocationPolicy, LotSnapshot } from "../inventory/allocation.js";
import { allocateFromLots, totalCost, type CostLayer } from "../inventory/costing.js";
import type { VariantAvailability } from "./orderReservation.js";

/** Un lote que la venta puede consumir: el snapshot de siempre más la variante a la que pertenece. */
export interface SaleLotSnapshot extends LotSnapshot {
  readonly variantId: string;
}

/** Una línea del pedido que consume stock (no un decant bajo pedido). */
export interface SaleConsumptionLine {
  readonly lineId: string;
  readonly variantId: string;
  /** En la unidad de la variante: unidades enteras. Una línea serializada vale 1. */
  readonly qty: Quantity;
  /** `product_variants.allocation_policy`. No interviene si la línea trae su unidad. */
  readonly policy: AllocationPolicy;
  /** La unidad serializada elegida y el lote al que pertenece; `null` en una línea común. */
  readonly serialUnit: { readonly id: string; readonly lotId: string } | null;
}

export interface PlanSaleConsumptionInput {
  /** En el orden del pedido (`position`): es el orden en que consumen. */
  readonly lines: readonly SaleConsumptionLine[];
  /** Los lotes consumibles (`available` con saldo) de las variantes de las líneas. */
  readonly lots: readonly SaleLotSnapshot[];
  /** El disponible por variante PARA ESTE PEDIDO: saldo menos reservas de otros orígenes. */
  readonly availability: readonly VariantAvailability[];
}

export interface SaleLineConsumption {
  readonly lineId: string;
  /** Una capa por lote tocado, ordenadas por id de lote ascendente. */
  readonly layers: readonly CostLayer[];
  /** Suma de las capas de la línea. */
  readonly cogs: Money;
}

export interface SaleConsumptionPlan {
  readonly lines: readonly SaleLineConsumption[];
  /** Suma del COGS de las líneas = suma de todas las capas del pedido. */
  readonly cogs: Money;
}

export interface SaleConsumptionShortage {
  readonly variantId: string;
  readonly requested: Quantity;
  readonly available: Quantity;
}

export type SaleConsumptionError =
  | { readonly code: "INSUFFICIENT_STOCK"; readonly shortages: readonly SaleConsumptionShortage[] }
  | {
      readonly code: "SERIAL_UNIT_LOT_UNAVAILABLE";
      readonly lineId: string;
      readonly serialUnitId: string;
    }
  | {
      readonly code: "ALLOCATION_NEEDS_LOT_CHOICE";
      readonly lineId: string;
      readonly policy: AllocationPolicy;
    };

/**
 * RF-VTA-05, RF-VTA-06 · decide el consumo de todas las líneas del pedido.
 * Todo o nada: ante cualquier rechazo no se consume nada (quien llama revierte
 * la transacción). Los faltantes de stock se informan juntos, por variante y en el orden en que aparecen en el pedido.
 *
 * **Ejemplo verificado (RN-COS-04).** Una línea de 3 unidades con L-001 (2 a
 * 1.400.000) y L-002 (5 a 1.550.000): dos capas, 2.800.000 + 1.550.000 =
 * 4.350.000, y ese es el COGS de la línea y del pedido.
 *
 * Una línea sin cantidad positiva, una línea serializada de cantidad distinta de
 * 1 o una variante sin disponible informado son bugs de quien arma la entrada:
 * lanza.
 */
export function planSaleConsumption(
  input: PlanSaleConsumptionInput,
): Result<SaleConsumptionPlan, SaleConsumptionError> {
  const availabilityByVariant = new Map(input.availability.map((item) => [item.variantId, item]));

  for (const line of input.lines) {
    if (line.qty.value <= 0) {
      throw new InvalidAllocationRequestError(
        `planSaleConsumption requiere qty positiva, la línea ${line.lineId} trae ${line.qty.value}.`,
      );
    }
    if (line.serialUnit !== null && line.qty.value !== 1) {
      throw new InvalidAllocationRequestError(
        `planSaleConsumption: la línea serializada ${line.lineId} mueve una sola unidad, trae ${line.qty.value}.`,
      );
    }
    if (line.serialUnit === null && (line.policy === "manual" || line.policy === "serial")) {
      return err({ code: "ALLOCATION_NEEDS_LOT_CHOICE", lineId: line.lineId, policy: line.policy });
    }
  }

  // El disponible de la variante, sumando TODAS sus líneas: dos líneas de 3
  // contra un disponible de 5 no caben, aunque cada una por separado sí.
  const requestedByVariant = new Map<string, Quantity>();
  for (const line of input.lines) {
    const previous = requestedByVariant.get(line.variantId);
    requestedByVariant.set(line.variantId, previous ? previous.plus(line.qty) : line.qty);
  }
  const shortages: SaleConsumptionShortage[] = [];
  for (const [variantId, requested] of requestedByVariant) {
    const availability = availabilityByVariant.get(variantId);
    if (!availability) {
      throw new InvalidAllocationRequestError(
        `planSaleConsumption: falta el disponible de la variante ${variantId}.`,
      );
    }
    if (availability.available.compare(requested) < 0) {
      shortages.push({ variantId, requested, available: availability.available });
    }
  }
  if (shortages.length > 0) return err({ code: "INSUFFICIENT_STOCK", shortages });

  // Saldo que va quedando de cada lote a medida que las líneas consumen.
  const remaining = new Map(input.lots.map((lot) => [lot.id, lot.available]));
  const consumed: SaleLineConsumption[] = [];

  for (const line of input.lines) {
    let layers: CostLayer[];

    if (line.serialUnit !== null) {
      const serialUnit = line.serialUnit;
      const lot = input.lots.find((candidate) => candidate.id === serialUnit.lotId);
      if (
        !lot ||
        lot.variantId !== line.variantId ||
        remaining.get(lot.id)!.value < line.qty.value
      ) {
        return err({
          code: "SERIAL_UNIT_LOT_UNAVAILABLE",
          lineId: line.lineId,
          serialUnitId: serialUnit.id,
        });
      }
      layers = [
        { lotId: lot.id, qty: line.qty, unitCost: lot.unitCost, totalCost: lot.unitCost.times(1) },
      ];
    } else {
      const candidates = input.lots
        .filter((lot) => lot.variantId === line.variantId)
        .map((lot): LotSnapshot => ({ ...lot, available: remaining.get(lot.id)! }));
      const allocation = allocateFromLots({
        lots: candidates,
        required: line.qty,
        policy: line.policy,
      });
      if (!allocation.ok) {
        return err({
          code: "INSUFFICIENT_STOCK",
          shortages: [
            {
              variantId: line.variantId,
              requested: line.qty,
              available: allocation.error.available,
            },
          ],
        });
      }
      layers = allocation.value;
    }

    for (const layer of layers) {
      remaining.set(layer.lotId, remaining.get(layer.lotId)!.minus(layer.qty));
    }
    consumed.push({ lineId: line.lineId, layers, cogs: totalCost(layers) });
  }

  return ok({
    lines: consumed,
    cogs: consumed.reduce((sum, line) => sum.plus(line.cogs), Money.zero("PYG")),
  });
}
