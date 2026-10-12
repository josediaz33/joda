// Jerarquía de errores de dominio (docs/domain-contracts.md §4).
//
// Dos categorías, tratadas distinto — y esta jerarquía es sólo para la
// segunda:
//   · Fallo que el negocio contempla (stock insuficiente, transición de
//     estado inválida) → Result<T, E> (ver result.ts). No es un error de
//     esta jerarquía.
//   · Invariante violado que indica un bug del código que llama (sumar
//     monedas distintas, cantidad con unidad incompatible, argumento fuera
//     de rango) → excepción, sin capturar. Es lo que define este archivo.
import type { Currency } from "./money.js";
import type { Uom } from "./quantity.js";

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** RN-DIN-03 · sumar, restar o comparar Money de monedas distintas es un bug del llamador. */
export class CurrencyMismatchError extends DomainError {
  constructor(
    readonly expected: Currency,
    readonly actual: Currency,
  ) {
    super(
      "CURRENCY_MISMATCH",
      `No se puede operar Money de "${expected}" con Money de "${actual}".`,
    );
  }
}

/** ADR-009 · un lote es `unit` o es `ml`, para siempre; operar Quantity de unidades distintas es un bug. */
export class UomMismatchError extends DomainError {
  constructor(
    readonly expected: Uom,
    readonly actual: Uom,
  ) {
    super(
      "UOM_MISMATCH",
      `No se puede operar Quantity de "${expected}" con Quantity de "${actual}".`,
    );
  }
}

/** Quantity.units() con decimales, Quantity.ml() con más de 3 decimales, o un factor no finito. */
export class InvalidQuantityError extends DomainError {
  constructor(message: string) {
    super("INVALID_QUANTITY", message);
  }
}

/** Percentage.of() fuera del rango [0, 1], o con un valor no finito. */
export class InvalidPercentageError extends DomainError {
  constructor(message: string) {
    super("INVALID_PERCENTAGE", message);
  }
}

/** roundPyg() o Money.times() con un valor/factor que no es un número finito. */
export class InvalidMoneyAmountError extends DomainError {
  constructor(message: string) {
    super("INVALID_MONEY_AMOUNT", message);
  }
}

/** Money.allocate() con pesos vacíos, negativos, no finitos, o que suman cero. */
export class InvalidAllocationError extends DomainError {
  constructor(message: string) {
    super("INVALID_ALLOCATION", message);
  }
}

/** breakdownDocument() con un arreglo de líneas vacío: no hay bruto que desglosar (RN-IVA). */
export class InvalidVatDocumentError extends DomainError {
  constructor(message: string) {
    super("INVALID_VAT_DOCUMENT", message);
  }
}

/**
 * computeLandedCost() con un fxRateToPyg no finito o no positivo, o con
 * componentes ya en PYG (nada que convertir); computeUnitLandedCost() con
 * qtyInitial no positivo (RN-COS-01, RN-COS-03).
 */
export class InvalidLandedCostInputError extends DomainError {
  constructor(message: string) {
    super("INVALID_LANDED_COST_INPUT", message);
  }
}

/** allocateFromLots() con `required` negativo: argumento fuera de rango, no un fallo que el negocio contemple (RN-COS-04). */
export class InvalidAllocationRequestError extends DomainError {
  constructor(message: string) {
    super("INVALID_ALLOCATION_REQUEST", message);
  }
}

/**
 * Argumento fuera de rango en packages/domain/src/decant/*: `unitsRequested`
 * no entero o no positivo, `mlPerUnit`/`perUnit` no positivo, o un saldo
 * restante negativo en `evaluateUnusableResidue`. Mismo criterio que
 * `InvalidLandedCostInputError`: "argumento fuera de rango" es un bug del
 * llamador (docs/domain-contracts.md §4.2), no un fallo que el negocio
 * contemple — a diferencia de granel o insumo insuficiente, que sí lo son
 * y por eso viajan en `DecantError` (decant/planning.ts), no acá.
 */
export class InvalidDecantInputError extends DomainError {
  constructor(message: string) {
    super("INVALID_DECANT_INPUT", message);
  }
}

/** openLot() (inventory/lotOpening.ts, ADR-009) con nominalVolumeMl no positivo o no finito, o con `qtyInitial`/`onHand` del lote sellado que no son unidades válidas: argumento fuera de rango, no un fallo que el negocio contemple. */
export class InvalidLotOpeningInputError extends DomainError {
  constructor(message: string) {
    super("INVALID_LOT_OPENING_INPUT", message);
  }
}

/** planSerializedUnitRegistration() (inventory/serializedUnit.ts, RN-SER-03) con una capacidad que no son unidades enteras de al menos 1, o con unidades ya registradas negativas o no enteras: argumento fuera de rango, no un fallo que el negocio contemple. */
export class InvalidSerializedUnitInputError extends DomainError {
  constructor(message: string) {
    super("INVALID_SERIALIZED_UNIT_INPUT", message);
  }
}

/** computeManualHoldExpiresAt() (sales/reservation.ts, RN-RES-02) con days no positivo o no finito: argumento fuera de rango, no un fallo que el negocio contemple. */
export class InvalidReservationInputError extends DomainError {
  constructor(message: string) {
    super("INVALID_RESERVATION_INPUT", message);
  }
}

/** applyDepositToOrder() (sales/deposit.ts, RN-SEN-02) con un monto a aplicar no positivo: argumento fuera de rango, no un fallo que el negocio contemple. */
export class InvalidDepositInputError extends DomainError {
  constructor(message: string) {
    super("INVALID_DEPOSIT_INPUT", message);
  }
}

/** projectScenarioLines() (sourcing/scenario.ts, RN-SRC-02) con un projectedPricePyg cero o negativo: no hay margen que calcular, argumento fuera de rango. */
export class InvalidSourcingInputError extends DomainError {
  constructor(message: string) {
    super("INVALID_SOURCING_INPUT", message);
  }
}

/** priceSaleOrder() (sales/orderPricing.ts, RN-VTA-01, RN-IVA-02) sin líneas, o con una cantidad que no es un entero positivo: argumento fuera de rango, no un fallo que el negocio contemple (el contrato de la API ya lo rechazó antes de llegar acá). */
export class InvalidSaleOrderInputError extends DomainError {
  constructor(message: string) {
    super("INVALID_SALE_ORDER_INPUT", message);
  }
}
