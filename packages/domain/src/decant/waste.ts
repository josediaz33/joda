// Los tres componentes de la merma de fraccionamiento (RN-FRA-05,
// GLOSARIO.md "Merma técnica"). Confundirlos deja un faltante fantasma de
// 3-5 ml por frasco que se termina tapando con ajustes manuales (ADR-010)
// — modelarlos por separado es la razón de ser de este archivo, no un
// capricho de organización.
import { InvalidDecantInputError } from "../shared/errors.js";
import type { Percentage } from "../shared/percentage.js";
import { Quantity } from "../shared/quantity.js";

// Quantity.ml() admite hasta 3 decimales (shared/quantity.ts) pero
// Quantity.times() no redondea: arrastra el valor crudo de la
// multiplicación, que puede tener más precisión que eso (o arrastrar error
// de punto flotante). RN-FRA-02 pide redondear la merma esperada a 3
// decimales explícitamente ("round(ml_expected × waste_factor, 3)"), así
// que ese redondeo se resuelve acá, no delegando en Quantity.ml() — que
// solo VALIDA la precisión, no la ajusta.
const ML_ROUNDING_SCALE = 1000;

function roundMl(value: number): number {
  return Math.round(value * ML_ROUNDING_SCALE) / ML_ROUNDING_SCALE;
}

/**
 * RN-FRA-02, RN-FRA-05 (trasvase) · la merma proporcional al volumen que se
 * reserva en cada fraccionamiento — la única de las tres que participa de
 * `planDecant` (planning.ts). Las otras dos se disparan en momentos que no
 * son "se está armando un decant": al agotarse el lote
 * (`evaluateUnusableResidue`, más abajo, RN-LOT-04) y por un ajuste
 * periódico que esta versión no calcula (ver la nota al final del
 * archivo).
 *
 * **Ejemplo verificado (RN-FRA-02).** 10 ml esperados con `waste_factor`
 * 2%: 0,200 ml.
 */
export function computeTransferWaste(mlExpected: Quantity, wasteFactor: Percentage): Quantity {
  return Quantity.ml(roundMl(mlExpected.value * wasteFactor.value));
}

export interface UnusableResidueEvaluation {
  readonly depleted: boolean;
  /** `null` si todavía no se agotó; si se agotó, es TODO el saldo restante, no un porcentaje. */
  readonly residueToWasteOff: Quantity | null;
}

/**
 * RN-LOT-04, RN-FRA-05 (fondo no recuperable) · cuando el saldo del granel
 * llega o baja del umbral del producto (`unusable_residue_ml`), el lote se
 * agota y lo que queda se da de baja como merma — el residuo COMPLETO, no
 * una fracción de él.
 *
 * **Ejemplo verificado (RN-LOT-04).** `unusable_residue_ml = 2,5`; el
 * granel queda en 2,3 ml → `waste −2,3` y el lote pasa a `depleted`.
 */
export function evaluateUnusableResidue(input: {
  readonly remaining: Quantity;
  readonly unusableResidueMl: Quantity;
}): UnusableResidueEvaluation {
  if (input.remaining.isNegative()) {
    throw new InvalidDecantInputError(
      `evaluateUnusableResidue requiere un saldo restante no negativo, recibido ${input.remaining.value}.`,
    );
  }

  if (input.remaining.compare(input.unusableResidueMl) > 0) {
    return { depleted: false, residueToWasteOff: null };
  }
  return { depleted: true, residueToWasteOff: input.remaining };
}

// --- Evaporación (RN-FRA-05, tercer componente) ------------------------
//
// "Por tiempo abierto ... ajuste periódico programado" (docs/domain-rules.md
// RN-FRA-05) dice CUÁNDO se aplica, no CÓMO se calcula: ni domain-rules.md,
// ni GLOSARIO.md, ni ADR-010 dan una fórmula o un ejemplo numérico para
// `evaporation_ml_year` (de hecho, en `packages/db/migrations/0003_catalog.sql`
// su valor por defecto es 0). Prorratear linealmente por día es la fórmula
// obvia, pero seguiría siendo una regla de negocio inventada por este
// agente, no una tomada del negocio — exactamente lo que CLAUDE.md pide no
// hacer ("una regla inventada que parece razonable es peor que una
// pregunta"). No se implementa acá: queda declarada como WP-A14 en
// docs/backlog.md, con su propio criterio de aceptación, no como un olvido
// silencioso.
