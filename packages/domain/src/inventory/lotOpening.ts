// Apertura de frasco (RN-LOT-02, RN-LOT-03; ADR-009; GLOSARIO.md "Apertura
// de frasco"). No es un cambio de estado: es una CONVERSIÓN entre lotes,
// ejecutada en una sola transacción por quien orquesta el `INSERT` (esta
// función es pura, no escribe nada — devuelve los pasos de RN-LOT-02 como
// datos).
//
// Abrir es siempre UNA unidad. Un lote sellado que nació con más de un
// frasco (una recepción de tres iguales, `qty_initial` > 1) NO se abre
// entero: marcarlo `open_for_decant` dejaría todos sus frascos cerrados sin
// poder venderse como sellados, porque un sellado abierto es terminal
// (RN-LOT-03). Por eso, si `qty_initial` > 1, primero se SEPARA la unidad en
// su propio lote de una unidad (caso borde 21), y recién ese se abre:
//
//   separación (solo si qty_initial > 1):
//     a. transfer_out −1 unit   sobre el lote original     (con capa de costo)
//     b. alta del lote sellado de una unidad, con
//        `parent_lot_id` = lote original y el costo de UNA unidad
//     c. transfer_in  +1 unit   sobre el lote de una unidad
//   apertura (RN-LOT-02):
//     1. transfer_out −1 unit   sobre el lote de una unidad (con capa de costo)
//     2. ese lote → status = 'open_for_decant'
//     3. alta del lote de granel hijo, con `parent_lot_id` y el costo de UNA
//        unidad del sellado
//     4. transfer_in  +nominal_volume_ml   sobre el lote de granel
//
// La condición es `qty_initial`, no el saldo. Un lote de tres con dos ya
// vendidos tiene saldo 1 y sigue siendo de tres: la base exige que un
// sellado abierto tenga `qty_initial` = 1, y el costo que hereda el granel
// es el de UN frasco (ver `SealedLotSnapshot.unitLandedCostPyg`), no el del
// lote entero. Sin eso, cada decant saldría con el margen equivocado sin
// que nada falle.
//
// RN-LOT-03 ("un sellado en `open_for_decant` no admite movimientos") no se
// testea acá: está "impuesta por la base"
// (`app.assert_sealed_lot_not_open`, packages/db/migrations/0023). Lo único
// que esta función le debe es sacar la unidad ANTES de cambiar el estado, y
// producir el `status` correcto para que ese trigger tenga algo que mirar.
import { computeUnitLandedCost } from "../procurement/landedCost.js";
import { InvalidLotOpeningInputError } from "../shared/errors.js";
import type { Money } from "../shared/money.js";
import type { Clock, IdGenerator } from "../shared/ports.js";
import { Quantity } from "../shared/quantity.js";
import { err, ok, type Result } from "../shared/result.js";
import type { LotStatus } from "./allocation.js";
import type { CostLayer } from "./costing.js";

/**
 * Snapshot del lote sellado a abrir. Solo lo que `openLot` necesita — no el
 * `LotSnapshot` completo de allocation.ts (ese expone `available`,
 * `receivedAt`, etc. para selección de lotes; acá no hace falta nada de
 * eso).
 */
export interface SealedLotSnapshot {
  readonly id: string;
  readonly status: LotStatus;
  /**
   * `inventory_lots.qty_initial`: con cuántos frascos nació el lote, en
   * `unit`. Decide si la apertura separa primero una unidad. NO es el saldo.
   */
  readonly qtyInitial: Quantity;
  /** `inventory_balances.on_hand` del lote, en `unit`. Hace falta al menos un frasco. */
  readonly onHand: Quantity;
  /**
   * `inventory_lots.unit_landed_cost_pyg`: el costo puesto de UN frasco, no
   * el del lote entero (`landed_cost_pyg` es "del lote entero"). Es lo que
   * hereda íntegro el granel (RN-LOT-02 paso 3).
   */
  readonly unitLandedCostPyg: Money;
  /**
   * `inventory_lots.unit_cost_minor` con su `currency`: el costo de compra de
   * UN frasco, en la moneda de compra. **Informativo**: el costo de la
   * mercadería vendida sale SIEMPRE de los campos en guaraníes
   * (`unit_landed_cost_pyg` y las capas de costo), nunca de este. El granel lo
   * hereda POR ML (RN-LOT-02 paso 3).
   */
  readonly unitCost: Money;
}

export interface OpenLotInput {
  readonly sealedLot: SealedLotSnapshot;
  /** `perfume_details.nominal_volume_ml` — volumen del frasco sellado, en ml. */
  readonly nominalVolumeMl: number;
  /**
   * Disponible de la VARIANTE sellada (`v_stock_available.available`): saldo
   * de todos sus lotes menos las reservas vivas. Una reserva no está atada a
   * un lote concreto todavía (WP-C18), así que abrir la última unidad
   * reservada se decide a este nivel.
   */
  readonly variantAvailable: Quantity;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

/**
 * Fallos que el negocio contempla al abrir un frasco. El primero es el caso
 * borde #5 del catálogo de domain-rules.md: un lote solo se abre una vez.
 */
export type LotOpeningError =
  | { readonly code: "SEALED_LOT_NOT_OPENABLE"; readonly status: LotStatus }
  | { readonly code: "SEALED_LOT_WITHOUT_STOCK"; readonly onHand: Quantity }
  | { readonly code: "SEALED_VARIANT_NOT_AVAILABLE"; readonly available: Quantity };

/** El lote sellado de UNA unidad que nace de separar un frasco de un lote de varios. */
export interface SealedUnitLotDraft {
  readonly id: string;
  readonly parentLotId: string;
  readonly qtyInitial: Quantity;
  readonly landedCostPyg: Money;
  readonly unitLandedCostPyg: Money;
  /** Por frasco, como el del lote original: el lote de una unidad sigue midiéndose en frascos. */
  readonly unitCost: Money;
}

/** El lote de granel hijo que nace de la conversión (RN-LOT-02 paso 3). */
export interface BulkLotDraft {
  readonly id: string;
  readonly parentLotId: string;
  readonly qtyInitial: Quantity;
  readonly landedCostPyg: Money;
  readonly unitLandedCostPyg: Money;
  /**
   * Costo de compra POR ML, en la moneda de compra del sellado: el
   * `unit_cost_minor` del frasco sobre el volumen nominal. Significa "costo por
   * unidad de medida de este lote", igual que `unitLandedCostPyg` (por frasco
   * en un sellado, por ml en un granel). Informativo: nunca se usa para
   * calcular costos.
   */
  readonly unitCost: Money;
}

export type LotOpeningMovementType = "transfer_out" | "transfer_in";

/** A qué parte de la operación pertenece un movimiento: la API lo traduce a `reference_type`. */
export type LotOpeningMovementPurpose = "separation" | "opening";

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
  readonly purpose: LotOpeningMovementPurpose;
  /**
   * Capa de costo de una SALIDA (`movement_cost_allocations`, ADR-008): sin
   * ella el COGS no cierra. Una entrada no consume nada: `null`.
   */
  readonly costLayer: CostLayer | null;
}

/** Separación previa de un lote de más de una unidad (caso borde 21). */
export interface LotSeparation {
  readonly sourceLotId: string;
  readonly unitLot: SealedUnitLotDraft;
}

export interface LotOpening {
  /**
   * El lote sellado que queda `open_for_decant`: el original si nació con
   * una sola unidad; el lote de una unidad separado si nació con varias.
   */
  readonly sealedLotId: string;
  /** RN-LOT-02 paso 2 — lo que el trigger de RN-LOT-03 necesita para actuar. */
  readonly sealedLotStatusAfter: Extract<LotStatus, "open_for_decant">;
  readonly openedAt: Date;
  /** `null` si el lote original nació con una sola unidad y se abre directo. */
  readonly separation: LotSeparation | null;
  readonly bulkLot: BulkLotDraft;
  /** En el orden en que hay que insertarlos: separación (si hay) y después apertura. */
  readonly movements: readonly LotOpeningMovement[];
}

function validateNominalVolume(nominalVolumeMl: number): void {
  if (!Number.isFinite(nominalVolumeMl) || nominalVolumeMl <= 0) {
    throw new InvalidLotOpeningInputError(
      `openLot requiere nominalVolumeMl positivo y finito, recibido ${nominalVolumeMl}.`,
    );
  }
}

function validateSealedLotQuantities(sealedLot: SealedLotSnapshot): void {
  if (sealedLot.qtyInitial.uom !== "unit" || sealedLot.qtyInitial.value < 1) {
    throw new InvalidLotOpeningInputError(
      `openLot requiere qtyInitial en unidades y de al menos 1, recibido ${sealedLot.qtyInitial.value} ${sealedLot.qtyInitial.uom}.`,
    );
  }
  if (sealedLot.onHand.uom !== "unit" || sealedLot.onHand.isNegative()) {
    throw new InvalidLotOpeningInputError(
      `openLot requiere onHand en unidades y no negativo, recibido ${sealedLot.onHand.value} ${sealedLot.onHand.uom}.`,
    );
  }
}

const ONE_UNIT = Quantity.units(1);

function transferOut(
  lotId: string,
  unitCost: Money,
  purpose: LotOpeningMovementPurpose,
): LotOpeningMovement {
  return {
    lotId,
    qty: Quantity.units(-1),
    movementType: "transfer_out",
    totalCost: unitCost,
    purpose,
    costLayer: { lotId, qty: ONE_UNIT, unitCost, totalCost: unitCost },
  };
}

/**
 * RN-LOT-02, ADR-009 · convierte UN frasco de un lote sellado en un lote de
 * granel hijo. Solo un lote `available` es abrible: cualquier otro estado se
 * rechaza, incluido `open_for_decant` — es el caso borde #5, "un lote solo
 * se abre una vez", no una excepción aparte de esta regla general. Tampoco
 * se abre un lote sin frascos, ni la última unidad de la variante si está
 * reservada.
 *
 * Si el lote nació con más de una unidad, separa primero la de esta apertura
 * en su propio lote (caso borde 21).
 *
 * **Ejemplo verificado (RN-LOT-02, ADR-009).** Frasco de Layton con
 * `unit_landed_cost_pyg` 1.496.500 y `nominal_volume_ml` 125 → el granel
 * hijo nace con `landed_cost_pyg` 1.496.500 (heredado íntegro) y
 * `unit_landed_cost_pyg` 11.972 Gs./ml (`1.496.500 / 125`, RN-COS-03 —
 * misma fórmula que `computeUnitLandedCost`, reusada acá en vez de
 * reimplementar la división). Con un lote de tres frascos de ese costo, el
 * resultado es el mismo: el granel hereda el costo de UN frasco.
 */
export function openLot(input: OpenLotInput): Result<LotOpening, LotOpeningError> {
  validateNominalVolume(input.nominalVolumeMl);
  validateSealedLotQuantities(input.sealedLot);

  const { sealedLot } = input;

  if (sealedLot.status !== "available") {
    return err({ code: "SEALED_LOT_NOT_OPENABLE", status: sealedLot.status });
  }
  if (sealedLot.onHand.compare(ONE_UNIT) < 0) {
    return err({ code: "SEALED_LOT_WITHOUT_STOCK", onHand: sealedLot.onHand });
  }
  if (input.variantAvailable.compare(ONE_UNIT) < 0) {
    return err({ code: "SEALED_VARIANT_NOT_AVAILABLE", available: input.variantAvailable });
  }

  // El costo de UN frasco, en guaraníes: lo que se hereda íntegro y lo que
  // mueve el ledger. `unitCost` (moneda de compra) es informativo y no
  // participa de ningún cálculo de costo.
  const unitLandedCost = sealedLot.unitLandedCostPyg;
  const separates = sealedLot.qtyInitial.compare(ONE_UNIT) > 0;

  // Los ids salen en orden fijo: primero el lote separado (si hay), después
  // el granel.
  const unitLot: SealedUnitLotDraft | null = separates
    ? {
        id: input.idGenerator.next(),
        parentLotId: sealedLot.id,
        qtyInitial: ONE_UNIT,
        landedCostPyg: unitLandedCost,
        unitLandedCostPyg: unitLandedCost,
        unitCost: sealedLot.unitCost,
      }
    : null;
  const openedLotId = unitLot ? unitLot.id : sealedLot.id;

  const qtyInitial = Quantity.ml(input.nominalVolumeMl);
  const bulkLotId = input.idGenerator.next();

  const separationMovements: LotOpeningMovement[] = unitLot
    ? [
        transferOut(sealedLot.id, unitLandedCost, "separation"),
        {
          lotId: unitLot.id,
          qty: ONE_UNIT,
          movementType: "transfer_in",
          totalCost: unitLandedCost,
          purpose: "separation",
          costLayer: null,
        },
      ]
    : [];

  return ok({
    sealedLotId: openedLotId,
    sealedLotStatusAfter: "open_for_decant",
    openedAt: input.clock.now(),
    separation: unitLot ? { sourceLotId: sealedLot.id, unitLot } : null,
    bulkLot: {
      id: bulkLotId,
      parentLotId: openedLotId,
      qtyInitial,
      landedCostPyg: unitLandedCost,
      unitLandedCostPyg: computeUnitLandedCost(unitLandedCost, qtyInitial),
      // El `unit_cost_minor` del granel es por ml, no por frasco. Mismo
      // redondeo que el costo por ml en guaraníes: `Money.times` es la única
      // vía (money.ts), y `qtyInitial` es positivo (validateNominalVolume).
      unitCost: sealedLot.unitCost.times(1 / qtyInitial.value),
    },
    movements: [
      ...separationMovements,
      transferOut(openedLotId, unitLandedCost, "opening"),
      {
        lotId: bulkLotId,
        qty: qtyInitial,
        movementType: "transfer_in",
        totalCost: unitLandedCost,
        purpose: "opening",
        costLayer: null,
      },
    ],
  });
}
