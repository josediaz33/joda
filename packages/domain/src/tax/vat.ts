// IVA paraguayo (docs/domain-rules.md § RN-IVA, docs/domain-contracts.md
// §6.3). El precio siempre viene CON impuesto incluido: el IVA se EXTRAE de
// un monto bruto, nunca se agrega (RN-IVA-01) — 10% es total/11, 5% es
// total/21. "total × 0.10" está prohibido en cualquier lugar de este
// archivo.
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
}

export interface DocumentVatBreakdown {
  readonly lines: readonly DocumentVatLine[];
  readonly totalGross: Money;
  readonly totalVat: Money;
  readonly totalBase: Money;
}

/**
 * Desglosa un documento completo (RN-IVA-02, RN-IVA-03, RN-IVA-04).
 *
 * El IVA de cada línea se calcula individualmente con RN-IVA-01, pero el
 * redondeo que manda es el del TOTAL gravado por tasa (RN-IVA-02: el
 * redondeo se resuelve a nivel de documento, no de línea) — no la suma de
 * los IVA de línea ya redondeados. La diferencia entre ambos se imputa
 * íntegra a la última línea de esa tasa, en el orden en que aparece en
 * `lines` (RN-IVA-03). Tasas distintas se resuelven de forma independiente:
 * la diferencia de una tasa nunca se imputa a una línea de otra tasa.
 *
 * La base de cada línea sale de bruto − IVA ya ajustado (RN-IVA-04), así
 * que `base + iva = bruto` vale siempre, línea por línea y en los totales
 * del documento.
 */
export function breakdownDocument(
  lines: readonly { gross: Money; rate: VatRate }[],
): DocumentVatBreakdown {
  const currency = lines[0]!.gross.currency;
  const zero = Money.zero(currency);

  // RN-IVA-01, sin ajustar todavía.
  const vats = lines.map((line) => vatFromGross(line.gross, line.rate));

  const indexesByRate = new Map<VatRate, number[]>();
  lines.forEach((line, index) => {
    const indexes = indexesByRate.get(line.rate) ?? [];
    indexes.push(index);
    indexesByRate.set(line.rate, indexes);
  });

  for (const [rate, indexes] of indexesByRate) {
    if (rate === "exenta") continue; // sin IVA que redondear ni imputar

    const grossForRate = indexes.reduce((sum, i) => sum.plus(lines[i]!.gross), zero);
    const documentVat = vatFromGross(grossForRate, rate); // RN-IVA-02
    const lineVatSum = indexes.reduce((sum, i) => sum.plus(vats[i]!), zero);

    const roundingDiff = documentVat.minus(lineVatSum);
    if (!roundingDiff.isZero()) {
      const lastIndex = indexes[indexes.length - 1]!;
      vats[lastIndex] = vats[lastIndex]!.plus(roundingDiff); // RN-IVA-03
    }
  }

  const documentLines: DocumentVatLine[] = lines.map((line, index) => {
    const vat = vats[index]!;
    return { gross: line.gross, rate: line.rate, vat, base: line.gross.minus(vat) }; // RN-IVA-04
  });

  const totals = documentLines.reduce(
    (acc, line) => ({
      totalGross: acc.totalGross.plus(line.gross),
      totalVat: acc.totalVat.plus(line.vat),
      totalBase: acc.totalBase.plus(line.base),
    }),
    { totalGross: zero, totalVat: zero, totalBase: zero },
  );

  return { lines: documentLines, ...totals };
}
