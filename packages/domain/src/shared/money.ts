// Money — dinero como bigint de unidades enteras, nunca number ni
// decimal.js para PYG (CLAUDE.md § Dinero, RN-DIN-01). El redondeo vive
// acá y en ningún otro lugar (RN-DIN-02): cualquier Math.round sobre un
// importe fuera de esta función está mal.
import {
  CurrencyMismatchError,
  InvalidAllocationError,
  InvalidMoneyAmountError,
} from "./errors.js";

export type Currency = "PYG" | "USD" | "BRL" | "ARS";

// "Media unidad hacia arriba" (RN-DIN-02) es, matemáticamente, "hacia
// +infinito": floor(x + HALF_UNIT_ROUNDING) redondea CUALQUIER mitad
// exacta hacia +infinito, sin rama aparte para negativos — no es un
// truco que solo funcione para el −0,5 de la tabla de la regla. Ese
// caso puntual (−0,5 → 0, no −1) es simplemente lo que da "hacia
// +infinito" ahí: coincide con "hacia el cero" únicamente en esa mitad
// (y en cualquier otra mitad negativa: floor(−1,5 + 0,5) = −1, que
// también es "hacia el cero" desde −1,5). Los dos criterios no
// difieren nunca en una mitad negativa — "hacia +infinito" es,
// simplemente, la regla real; "hacia el cero" es una forma de leer el
// mismo resultado que solo funciona para negativos, no en general (para
// positivos "hacia +infinito" y "hacia arriba" sí coinciden siempre).
const HALF_UNIT_ROUNDING = 0.5;

/** RN-DIN-02 · redondeo de guaraníes: media unidad hacia arriba (hacia +infinito), siempre. */
export function roundPyg(value: number): bigint {
  if (!Number.isFinite(value)) {
    throw new InvalidMoneyAmountError(`roundPyg requiere un número finito, recibido ${value}.`);
  }
  return BigInt(Math.floor(value + HALF_UNIT_ROUNDING));
}

// Money.allocate reparte por "pesos" (weights: number[], no bigint — ver
// docs/domain-contracts.md §3.1), así que se escalan a bigint con esta
// cantidad de decimales antes de repartir, para no arrastrar error de
// punto flotante sobre el TOTAL (que sí es bigint). Alcanza para lo que
// se prorratea en este dominio (valores de línea, volúmenes, cantidades).
const ALLOCATION_WEIGHT_SCALE = 1_000_000;

// Tolerancia para detectar que un peso tenía más de 6 decimales antes de
// escalarlo: sin esto, un peso como 0,1234567 se redondea en silencio a
// 0,123457 y reparte con un sesgo que nadie nota hasta que el flete o el
// IVA de WP-A05/A04 descuadran una miseria en cada línea.
const ALLOCATION_WEIGHT_EPSILON = 1e-6;

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

/**
 * Valida y escala los pesos de `Money.allocate` a bigint. Separado de
 * `allocate` para que cada paso del método del mayor resto tenga nombre:
 * este es "validar" + "escalar".
 */
function scaleWeights(weights: readonly number[]): {
  scaledWeights: bigint[];
  totalWeight: bigint;
} {
  if (weights.length === 0) {
    throw new InvalidAllocationError("Money.allocate requiere al menos un peso.");
  }

  const scaledWeights = weights.map((weight, index) => {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new InvalidAllocationError(
        `Money.allocate requiere pesos finitos y no negativos; el peso en la posición ${index} es ${weight}.`,
      );
    }

    const scaled = weight * ALLOCATION_WEIGHT_SCALE;
    const rounded = Math.round(scaled);
    if (Math.abs(scaled - rounded) > ALLOCATION_WEIGHT_EPSILON) {
      throw new InvalidAllocationError(
        `Money.allocate admite hasta 6 decimales por peso; el peso en la posición ${index} (${weight}) tiene más precisión que eso.`,
      );
    }

    return BigInt(rounded);
  });

  const totalWeight = scaledWeights.reduce((sum, weight) => sum + weight, 0n);
  if (totalWeight === 0n) {
    throw new InvalidAllocationError(
      "Money.allocate requiere que al menos un peso sea mayor que cero.",
    );
  }

  return { scaledWeights, totalWeight };
}

/**
 * Piso de la proporción de cada peso sobre `minor`, y el resto de esa
 * división — la parte "piso + resto" del método del mayor resto.
 */
function computeShares(
  minor: bigint,
  scaledWeights: readonly bigint[],
  totalWeight: bigint,
): { shares: bigint[]; remainders: bigint[] } {
  const shares = scaledWeights.map((weight) => floorDiv(minor * weight, totalWeight));
  const remainders = scaledWeights.map((weight) => floorMod(minor * weight, totalWeight));
  return { shares, remainders };
}

/**
 * Reparte lo que el piso de `computeShares` dejó sin asignar: una unidad
 * más para cada peso con mayor resto, empezando por el más grande y
 * desempatando por índice ascendente — determinístico para el mismo
 * input. Es la parte "decidir el ajuste" + "armar el resultado" del
 * método del mayor resto.
 */
function distributeRemainder(
  minor: bigint,
  shares: readonly bigint[],
  remainders: readonly bigint[],
): bigint[] {
  const distributed = shares.reduce((sum, share) => sum + share, 0n);

  // Identidad del método: 0 <= leftover < weights.length siempre, sin
  // importar el signo de minor (ver el test de total negativo). El
  // Number() de acá es seguro porque leftover nunca excede la cantidad
  // de pesos.
  const leftover = Number(minor - distributed);

  const bumpedIndexes = new Set(
    remainders
      .map((remainder, index) => ({ remainder, index }))
      .sort((a, b) =>
        a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
      )
      .slice(0, leftover)
      .map((entry) => entry.index),
  );

  return shares.map((share, index) => (bumpedIndexes.has(index) ? share + 1n : share));
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

  /**
   * Multiplica por un factor y redondea el resultado con roundPyg — la
   * única FUNCIÓN de redondeo del paquete (RN-DIN-02), aunque no el único
   * call site: `procurement/landedCost.ts::convertToPyg` también la llama
   * directo, sin pasar por `.times()`, porque necesita dividir por 100
   * antes de aplicar el fx (RN-DIN-04) y `.times()` no divide. Lo que
   * importa es que el redondeo en sí vive en un solo lugar (`roundPyg`),
   * no que exista un único punto de entrada a él.
   *
   * `Number(this.minor)` pierde exactitud por encima de
   * `Number.MAX_SAFE_INTEGER` (2^53 − 1): un bigint más grande que eso se
   * redondea al `number` representable más cercano antes de multiplicar
   * por `factor`. No es un problema para los importes de este dominio
   * (ningún guaraní real se acerca a 2^53), pero es real — ver el test
   * "cerca de Number.MAX_SAFE_INTEGER" en money.test.ts.
   */
  times(factor: number): Money {
    if (!Number.isFinite(factor)) {
      throw new InvalidMoneyAmountError(
        `Money.times requiere un factor finito, recibido ${factor}.`,
      );
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
   * división) para que el error de punto flotante nunca toque el total.
   * Los cuatro pasos del método tienen nombre propio en scaleWeights,
   * computeShares y distributeRemainder — acá solo se los encadena.
   *
   * `weights` son MAGNITUDES CRUDAS de cada línea — valor en unidades
   * menores, cantidad, volumen —, nunca proporciones ya calculadas
   * (`0.6`/`0.4`, no `60`/`40`). `scaleWeights` admite hasta 6 decimales
   * por peso: una proporción periódica como `1/3 = 0,3333333...` se
   * trunca ahí y `allocate` lanza `InvalidAllocationError`. Pasar la
   * magnitud cruda (el `value`/`qty`/`volume` de la línea, sin dividir
   * por el total) es lo que evita el problema, además de ser lo que
   * describe `docs/domain-contracts.md` §6.4 para `allocateFreight`.
   */
  allocate(weights: readonly number[]): Money[] {
    const { scaledWeights, totalWeight } = scaleWeights(weights);
    const { shares, remainders } = computeShares(this.minor, scaledWeights, totalWeight);
    const finalShares = distributeRemainder(this.minor, shares, remainders);

    return finalShares.map((share) => new Money(share, this.currency));
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
