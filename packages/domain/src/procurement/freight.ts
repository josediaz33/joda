// Prorrateo de flete (RN-COS-02; docs/domain-contracts.md §6.4). Los tres
// métodos proporcionales (by_value, by_unit, by_volume) reparten con el
// MISMO algoritmo — Money.allocate, el método del mayor resto de WP-A03
// (shared/money.ts) — sin caso especial por método. Lo único que cambia
// entre ellos es de dónde sale el peso de cada línea: valor, cantidad o
// volumen. Ver RN-COS-02 para el contraejemplo (60/40, flete 7) que
// muestra por qué esto es distinto de imputar la diferencia "a la línea
// de mayor valor" — ese criterio quedó descartado a propósito, no es un
// olvido.
//
// `manual` no prorratea nada: el operador ya fijó el flete de cada línea
// (`manualAmount`); esta función solo valida que la suma coincida con el
// flete total.
import { Money } from "../shared/money.js";
import type { Quantity } from "../shared/quantity.js";
import { err, ok, type Result } from "../shared/result.js";

export type FreightMethod = "by_value" | "by_unit" | "by_volume" | "manual";

export interface FreightLine {
  readonly id: string;
  readonly value: Money;
  readonly qty: Quantity;
  /** Requerido si el método es `"by_volume"`. */
  readonly volume?: number;
  /** Requerido si el método es `"manual"`; ignorado en los demás. */
  readonly manualAmount?: Money;
}

export type FreightError =
  | { readonly code: "EMPTY_LINES" }
  | { readonly code: "ZERO_TOTAL_WEIGHT" }
  | { readonly code: "MISSING_VOLUME"; readonly lineId: string }
  | { readonly code: "MISSING_MANUAL_AMOUNT"; readonly lineId: string }
  | {
      readonly code: "MANUAL_SUM_MISMATCH";
      readonly expected: Money;
      readonly actual: Money;
    };

export interface AllocateFreightInput {
  readonly freight: Money;
  readonly method: FreightMethod;
  readonly lines: readonly FreightLine[];
}

type ProportionalMethod = Exclude<FreightMethod, "manual">;

/** El peso crudo (no una proporción) que cada método le pasa a Money.allocate. */
function weightOf(method: ProportionalMethod, line: FreightLine): number {
  switch (method) {
    case "by_value":
      return Number(line.value.minor);
    case "by_unit":
      return line.qty.value;
    case "by_volume":
      // Validado por allocateProportional antes de llegar acá.
      return line.volume!;
  }
}

function allocateProportional(
  freight: Money,
  method: ProportionalMethod,
  lines: readonly FreightLine[],
): Result<ReadonlyMap<string, Money>, FreightError> {
  if (method === "by_volume") {
    const missingVolume = lines.find((line) => line.volume === undefined);
    if (missingVolume) {
      return err({ code: "MISSING_VOLUME", lineId: missingVolume.id });
    }
  }

  const weights = lines.map((line) => weightOf(method, line));
  if (weights.every((weight) => weight === 0)) {
    return err({ code: "ZERO_TOTAL_WEIGHT" });
  }

  const shares = freight.allocate(weights);
  return ok(new Map(lines.map((line, index) => [line.id, shares[index]!])));
}

function allocateManual(
  freight: Money,
  lines: readonly FreightLine[],
): Result<ReadonlyMap<string, Money>, FreightError> {
  const missingAmount = lines.find((line) => line.manualAmount === undefined);
  if (missingAmount) {
    return err({ code: "MISSING_MANUAL_AMOUNT", lineId: missingAmount.id });
  }

  const zero = Money.zero(freight.currency);
  const total = lines.reduce((sum, line) => sum.plus(line.manualAmount!), zero);

  if (total.compare(freight) !== 0) {
    return err({ code: "MANUAL_SUM_MISMATCH", expected: freight, actual: total });
  }

  return ok(new Map(lines.map((line) => [line.id, line.manualAmount!])));
}

/**
 * RN-COS-02 · reparte `freight` entre `lines` según `method`. Devuelve el
 * flete de cada línea indexado por `id`; la suma de los valores del mapa
 * es siempre exactamente igual a `freight` (o la función falla con
 * `FreightError`, nunca reparte de más ni de menos).
 */
export function allocateFreight(
  input: AllocateFreightInput,
): Result<ReadonlyMap<string, Money>, FreightError> {
  if (input.lines.length === 0) {
    return err({ code: "EMPTY_LINES" });
  }

  if (input.method === "manual") {
    return allocateManual(input.freight, input.lines);
  }

  return allocateProportional(input.freight, input.method, input.lines);
}
