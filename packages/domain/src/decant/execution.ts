// Ejecución del decant — momento 2 de RN-FRA-01 (transformación física):
// acá se conoce la merma REAL y se producen los movimientos definitivos
// (RN-FRA-03, RN-FRA-04, ADR-010). No se colapsa con planning.ts: son dos
// momentos de negocio distintos, con disparadores distintos (checkout vs.
// alguien llena el vial) — ver la nota en planning.ts sobre por qué esa
// separación es la decisión central de ADR-010, no un detalle de forma.
import type { LotSnapshot } from "../inventory/allocation.js";
import { Money } from "../shared/money.js";
import type { Quantity } from "../shared/quantity.js";
import { err, ok, type Result } from "../shared/result.js";
import { assertBulkLotIsDecantable, type DecantError, type DecantPlan } from "./planning.js";

export interface BomLotSnapshot {
  readonly componentId: string;
  readonly lotId: string;
  readonly available: Quantity;
  readonly unitCost: Money;
  /**
   * Espejo de `bom_components.is_optional`
   * (packages/db/migrations/0003_catalog.sql). Si el componente falta y es
   * opcional, el caso borde #4 del catálogo de domain-rules.md dice
   * ejecutar sin él; si falta y NO es opcional, el caso borde #3 dice
   * rechazar la ejecución entera.
   */
  readonly isOptional: boolean;
}

export type DecantMovementType = "decant_consumption" | "waste" | "bom_consumption";

/**
 * Movimiento de inventario listo para que la API lo inserte en
 * `inventory_movements` (packages/db/migrations/0004_inventory.sql) — sin
 * `variantId`, igual que `CostLayer` (inventory/costing.ts): ninguno de los
 * dos snapshots de lote que recibe este módulo (`LotSnapshot`,
 * `BomLotSnapshot`) carga esa columna, y resolverla contra el lote es
 * responsabilidad de quien arma el `INSERT`, no de este cálculo.
 */
export interface MovementDraft {
  readonly lotId: string;
  /** Con signo: toda salida de una ejecución de decant es negativa (RN-FRA-03). */
  readonly qty: Quantity;
  readonly movementType: DecantMovementType;
  readonly totalCost: Money;
}

export interface DecantExecution {
  readonly movements: readonly MovementDraft[];
  readonly cogs: Money;
  readonly costBreakdown: {
    readonly liquid: Money;
    readonly waste: Money;
    readonly supplies: Money;
  };
  /**
   * Componentes opcionales del BOM que faltaron y se ejecutó sin ellos
   * (caso borde #4) — para que quien orqueste la orden lo registre en su
   * nota, tal como pide el catálogo de domain-rules.md.
   */
  readonly skippedOptionalComponents: readonly string[];
}

export interface ExecuteDecantInput {
  readonly plan: DecantPlan;
  readonly wasteActual: Quantity;
  readonly bulkLot: LotSnapshot;
  readonly bomLots: readonly BomLotSnapshot[];
}

// Discriminada por `kind`, no dos campos nullable ("movement | null" +
// "skippedComponentId | null"): con dos nullables, el llamador tiene que
// manejar una cuarta combinación (ambos null) que resolveBomComponent nunca
// produce — código muerto que ninguna prueba puede ejercitar. Con un solo
// campo que decide cuál de los dos casos es, esa combinación imposible deja
// de existir a nivel de tipo.
type BomComponentOutcome =
  | { readonly kind: "consumed"; readonly movement: MovementDraft }
  | { readonly kind: "skipped"; readonly componentId: string };

/**
 * Resuelve un componente del BOM contra su lote real. `kind: "skipped"` es
 * el caso borde #4 (opcional, faltante, se ejecuta sin él); un `DecantError`
 * es el caso borde #3 (obligatorio, faltante, se rechaza TODA la
 * ejecución) — sin lote en absoluto no dice si el componente es opcional,
 * así que tratarlo como obligatorio es la opción segura cuando no hay
 * información, no un valor arbitrario.
 */
function resolveBomComponent(
  required: { readonly componentId: string; readonly qty: Quantity },
  lot: BomLotSnapshot | undefined,
): Result<BomComponentOutcome, DecantError> {
  // required.qty.minus(required.qty): la forma de obtener un CERO en la
  // misma unidad que required.qty sin conocerla de antemano — Quantity, a
  // diferencia de Money, no tiene un Quantity.zero(uom) (evaluar agregarlo
  // en WP-A12, packages/domain/src/shared/quantity.ts). NO simplificar a
  // Quantity.units(0): si el componente estuviera medido en 'ml', eso
  // lanzaría UomMismatchError en el `available.compare(required.qty)` de
  // abajo en vez de devolver cero.
  const available = lot?.available ?? required.qty.minus(required.qty);
  const hasEnough = lot !== undefined && available.compare(required.qty) >= 0;

  if (hasEnough) {
    return ok({
      kind: "consumed",
      movement: {
        lotId: lot.lotId,
        qty: required.qty.times(-1),
        movementType: "bom_consumption",
        totalCost: lot.unitCost.times(required.qty.value),
      },
    });
  }

  if (lot?.isOptional) {
    return ok({ kind: "skipped", componentId: required.componentId });
  }

  return err({
    code: "MISSING_BOM_COMPONENT",
    componentId: required.componentId,
    required: required.qty,
    available,
  });
}

/**
 * RN-FRA-03, RN-FRA-04 · produce los movimientos definitivos de un decant ya
 * comprometido, con la merma REAL (no la esperada de `planDecant`): consumo
 * de líquido, merma, y consumo del BOM — y el COGS desglosado en sus tres
 * partes. Todo o nada: si algo no alcanza, no devuelve movimientos
 * parciales (mismo principio del caso borde #1 de `planDecant`, aplicado
 * acá a la ejecución).
 *
 * Caso borde #2 del catálogo: la merma real puede superar la reservada —
 * esta función siempre usa `wasteActual`, nunca `plan.wasteExpected`, para
 * el movimiento y el costo de merma. Si el granel no alcanza para cubrir
 * `mlExpected + wasteActual`, falla con `INSUFFICIENT_BULK_FOR_ACTUAL` (la
 * orden queda `in_progress` para resolución manual, según el catálogo —
 * decisión de la capa que orquesta la orden, no de esta función).
 *
 * **Ejemplo verificado (RN-FRA-04, caso Layton).** 10 ml a 11.972 Gs./ml +
 * 0,35 ml de merma real + vial/atomizador/etiqueta a 4.500/2.500/300 Gs. →
 * COGS 131.210 (119.720 líquido + 4.190 merma + 7.300 insumos).
 */
export function executeDecant(input: ExecuteDecantInput): Result<DecantExecution, DecantError> {
  const notDecantable = assertBulkLotIsDecantable(input.bulkLot);
  if (notDecantable) return err(notDecantable);

  const requiredFromBulk = input.plan.mlExpected.plus(input.wasteActual);
  if (input.bulkLot.available.compare(requiredFromBulk) < 0) {
    return err({
      code: "INSUFFICIENT_BULK_FOR_ACTUAL",
      required: requiredFromBulk,
      available: input.bulkLot.available,
    });
  }

  const bomLotsByComponent = new Map(input.bomLots.map((lot) => [lot.componentId, lot]));
  const bomMovements: MovementDraft[] = [];
  const skippedOptionalComponents: string[] = [];

  for (const required of input.plan.bomToReserve) {
    const outcome = resolveBomComponent(required, bomLotsByComponent.get(required.componentId));
    if (!outcome.ok) return outcome;

    if (outcome.value.kind === "consumed") {
      bomMovements.push(outcome.value.movement);
    } else {
      skippedOptionalComponents.push(outcome.value.componentId);
    }
  }

  const liquidCost = input.bulkLot.unitCost.times(input.plan.mlExpected.value);
  const wasteCost = input.bulkLot.unitCost.times(input.wasteActual.value);
  const suppliesCost = bomMovements.reduce(
    (sum, movement) => sum.plus(movement.totalCost),
    Money.zero(liquidCost.currency),
  );

  const movements: MovementDraft[] = [
    {
      lotId: input.bulkLot.id,
      qty: input.plan.mlExpected.times(-1),
      movementType: "decant_consumption",
      totalCost: liquidCost,
    },
    {
      lotId: input.bulkLot.id,
      qty: input.wasteActual.times(-1),
      movementType: "waste",
      totalCost: wasteCost,
    },
    ...bomMovements,
  ];

  return ok({
    movements,
    cogs: liquidCost.plus(wasteCost).plus(suppliesCost),
    costBreakdown: { liquid: liquidCost, waste: wasteCost, supplies: suppliesCost },
    skippedOptionalComponents,
  });
}
