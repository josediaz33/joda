// Quantity — cantidad con unidad de medida explícita ('unit' o 'ml'). Un
// lote nace con una y no cambia nunca (RN-LOT-01, ADR-009); operar dos
// Quantity de unidades distintas es un bug, no un caso de negocio
// (UomMismatchError).
import { InvalidQuantityError, UomMismatchError } from "./errors.js";

export type Uom = "unit" | "ml";

// Quantity.ml() acepta hasta 3 decimales (docs/domain-contracts.md §3.2).
// La comparación tolera el error de representación binaria habitual de
// los literales decimales (10.1 * 1000 no da exactamente 10100 en punto
// flotante) sin aflojar el límite real de 3 decimales.
const ML_SCALE = 1000;
const ML_SCALE_EPSILON = 1e-9;

export class Quantity {
  private constructor(
    readonly value: number,
    readonly uom: Uom,
  ) {}

  /** Entero, siempre — media unidad de reloj no existe. */
  static units(n: number): Quantity {
    if (!Number.isInteger(n)) {
      throw new InvalidQuantityError(`Quantity.units requiere un entero, recibido ${n}.`);
    }
    return new Quantity(n, "unit");
  }

  /** Hasta 3 decimales. */
  static ml(n: number): Quantity {
    if (!Number.isFinite(n)) {
      throw new InvalidQuantityError(`Quantity.ml requiere un número finito, recibido ${n}.`);
    }

    const scaled = n * ML_SCALE;
    const rounded = Math.round(scaled);
    if (Math.abs(scaled - rounded) > ML_SCALE_EPSILON) {
      throw new InvalidQuantityError(`Quantity.ml admite hasta 3 decimales, recibido ${n}.`);
    }

    return new Quantity(rounded / ML_SCALE, "ml");
  }

  private assertSameUom(other: Quantity): void {
    if (this.uom !== other.uom) {
      throw new UomMismatchError(this.uom, other.uom);
    }
  }

  plus(other: Quantity): Quantity {
    this.assertSameUom(other);
    return new Quantity(this.value + other.value, this.uom);
  }

  minus(other: Quantity): Quantity {
    this.assertSameUom(other);
    return new Quantity(this.value - other.value, this.uom);
  }

  times(factor: number): Quantity {
    if (!Number.isFinite(factor)) {
      throw new InvalidQuantityError(
        `Quantity.times requiere un factor finito, recibido ${factor}.`,
      );
    }

    const result = this.value * factor;
    // A diferencia de plus/minus —donde sumar o restar dos enteros da
    // siempre un entero, sin nada que revisar—, times() multiplica por un
    // factor arbitrario y puede romper el invariante de 'unit' (entero,
    // siempre): Quantity.units(3).times(0.5) sin esta guarda daría una
    // Quantity de uom 'unit' con value 1.5. Media unidad de reloj sigue
    // sin existir después de multiplicar, no solo al construir.
    if (this.uom === "unit" && !Number.isInteger(result)) {
      throw new InvalidQuantityError(
        `Quantity.times sobre 'unit' debe dar un entero; ${this.value} × ${factor} = ${result}.`,
      );
    }

    return new Quantity(result, this.uom);
  }

  isNegative(): boolean {
    return this.value < 0;
  }

  compare(other: Quantity): -1 | 0 | 1 {
    this.assertSameUom(other);
    if (this.value === other.value) return 0;
    return this.value < other.value ? -1 : 1;
  }
}
