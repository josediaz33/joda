// Planificación del decant — momento 1 de RN-FRA-01 (compromiso comercial):
// calcula cuánto granel e insumos reservar, SIN tocar el inventario todavía
// (docs/domain-contracts.md §6.2, RN-FRA-02, ADR-010). La ejecución real
// —con la merma REAL— es execution.ts; las dos no se colapsan en una sola
// función porque son, literalmente, dos momentos distintos del negocio
// (RN-FRA-01, ADR-010): uno pasa en el checkout, el otro cuando alguien
// llena el vial.
import type { LotSnapshot, LotStatus } from "../inventory/allocation.js";
import { InvalidDecantInputError } from "../shared/errors.js";
import type { Percentage } from "../shared/percentage.js";
import { Quantity } from "../shared/quantity.js";
import { err, ok, type Result } from "../shared/result.js";
import { computeTransferWaste } from "./waste.js";

/**
 * Unión de errores de negocio de TODO el módulo decant/ — tanto de
 * `planDecant` como de `executeDecant` (docs/domain-contracts.md §6.2 usa
 * el mismo nombre `DecantError` para el `Result` de ambas funciones, y no
 * hay ganancia en partirlo en dos uniones que la API tendría que volver a
 * unir para manejar el mismo flujo). No son excepciones (§4.2): son fallos
 * que una acción legítima del negocio puede provocar — granel agotado,
 * insumo faltante, un lote que ya no es granel decantable.
 */
export type DecantError =
  | {
      readonly code: "SOURCE_LOT_NOT_DECANTABLE";
      readonly status: LotStatus;
    }
  | {
      readonly code: "INSUFFICIENT_BULK";
      readonly required: Quantity;
      readonly available: Quantity;
    }
  | {
      readonly code: "INSUFFICIENT_BOM_COMPONENT";
      readonly componentId: string;
      readonly required: Quantity;
      readonly available: Quantity;
    }
  | {
      readonly code: "INSUFFICIENT_BULK_FOR_ACTUAL";
      readonly required: Quantity;
      readonly available: Quantity;
    }
  | {
      readonly code: "MISSING_BOM_COMPONENT";
      readonly componentId: string;
      readonly required: Quantity;
      readonly available: Quantity;
    };

export interface BomAvailability {
  readonly componentId: string;
  readonly available: Quantity;
  readonly perUnit: Quantity;
}

export interface PlanDecantInput {
  readonly unitsRequested: number;
  readonly mlPerUnit: number;
  readonly wasteFactor: Percentage;
  /**
   * El lote de granel candidato para esta reserva — no un `Quantity`
   * suelto como lista `docs/domain-contracts.md` §6.2 (`bulkAvailable:
   * Quantity`): un decant solo puede reservarse sobre un lote que
   * efectivamente ES granel abierto para decantar, y sin el lote completo
   * `planDecant` no tiene cómo saberlo. "Los tipos exactos viven en el
   * código" (docs/domain-contracts.md §6, primer párrafo) — esto es una
   * decisión de forma, no una regla de negocio nueva.
   */
  readonly bulkLot: LotSnapshot;
  readonly bomAvailability: readonly BomAvailability[];
}

export interface DecantPlan {
  readonly mlExpected: Quantity;
  readonly wasteExpected: Quantity;
  readonly mlToReserve: Quantity;
  readonly bomToReserve: readonly { readonly componentId: string; readonly qty: Quantity }[];
}

/**
 * Un decant se sirve de GRANEL, no de un frasco sellado sin convertir. Esta
 * validación es responsabilidad propia de decant/, por derecho propio —no
 * una repetición de RN-LOT-02: esa regla gobierna la apertura del frasco en
 * sí (vive en inventory/lotOpening.ts, fuera del alcance de este paquete de
 * trabajo) y decide si SE PUEDE abrir un lote; esta decide si un lote YA
 * ABIERTO sirve como fuente de un decant, que es una pregunta distinta.
 *
 * `open_for_decant` es el único estado en el que un lote de granel existe
 * mientras tiene saldo vendible: RN-LOT-02 lo crea así, y RN-LOT-04 lo pasa
 * a `depleted` recién al agotarse. `quarantine`, `damaged`, `depleted`, o
 * un `available` que en realidad es un sellado sin convertir, no sirven
 * como origen de un decant. Se exporta porque execution.ts necesita la
 * misma validación sobre el mismo campo (mismo criterio que
 * `selectLotsByPolicy` en inventory/allocation.ts, reusado por
 * inventory/costing.ts).
 */
export function assertBulkLotIsDecantable(status: LotStatus): DecantError | undefined {
  if (status !== "open_for_decant") {
    return { code: "SOURCE_LOT_NOT_DECANTABLE", status };
  }
  return undefined;
}

function validateInputMagnitudes(unitsRequested: number, mlPerUnit: number): void {
  if (!Number.isInteger(unitsRequested) || unitsRequested <= 0) {
    throw new InvalidDecantInputError(
      `planDecant requiere unitsRequested un entero positivo, recibido ${unitsRequested}.`,
    );
  }
  if (!Number.isFinite(mlPerUnit) || mlPerUnit <= 0) {
    throw new InvalidDecantInputError(
      `planDecant requiere mlPerUnit positivo y finito, recibido ${mlPerUnit}.`,
    );
  }
}

/**
 * RN-FRA-02 · calcula la reserva de un decant: ml esperado + merma esperada
 * (trasvase, RN-FRA-05/waste.ts) + insumos del BOM — sin tocar inventario
 * todavía (RN-FRA-01, "compromiso comercial"). Rechaza TODO antes de
 * reservar nada si el granel o algún insumo no alcanzan (caso borde #1 del
 * catálogo de domain-rules.md: "no fraccionar parcialmente").
 *
 * **Ejemplo verificado (RN-FRA-02).** 1 decant de 10 ml con `waste_factor`
 * 2%: `mlExpected` 10,000 + `wasteExpected` 0,200 = `mlToReserve` 10,200.
 */
export function planDecant(input: PlanDecantInput): Result<DecantPlan, DecantError> {
  validateInputMagnitudes(input.unitsRequested, input.mlPerUnit);

  const notDecantable = assertBulkLotIsDecantable(input.bulkLot.status);
  if (notDecantable) return err(notDecantable);

  const mlExpected = Quantity.ml(input.unitsRequested * input.mlPerUnit);
  const wasteExpected = computeTransferWaste(mlExpected, input.wasteFactor);
  const mlToReserve = mlExpected.plus(wasteExpected);

  if (input.bulkLot.available.compare(mlToReserve) < 0) {
    return err({
      code: "INSUFFICIENT_BULK",
      required: mlToReserve,
      available: input.bulkLot.available,
    });
  }

  const bomToReserve = input.bomAvailability.map((component) => ({
    componentId: component.componentId,
    qty: component.perUnit.times(input.unitsRequested),
  }));

  for (const [index, component] of input.bomAvailability.entries()) {
    const qty = bomToReserve[index]!.qty;
    if (component.available.compare(qty) < 0) {
      return err({
        code: "INSUFFICIENT_BOM_COMPONENT",
        componentId: component.componentId,
        required: qty,
        available: component.available,
      });
    }
  }

  return ok({ mlExpected, wasteExpected, mlToReserve, bomToReserve });
}
