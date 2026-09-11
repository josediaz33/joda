// Money — dinero como bigint de unidades enteras, nunca number ni
// decimal.js para PYG (CLAUDE.md § Dinero, RN-DIN-01). El redondeo vive
// acá y en ningún otro lugar (RN-DIN-02): cualquier Math.round sobre un
// importe fuera de esta función está mal.
import { CurrencyMismatchError, InvalidAllocationError, InvalidMoneyAmountError } from "./errors.js";

export type Currency = "PYG" | "USD" | "BRL" | "ARS";

/**
 * RN-DIN-02 · redondeo de guaraníes: media unidad hacia arriba, siempre.
 * Caso borde: −0,5 redondea a 0, no a −1. En este único punto "hacia el
 * cero" para negativos coincide con "hacia arriba" — floor(x + 0,5) da los
 * cuatro valores de la tabla de la regla sin necesitar una rama aparte
 * para negativos.
 */
export function roundPyg(value: number): bigint {
  if (!Number.isFinite(value)) {
    throw new InvalidMoneyAmountError(`roundPyg requiere un número finito, recibido ${value}.`);
  }
  return BigInt(Math.floor(value + 0.5));
}

// Money.allocate reparte por "pesos" (weights: number[], no bigint — ver
// docs/domain-contracts.md §3.1), así que se escalan a bigint con esta
// cantidad de decimales antes de repartir, para no arrastrar error de
// punto flotante sobre el TOTAL (que si es bigint). Alcanza para lo que
// se prorratea en este dominio (valores de línea, volúmenes, cantidades);
// un peso con más de 6 decimales pierde precisión más allá de eso.
const ALLOCATION_WEIGHT_SCALE = 1_000_000;

// bigint / y % truncan hacia cero, no hacia -infinito. allocate necesita
// división de piso para que el "resto" quede siempre en [0, divisor) sin
// importar el signo del dividendo — así el método del mayor resto reparte
// igual de bien un total negativo (una nota de crédito, por ejemplo).
function floorDiv(dividend: bigint, divisor: bigint): bigint {
  const quotient = dividend / divisor;
  const remainder = dividend % divisor;
  return remainder !== 0n && remainder < 0n !== divisor < 0n ? quotient - 1n : quotient;
}

function floorMod(dividend: bigint, divisor: bigint): bigint {
  const remainder = dividend % divisor;
  return remainder !== 0n && remainder < 0n !== divisor < 0n ? remainder + divisor : remainder;
}

export class Money {
  private constructor(
    readonly minor: bigint,
    readonly currency: Currency,
  ) {}

  static pyg(units: bigint): Money {
    return new Money(units, "PYG");
  }

  static of(minor: bigint, currency: Currency): Money {
    return new Money(minor, currency);
  }

  static zero(currency: Currency): Money {
    return new Money(0n, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  /** RN-DIN-03 · sumar monedas distintas lanza; nunca convierte implícito. */
  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  /** RN-DIN-03 · restar monedas distintas lanza; nunca convierte implícito. */
  minus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  /** Multiplica por un factor y redondea el resultado con roundPyg — el único redondeo del paquete. */
  times(factor: number): Money {
    if (!Number.isFinite(factor)) {
      throw new InvalidMoneyAmountError(`Money.times requiere un factor finito, recibido ${factor}.`);
    }
    return new Money(roundPyg(Number(this.minor) * factor), this.currency);
  }

  /**
   * Reparte este importe entre `weights` sin perder ni ganar unidades: la
   * suma de las partes es exactamente `this.minor`, siempre. Sostiene el
   * prorrateo de flete y de IVA (docs/domain-contracts.md §3.1) — si esto
   * falla, esos prorrateos descuadran meses después sin que nadie sepa
   * por qué.
   *
   * Método del mayor resto, hecho enteramente en bigint (incluida la
   * división) para que el error de punto flotante nunca toque el total:
   * cada parte recibe el piso de su proporción, y las unidades que
   * sobran por el redondeo hacia abajo se reparten de a una entre los
   * pesos con mayor resto, empezando por el más grande y desempatando
   * por índice ascendente — determinístico para el mismo input.
   */
  allocate(weights: readonly number[]): Money[] {
    if (weights.length === 0) {
      throw new InvalidAllocationError("Money.allocate requiere al menos un peso.");
    }

    const scaledWeights = weights.map((weight, index) => {
      if (!Number.isFinite(weight) || weight < 0) {
        throw new InvalidAllocationError(
          `Money.allocate requiere pesos finitos y no negativos; el peso en la posición ${index} es ${weight}.`,
        );
      }
      return BigInt(Math.round(weight * ALLOCATION_WEIGHT_SCALE));
    });

    const totalWeight = scaledWeights.reduce((sum, weight) => sum + weight, 0n);
    if (totalWeight === 0n) {
      throw new InvalidAllocationError("Money.allocate requiere que al menos un peso sea mayor que cero.");
    }

    const shares = scaledWeights.map((weight) => floorDiv(this.minor * weight, totalWeight));
    const remainders = scaledWeights.map((weight) => floorMod(this.minor * weight, totalWeight));
    const distributed = shares.reduce((sum, share) => sum + share, 0n);

    // Identidad del método: 0 <= leftover < weights.length siempre, sin
    // importar el signo de this.minor (ver el test de total negativo). El
    // Number() de acá es seguro porque leftover nunca excede la cantidad
    // de pesos.
    const leftover = Number(this.minor - distributed);

    const bumpedIndexes = new Set(
      remainders
        .map((remainder, index) => ({ remainder, index }))
        .sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1))
        .slice(0, leftover)
        .map((entry) => entry.index),
    );

    return shares.map((share, index) => new Money(bumpedIndexes.has(index) ? share + 1n : share, this.currency));
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.minor === other.minor) return 0;
    return this.minor < other.minor ? -1 : 1;
  }

  toJSON(): { minor: string; currency: Currency } {
    return { minor: this.minor.toString(), currency: this.currency };
  }
}
