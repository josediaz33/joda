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
    super("CURRENCY_MISMATCH", `No se puede operar Money de "${expected}" con Money de "${actual}".`);
  }
}

/** ADR-009 · un lote es `unit` o es `ml`, para siempre; operar Quantity de unidades distintas es un bug. */
export class UomMismatchError extends DomainError {
  constructor(
    readonly expected: Uom,
    readonly actual: Uom,
  ) {
    super("UOM_MISMATCH", `No se puede operar Quantity de "${expected}" con Quantity de "${actual}".`);
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
