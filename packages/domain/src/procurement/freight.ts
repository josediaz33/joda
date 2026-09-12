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
import type { Currency } from "../shared/money.js";
import { Money } from "../shared/money.js";
import type { Quantity, Uom } from "../shared/quantity.js";
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

// FreightError es una unión de OBJETOS PLANOS con `code`, no una jerarquía
// de clases como DomainError (shared/errors.ts) — a propósito, y por una
// razón distinta en cada caso:
//   · DomainError es para lo que se LANZA sin capturar (bug del llamador);
//     estos valores se DEVUELVEN dentro de un Result (fallo que el negocio
//     contempla, docs/domain-contracts.md §4.1) — no necesitan la
//     maquinaria de Error (stack, mensaje, prototipo) porque nadie los
//     hace throw.
//   · Un objeto plano con `code` se compara con `toEqual` en los tests
//     (`expect(result).toEqual({ ok: false, error: { code: "..." } })`)
//     sin depender de un mensaje de texto que se pueda desalinear del
//     código; una instancia de clase obligaría a comparar por campos uno
//     por uno o a ignorar el mensaje.
export type FreightError =
  | { readonly code: "EMPTY_LINES" }
  | { readonly code: "ZERO_TOTAL_WEIGHT" }
  | { readonly code: "MISSING_VOLUME"; readonly lineId: string }
  | { readonly code: "MISSING_MANUAL_AMOUNT"; readonly lineId: string }
  | {
      readonly code: "LINE_CURRENCY_MISMATCH";
      readonly lineId: string;
      readonly expected: Currency;
      readonly actual: Currency;
    }
  | {
      readonly code: "LINE_UOM_MISMATCH";
      readonly lineId: string;
      readonly expected: Uom;
      readonly actual: Uom;
    }
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
      // Validado por validateProportionalLines antes de llegar acá.
      return line.volume!;
  }
}

/** by_value pesa `value.minor`: si dos líneas no comparten moneda, esa magnitud no es comparable entre ellas (RN-DIN-03). */
function findCurrencyMismatch(lines: readonly FreightLine[]): FreightError | undefined {
  const expected = lines[0]!.value.currency;
  const mismatched = lines.find((line) => line.value.currency !== expected);
  if (!mismatched) return undefined;
  return {
    code: "LINE_CURRENCY_MISMATCH",
    lineId: mismatched.id,
    expected,
    actual: mismatched.value.currency,
  };
}

/** by_unit pesa `qty.value`: si dos líneas no comparten Uom (`ml` vs. `unit`), esa magnitud tampoco es comparable (ADR-009). */
function findUomMismatch(lines: readonly FreightLine[]): FreightError | undefined {
  const expected = lines[0]!.qty.uom;
  const mismatched = lines.find((line) => line.qty.uom !== expected);
  if (!mismatched) return undefined;
  return {
    code: "LINE_UOM_MISMATCH",
    lineId: mismatched.id,
    expected,
    actual: mismatched.qty.uom,
  };
}

/** by_volume pesa `volume`: no hay nada que lo derive de otro campo si falta. */
function findMissingVolume(lines: readonly FreightLine[]): FreightError | undefined {
  const missing = lines.find((line) => line.volume === undefined);
  if (!missing) return undefined;
  return { code: "MISSING_VOLUME", lineId: missing.id };
}

/**
 * Cada método proporcional valida solo lo que su propio peso necesita —
 * ninguno de los tres necesita las tres validaciones a la vez. Separado
 * de `computeWeights` para que "esto no se puede prorratear con datos
 * así" y "así se prorratea" sean dos preguntas distintas.
 */
function validateProportionalLines(
  method: ProportionalMethod,
  lines: readonly FreightLine[],
): FreightError | undefined {
  switch (method) {
    case "by_value":
      return findCurrencyMismatch(lines);
    case "by_unit":
      return findUomMismatch(lines);
    case "by_volume":
      return findMissingVolume(lines);
  }
}

function computeWeights(method: ProportionalMethod, lines: readonly FreightLine[]): number[] {
  return lines.map((line) => weightOf(method, line));
}

function allocateProportional(
  freight: Money,
  method: ProportionalMethod,
  lines: readonly FreightLine[],
): Result<ReadonlyMap<string, Money>, FreightError> {
  const validationError = validateProportionalLines(method, lines);
  if (validationError) {
    return err(validationError);
  }

  const weights = computeWeights(method, lines);
  // Se intercepta ACÁ, antes de llamar a Money.allocate, en vez de dejar
  // que allocate() tire su propia InvalidAllocationError: esto es un
  // fallo de negocio (todas las líneas de la recepción con valor/cantidad
  // en cero) que el llamador puede provocar con datos reales, no un bug
  // de programación — corresponde Result (docs/domain-contracts.md §4.1),
  // no una excepción sin capturar.
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
