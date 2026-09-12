// IVA paraguayo (docs/domain-rules.md § RN-IVA, docs/domain-contracts.md
// §6.3). El precio siempre viene CON impuesto incluido: el IVA se EXTRAE de
// un monto bruto, nunca se agrega (RN-IVA-01) — 10% es total/11, 5% es
// total/21. "total × 0.10" está prohibido en cualquier lugar de este
// archivo.
import { InvalidVatDocumentError } from "../shared/errors.js";
import { Money } from "../shared/money.js";

export type VatRate = "iva_10" | "iva_5" | "exenta";

// Extraer el IVA de un bruto es multiplicar por 1/divisor: total/11 y
// total×(1/11) son la misma fracción, y expresarlo como factor deja que
// Money.times() —y su único roundPyg()— hagan la división Y el redondeo en
// un solo lugar, en vez de reimplementar acá una división en bigint.
const VAT_DIVISOR: Record<Exclude<VatRate, "exenta">, number> = {
  iva_10: 11,
  iva_5: 21,
};

// Espejo SQL de esta función: app.vat_from_gross() en
// packages/db/migrations/0001_foundation.sql, que a su vez llama a
// app.round_pyg() — el "media unidad hacia arriba" de RN-DIN-02 tiene su
// propio espejo en roundPyg() (shared/money.ts). Los dos NO usan la misma
// regla de desempate: round(numeric, 0) de Postgres desempata "lejos de
// cero" (round(-0.5) = -1), mientras que roundPyg() documenta "hacia
// +infinito" (roundPyg(-0.5) = 0, ver RN-DIN-02). Para esta función en
// particular esa diferencia nunca se manifiesta: 11 y 21 son impares, así
// que gross/11 y gross/21 no pueden dar nunca una fracción exacta de .5
// (eso requeriría un resto igual a divisor/2, que no es entero cuando el
// divisor es impar) — no hay empate que desempatar, y ambos redondeos
// convergen al mismo entero más cercano para cualquier gross, incluido
// negativo. Ver el describe "espejo SQL — RN-DIN-02" en vat.test.ts, que
// fija en un test los cuatro guaraníes negativos más cercanos posibles a
// esa fracción .5 para ambas tasas.
//
// Esto NO dice nada sobre roundPyg()/round_pyg() en general (Money.times()
// con un factor de cambio arbitrario sí puede caer justo en un medio) —
// eso es un problema de shared/money.ts, fuera de esta función y de WP-A04.

/** RN-IVA-01 · IVA contenido en un bruto con impuesto incluido: total/11 (10%), total/21 (5%), o 0 (exenta). */
export function vatFromGross(gross: Money, rate: VatRate): Money {
  if (rate === "exenta") {
    return Money.zero(gross.currency);
  }
  return gross.times(1 / VAT_DIVISOR[rate]);
}

/** RN-IVA-04 · base gravada = bruto − IVA, nunca un cálculo independiente. Garantiza base + iva = bruto, exacto. */
export function taxBase(gross: Money, rate: VatRate): Money {
  return gross.minus(vatFromGross(gross, rate));
}

export interface DocumentVatLine {
  readonly gross: Money;
  readonly rate: VatRate;
  readonly vat: Money;
  readonly base: Money;
  /**
   * RN-IVA-03 · la diferencia de redondeo "queda registrada": el monto
   * que esta línea recibió por ser la última de su tasa, ya incluido en
   * `vat`. Cero cuando la línea no recibió ajuste (incluidas todas las
   * de `exenta`, que nunca lo reciben).
   * `vatFromGross(gross, rate).plus(roundingAdjustment) === vat`, siempre.
   */
  readonly roundingAdjustment: Money;
}

export interface DocumentVatBreakdown {
  readonly lines: readonly DocumentVatLine[];
  readonly totalGross: Money;
  readonly totalVat: Money;
  readonly totalBase: Money;
}

/** RN-IVA-01, sin ajustar todavía por RN-IVA-02/03: el IVA de cada línea, calculado individualmente. */
function computeLineVats(lines: readonly { gross: Money; rate: VatRate }[]): Money[] {
  return lines.map((line) => vatFromGross(line.gross, line.rate));
}

/**
 * Índices de `lines` agrupados por tasa, en el orden en que aparecen. Es lo
 * que necesita RN-IVA-03 para saber cuál es "la última línea de la tasa" y
 * para que cada tasa se reconcilie de forma independiente de las demás.
 */
function groupIndexesByRate(lines: readonly { rate: VatRate }[]): Map<VatRate, number[]> {
  const indexesByRate = new Map<VatRate, number[]>();
  lines.forEach((line, index) => {
    const indexes = indexesByRate.get(line.rate) ?? [];
    indexes.push(index);
    indexesByRate.set(line.rate, indexes);
  });
  return indexesByRate;
}

/**
 * RN-IVA-02/03 · Ajusta, en el lugar (`vats` y `adjustments`), los IVA de
 * línea de UNA tasa gravada: el que manda es el IVA del TOTAL gravado por
 * esa tasa (RN-IVA-02), no la suma de los IVA de línea ya redondeados. La
 * diferencia entre ambos se imputa íntegra a la última línea de esa tasa
 * (RN-IVA-03) — y queda registrada aparte en `adjustments`, no solo sumada
 * a `vats`, para que "queda registrada" sea auditable y no haya que
 * volver a calcular `vatFromGross` para reconstruirla.
 */
function reconcileRateGroup(
  lines: readonly { gross: Money }[],
  vats: Money[],
  adjustments: Money[],
  indexes: readonly number[],
  rate: Exclude<VatRate, "exenta">,
  zero: Money,
): void {
  const grossForRate = indexes.reduce((sum, i) => sum.plus(lines[i]!.gross), zero);
  const documentVat = vatFromGross(grossForRate, rate);
  const lineVatSum = indexes.reduce((sum, i) => sum.plus(vats[i]!), zero);

  const roundingDiff = documentVat.minus(lineVatSum);
  if (!roundingDiff.isZero()) {
    const lastIndex = indexes[indexes.length - 1]!;
    vats[lastIndex] = vats[lastIndex]!.plus(roundingDiff);
    adjustments[lastIndex] = adjustments[lastIndex]!.plus(roundingDiff);
  }
}

/** RN-IVA-04 · une cada línea con su IVA ya ajustado, su base derivada (bruto − iva) y el ajuste que registra RN-IVA-03. */
function buildDocumentLines(
  lines: readonly { gross: Money; rate: VatRate }[],
  vats: readonly Money[],
  adjustments: readonly Money[],
): DocumentVatLine[] {
  return lines.map((line, index) => {
    const vat = vats[index]!;
    return {
      gross: line.gross,
      rate: line.rate,
      vat,
      base: line.gross.minus(vat),
      roundingAdjustment: adjustments[index]!,
    };
  });
}

/** Suma bruto, IVA y base de todas las líneas — por construcción, totalBase + totalVat = totalGross. */
function sumTotals(
  lines: readonly DocumentVatLine[],
  zero: Money,
): Pick<DocumentVatBreakdown, "totalGross" | "totalVat" | "totalBase"> {
  return lines.reduce(
    (acc, line) => ({
      totalGross: acc.totalGross.plus(line.gross),
      totalVat: acc.totalVat.plus(line.vat),
      totalBase: acc.totalBase.plus(line.base),
    }),
    { totalGross: zero, totalVat: zero, totalBase: zero },
  );
}

/**
 * Desglosa un documento completo (RN-IVA-02, RN-IVA-03, RN-IVA-04). Ver
 * `computeLineVats`, `groupIndexesByRate`, `reconcileRateGroup`,
 * `buildDocumentLines` y `sumTotals` para cada paso — la misma
 * descomposición con nombre que usa `Money.allocate` (shared/money.ts)
 * para su propio método del mayor resto.
 */
export function breakdownDocument(
  lines: readonly { gross: Money; rate: VatRate }[],
): DocumentVatBreakdown {
  if (lines.length === 0) {
    throw new InvalidVatDocumentError("breakdownDocument requiere al menos una línea.");
  }

  const currency = lines[0]!.gross.currency;
  const zero = Money.zero(currency);

  const vats = computeLineVats(lines);
  const adjustments = lines.map(() => zero);
  const indexesByRate = groupIndexesByRate(lines);
  for (const [rate, indexes] of indexesByRate) {
    if (rate === "exenta") continue; // sin IVA que redondear ni imputar
    reconcileRateGroup(lines, vats, adjustments, indexes, rate, zero);
  }

  const documentLines = buildDocumentLines(lines, vats, adjustments);
  const totals = sumTotals(documentLines, zero);

  return { lines: documentLines, ...totals };
}
