// Capas de costo (RN-COS-04, RN-COS-05; ADR-008; docs/domain-contracts.md
// §6.1). Una salida puede consumir varios lotes con costos distintos: esta
// función devuelve una fila por lote tocado, nunca un promedio — es lo que
// hace posible que `SUM(total_cost_pyg)` de las capas cierre exacto contra
// el costo del movimiento (RN-COS-05, constraint diferida en la base).
import { CurrencyMismatchError, InvalidAllocationRequestError } from "../shared/errors.js";
import { Money } from "../shared/money.js";
import type { Quantity } from "../shared/quantity.js";
import { err, ok, type Result } from "../shared/result.js";
import { selectLotsByPolicy, type AllocationPolicy, type LotSnapshot } from "./allocation.js";

export interface CostLayer {
  readonly lotId: string;
  readonly qty: Quantity;
  readonly unitCost: Money;
  readonly totalCost: Money;
}

// Objeto plano con `code`, no una clase de shared/errors.ts: se DEVUELVE
// dentro de un Result (fallo que el negocio contempla — stock insuficiente
// es el pan de cada día de un pedido real, docs/domain-contracts.md §4.1),
// nunca se hace throw. Mismo criterio que FreightError en
// procurement/freight.ts.
export type AllocationError = {
  readonly code: "INSUFFICIENT_STOCK";
  readonly required: Quantity;
  readonly available: Quantity;
};

export interface AllocateFromLotsInput {
  readonly lots: readonly LotSnapshot[];
  readonly required: Quantity;
  readonly policy: AllocationPolicy;
}

function compareByLotId(a: CostLayer, b: CostLayer): number {
  return a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0;
}

/** El menor entre `remaining` y `lot.available`, sin construir una Quantity nueva. */
function takeFrom(remaining: Quantity, lot: LotSnapshot): Quantity {
  return remaining.compare(lot.available) <= 0 ? remaining : lot.available;
}

/**
 * RN-COS-04, RN-LOT-05 · selecciona lotes según `policy` (`selectLotsByPolicy`,
 * allocation.ts) y consume en ese orden hasta cubrir `required`, devolviendo
 * una capa por cada lote tocado — nunca un costo promedio.
 *
 * **Ejemplo verificado (RN-COS-04).** Venta de 3 unidades con L-001 (2
 * disponibles a 1.400.000) y L-002 (5 disponibles a 1.550.000): dos capas,
 * 2.800.000 + 1.550.000 = 4.350.000, no `3 × promedio`.
 *
 * El orden de las capas devueltas es SIEMPRE lot id ascendente,
 * independiente del orden en que la política decidió consumir — es el
 * orden de bloqueo que usa la API (RN-LOT-05: "el orden de bloqueo
 * siempre es lot_id ascendente, para evitar interbloqueos en pedidos
 * multi-línea") y tiene que ser determinístico sin importar la política.
 * fifo consume del más antiguo primero, pero eso decide CUÁNTO sale de
 * cada lote, no en qué orden se devuelven ni se bloquean las filas.
 */
export function allocateFromLots(
  input: AllocateFromLotsInput,
): Result<CostLayer[], AllocationError> {
  if (input.required.isNegative()) {
    throw new InvalidAllocationRequestError(
      `allocateFromLots requiere una cantidad requerida no negativa, recibido ${input.required.value}.`,
    );
  }

  const ordered = selectLotsByPolicy(input.lots, input.policy);

  const layers: CostLayer[] = [];
  let remaining = input.required;
  const zero = remaining.minus(remaining);

  for (const lot of ordered) {
    if (remaining.compare(zero) <= 0) break;

    const qty = takeFrom(remaining, lot);
    layers.push({
      lotId: lot.id,
      qty,
      unitCost: lot.unitCost,
      totalCost: lot.unitCost.times(qty.value),
    });
    remaining = remaining.minus(qty);
  }

  if (remaining.compare(zero) > 0) {
    const available = ordered.reduce((sum, lot) => sum.plus(lot.available), zero);
    return err({ code: "INSUFFICIENT_STOCK", required: input.required, available });
  }

  return ok(layers.sort(compareByLotId));
}

/**
 * Valida, ANTES de sumar, que todas las capas compartan moneda con la
 * primera — no lo que `Money.plus()` tiraría por accidente a mitad del
 * `reduce` de `totalCost`. La diferencia importa: adentro del reduce el
 * error compararía contra el ACUMULADOR en ese punto (que ya pudo haber
 * cambiado de moneda si una capa anterior también estaba mal), no contra
 * una referencia estable: acá siempre es "capa 0" contra "la primera que
 * no coincide". Mezclar monedas entre capas de UN MISMO movimiento es un
 * bug de quien arma el `CostLayer[]` — todo costo de lote en este dominio
 * es PYG (RN-COS-01, RN-COS-03) — así que se lanza, no se devuelve como
 * `Result` (docs/domain-contracts.md §4.2).
 */
function assertSameCurrencyAcrossLayers(layers: readonly CostLayer[]): void {
  const expected = layers[0]!.totalCost.currency;
  const mismatched = layers.find((layer) => layer.totalCost.currency !== expected);
  if (mismatched) {
    throw new CurrencyMismatchError(expected, mismatched.totalCost.currency);
  }
}

/**
 * RN-COS-05 · suma las capas. Invariante: igual a `ABS(total_cost_pyg)`
 * del movimiento (constraint diferida en la base).
 *
 * La moneda del resultado es la de la PRIMERA capa, no un PYG fijo — esta
 * función no necesita asumir PYG para funcionar, y una capa en otra
 * moneda que las demás falla con `CurrencyMismatchError`, explícito y con
 * las dos monedas en conflicto, en vez de un throw accidental de
 * `Money.plus()` en mitad de la suma.
 *
 * Con `layers` vacío no hay ninguna capa de la que derivar moneda: es el
 * único caso que sí necesita un valor fijo, y ese valor es PYG — la
 * moneda de todo costo de inventario en este dominio (RN-COS-01). Decisión
 * explícita, no el hardcodeo sin comentar que había antes.
 */
export function totalCost(layers: readonly CostLayer[]): Money {
  if (layers.length === 0) {
    return Money.zero("PYG");
  }

  assertSameCurrencyAcrossLayers(layers);

  const currency = layers[0]!.totalCost.currency;
  return layers.reduce((sum, layer) => sum.plus(layer.totalCost), Money.zero(currency));
}
