// Apertura de frasco (RN-LOT-02, RN-LOT-03; ADR-009; GLOSARIO.md "Apertura
// de frasco"). No es un cambio de estado: es una CONVERSIÓN entre dos
// lotes, ejecutada en una sola transacción por quien orquesta el `INSERT`
// (esta función es pura, no escribe nada — devuelve los cuatro pasos de
// RN-LOT-02 como datos):
//
//   1. transfer_out  −1 unit    sobre el lote sellado
//   2. lote sellado → status = 'open_for_decant'
//   3. alta del lote de granel hijo, con `parent_lot_id` y el costo
//      heredado ÍNTEGRO del sellado
//   4. transfer_in  +nominal_volume_ml   sobre el lote de granel
//
// RN-LOT-03 ("un lote en `open_for_decant` no admite ventas de la variante
// sellada") no se testea acá: está "impuesta por la base"
// (`app.assert_sealed_lot_not_open`, packages/db/migrations/0009_invariants.sql),
// no por esta función. Lo único que esta función le debe a RN-LOT-03 es
// producir el `status` correcto para que ese trigger tenga algo que mirar —
// por eso `sealedLotStatusAfter` es parte del resultado, no un detalle
// interno.
import { computeUnitLandedCost } from "../procurement/landedCost.js";
import { InvalidLotOpeningInputError } from "../shared/errors.js";
import type { Money } from "../shared/money.js";
import type { Clock, IdGenerator } from "../shared/ports.js";
import { Quantity } from "../shared/quantity.js";
import { err, ok, type Result } from "../shared/result.js";
import type { LotStatus } from "./allocation.js";

/**
 * Snapshot del lote sellado a abrir. Solo lo que `openLot` necesita — no el
 * `LotSnapshot` completo de allocation.ts (ese expone `available`,
 * `receivedAt`, etc. para selección de lotes; acá no hace falta nada de
 * eso). `unitLandedCostPyg` es el costo puesto de ESTE frasco (columna
 * `inventory_lots.unit_landed_cost_pyg`), no el costo total del lote si el
 * lote agrupa más de un frasco: es lo que se hereda íntegro al granel
 * (RN-LOT-02 paso 3), no el costo del lote entero.
 */
export interface SealedLotSnapshot {
  readonly id: string;
  readonly status: LotStatus;
  readonly unitLandedCostPyg: Money;
}

export interface OpenLotInput {
  readonly sealedLot: SealedLotSnapshot;
  /** `product_details.nominal_volume_ml` — volumen del frasco sellado, en ml. */
  readonly nominalVolumeMl: number;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

/** Caso borde #5 del catálogo de domain-rules.md: un lote solo se abre una vez. */
export type LotOpeningError = {
  readonly code: "SEALED_LOT_NOT_OPENABLE";
  readonly status: LotStatus;
};

/** El lote de granel hijo que nace de la conversión (RN-LOT-02 paso 3). */
export interface BulkLotDraft {
  readonly id: string;
  readonly parentLotId: string;
  readonly qtyInitial: Quantity;
  readonly landedCostPyg: Money;
  readonly unitLandedCostPyg: Money;
}

export type LotOpeningMovementType = "transfer_out" | "transfer_in";

/**
 * Movimiento listo para que la API lo inserte en `inventory_movements` —
 * mismo criterio que `MovementDraft` en decant/execution.ts: sin
 * `variantId`, porque ninguno de los snapshots que recibe este módulo lo
 * carga.
 */
export interface LotOpeningMovement {
  readonly lotId: string;
  /** Con signo: transfer_out negativo, transfer_in positivo (RN-LOT-02). */
  readonly qty: Quantity;
  readonly movementType: LotOpeningMovementType;
  readonly totalCost: Money;
}

export interface LotOpening {
  readonly sealedLotId: string;
  /** RN-LOT-02 paso 2 — lo que el trigger de RN-LOT-03 necesita para actuar. */
  readonly sealedLotStatusAfter: Extract<LotStatus, "open_for_decant">;
  readonly openedAt: Date;
  readonly bulkLot: BulkLotDraft;
  /** [transfer_out del sellado, transfer_in del granel] — en ese orden, RN-LOT-02. */
  readonly movements: readonly LotOpeningMovement[];
}

function validateNominalVolume(nominalVolumeMl: number): void {
  if (!Number.isFinite(nominalVolumeMl) || nominalVolumeMl <= 0) {
    throw new InvalidLotOpeningInputError(
      `openLot requiere nominalVolumeMl positivo y finito, recibido ${nominalVolumeMl}.`,
    );
  }
}

/**
 * RN-LOT-02, ADR-009 · convierte un lote sellado en un lote de granel hijo.
 * Solo un lote `available` es abrible: cualquier otro estado se rechaza,
 * incluido `open_for_decant` — es el caso borde #5, "un lote solo se abre
 * una vez", no una excepción aparte de esta regla general.
 *
 * **Ejemplo verificado (RN-LOT-02, ADR-009).** Frasco de Layton con
 * `unit_landed_cost_pyg` 1.496.500 y `nominal_volume_ml` 125 → el granel
 * hijo nace con `landed_cost_pyg` 1.496.500 (heredado íntegro) y
 * `unit_landed_cost_pyg` 11.972 Gs./ml (`1.496.500 / 125`, RN-COS-03 —
 * misma fórmula que `computeUnitLandedCost`, reusada acá en vez de
 * reimplementar la división).
 */
export function openLot(input: OpenLotInput): Result<LotOpening, LotOpeningError> {
  validateNominalVolume(input.nominalVolumeMl);

  if (input.sealedLot.status !== "available") {
    return err({ code: "SEALED_LOT_NOT_OPENABLE", status: input.sealedLot.status });
  }

  const qtyInitial = Quantity.ml(input.nominalVolumeMl);
  const landedCostPyg = input.sealedLot.unitLandedCostPyg;
  const unitLandedCostPyg = computeUnitLandedCost(landedCostPyg, qtyInitial);
  const bulkLotId = input.idGenerator.next();

  return ok({
    sealedLotId: input.sealedLot.id,
    sealedLotStatusAfter: "open_for_decant",
    openedAt: input.clock.now(),
    bulkLot: {
      id: bulkLotId,
      parentLotId: input.sealedLot.id,
      qtyInitial,
      landedCostPyg,
      unitLandedCostPyg,
    },
    movements: [
      {
        lotId: input.sealedLot.id,
        qty: Quantity.units(-1),
        movementType: "transfer_out",
        totalCost: landedCostPyg,
      },
      {
        lotId: bulkLotId,
        qty: qtyInitial,
        movementType: "transfer_in",
        totalCost: landedCostPyg,
      },
    ],
  });
}
