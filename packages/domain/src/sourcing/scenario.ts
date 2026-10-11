// Sourcing — escenarios de compra y su comparación (RF-SRC-01…03, WP-C16,
// docs/domain-rules.md RN-SRC-01…03). RF-SRC-04 (un escenario no toca
// inventario ni caja) no tiene fórmula propia: es la garantía arquitectónica
// de que este paquete no hace I/O, así que ninguna función de aquí abajo
// puede escribir en el ledger. RF-SRC-05 (convertir un escenario en orden de
// compra) es una escritura — pertenece a apps/api, WP-C16b.
//
// Reusa procurement/landedCost.ts y procurement/freight.ts (WP-A05) sin
// duplicarlos: el arancel entra como `other` de LandedCostComponents, y el
// flete se prorratea con el mismo allocateFreight de siempre.
import { InvalidSourcingInputError } from "../shared/errors.js";
import { Money } from "../shared/money.js";
import type { Percentage } from "../shared/percentage.js";
import type { Quantity } from "../shared/quantity.js";
import { err, ok, type Result } from "../shared/result.js";
import { computeLandedCost, computeUnitLandedCost } from "../procurement/landedCost.js";
import {
  allocateFreight,
  type FreightError,
  type FreightLine,
  type FreightMethod,
} from "../procurement/freight.js";
import { taxBase, type VatRate } from "../tax/vat.js";

// round3 NO es roundPyg: roundPyg (RN-DIN-02) redondea guaraníes enteros, y
// un porcentaje no es un importe en Gs. Mismo criterio de desempate —media
// unidad hacia +infinito— por consistencia con el resto del dominio, no
// porque la regla de dinero se extienda a esto (RN-SRC-02).
const MARGIN_PCT_SCALE = 1000;
function round3(value: number): number {
  return Math.floor(value * MARGIN_PCT_SCALE + 0.5) / MARGIN_PCT_SCALE;
}

export interface ScenarioLineInput {
  readonly id: string;
  readonly variantId: string;
  /** 'A' | 'B' | ... — para agrupar y comparar alternativas de la misma variante (GLOSARIO.md "Sourcing / escenario"). */
  readonly variantLabel?: string;
  readonly qty: Quantity;
  /** Precio del proveedor, por unidad, en la moneda extranjera de la línea. */
  readonly unitPrice: Money;
  /** fx asumido de ESTA línea (sourcing_scenario_lines.fx_assumed) — puede diferir entre líneas del mismo escenario. */
  readonly fxRateToPyg: number;
  /** Precio de venta proyectado, por unidad, bruto (con IVA incluido, RN-IVA-01). */
  readonly projectedPricePyg: Money;
  /** No se persiste en sourcing_scenario_lines; la resuelve el llamador (catálogo, o la tasa por defecto del tenant). */
  readonly vatRate: VatRate;
  /** Requerido solo si el método de flete del escenario es `by_volume`. */
  readonly volume?: number;
  /** Requerido solo si el método de flete del escenario es `manual`. */
  readonly manualFreightAmount?: Money;
}

export interface SourcingAssumptions {
  /** Mismo criterio que una recepción real (RN-COS-02): tiene que compartir moneda con las líneas, o computeLandedCost lanza CurrencyMismatchError al sumar. */
  readonly freightTotal: Money;
  readonly freightMethod: FreightMethod;
  /** Arancel ad valorem (RN-SRC-01): fracción del valor de proveedor de cada línea, no un monto fijo. */
  readonly tariffRate: Percentage;
}

export type ScenarioProjectionError = {
  readonly code: "FREIGHT_ALLOCATION_FAILED";
  readonly reason: FreightError;
};

export interface ScenarioLineProjection {
  readonly lineId: string;
  readonly variantId: string;
  readonly variantLabel: string | undefined;
  /** Costo puesto por unidad (RN-SRC-01) — comparable directamente con projectedPricePyg. */
  readonly unitLandedPyg: Money;
  /** Porcentaje (19.7 = 19,7%), neto de IVA (RN-SRC-02). Puede ser negativo: una línea en pérdida no es un bug. */
  readonly marginPct: number;
  readonly belowThreshold: boolean;
}

function toFreightLine(line: ScenarioLineInput): FreightLine {
  return {
    id: line.id,
    value: line.unitPrice.times(line.qty.value),
    qty: line.qty,
    volume: line.volume,
    manualAmount: line.manualFreightAmount,
  };
}

/** RN-SRC-02 · precio proyectado que no permite calcular un margen: argumento fuera de rango, no un fallo que el negocio contemple. */
function assertPositivePrice(price: Money): void {
  if (price.isZero() || price.isNegative()) {
    throw new InvalidSourcingInputError(
      `projectScenarioLines requiere un projectedPricePyg positivo, recibido ${price.minor.toString()}.`,
    );
  }
}

function projectLine(
  line: ScenarioLineInput,
  freightShare: Money,
  tariffRate: Percentage,
  marginThresholdPct: number,
): ScenarioLineProjection {
  assertPositivePrice(line.projectedPricePyg);

  const supplierPrice = line.unitPrice.times(line.qty.value);
  const tariff = supplierPrice.times(tariffRate.value);
  const lineLandedPyg = computeLandedCost({
    components: { supplierPrice, freight: freightShare, other: tariff },
    fxRateToPyg: line.fxRateToPyg,
  });
  const unitLandedPyg = computeUnitLandedCost(lineLandedPyg, line.qty);

  const netPrice = taxBase(line.projectedPricePyg, line.vatRate);
  const profit = netPrice.minus(unitLandedPyg);
  const marginPct = round3((Number(profit.minor) / Number(netPrice.minor)) * 100);

  return {
    lineId: line.id,
    variantId: line.variantId,
    variantLabel: line.variantLabel,
    unitLandedPyg,
    marginPct,
    belowThreshold: marginPct < marginThresholdPct,
  };
}

export interface ProjectScenarioLinesInput {
  readonly lines: readonly ScenarioLineInput[];
  readonly assumptions: SourcingAssumptions;
  /** Umbral de RF-SRC-03, en el mismo rango [0, 1] que tariffRate — nadie configura "por debajo de −10%". */
  readonly marginThresholdPct: Percentage;
}

/**
 * RF-SRC-01…03 · proyecta costo puesto y margen de cada línea de un
 * escenario. El flete se reparte entre TODAS las líneas de una sola vez
 * (RN-COS-02); por eso la función recibe el conjunto completo, no una línea
 * aislada.
 */
export function projectScenarioLines(
  input: ProjectScenarioLinesInput,
): Result<readonly ScenarioLineProjection[], ScenarioProjectionError> {
  const freightShares = allocateFreight({
    freight: input.assumptions.freightTotal,
    method: input.assumptions.freightMethod,
    lines: input.lines.map(toFreightLine),
  });

  if (!freightShares.ok) {
    return err({ code: "FREIGHT_ALLOCATION_FAILED", reason: freightShares.error });
  }

  // round3 en los dos lados de la comparación de projectLine, no solo en
  // marginPct: 0.07 × 100 = 7.000000000000001 en punto flotante. Sin
  // redondear el umbral a la misma grilla de milésimas, un margen que
  // IGUALA el umbral exacto (7,000% con umbral 7%) daba belowThreshold
  // true — el mismo bug de punto flotante que motivó la grilla de
  // milésimas de Quantity en WP-C13 (revisión cruzada), ahora en
  // porcentajes. Hallazgo de la revisión cruzada de WP-C16.
  const marginThresholdPct = round3(input.marginThresholdPct.value * 100);
  const projections = input.lines.map((line) =>
    projectLine(
      line,
      freightShares.value.get(line.id)!,
      input.assumptions.tariffRate,
      marginThresholdPct,
    ),
  );

  return ok(projections);
}

export interface ScenarioComparisonGroup {
  readonly variantId: string;
  readonly projections: readonly ScenarioLineProjection[];
  /** El id de línea con mayor marginPct del grupo — el desempate es el primero visto, determinístico por orden de entrada. */
  readonly bestLineId: string;
}

/**
 * RF-SRC-02 · agrupa proyecciones por variante (GLOSARIO.md "Sourcing /
 * escenario": proveedor A vs. B, comprar ahora vs. esperar es la misma
 * variante bajo dos supuestos) y señala cuál conviene por margen (RN-SRC-04,
 * marcada "sin confirmar" en docs/domain-rules.md — mayor margen % y mayor
 * ganancia absoluta pueden contradecirse con cantidades o precios
 * distintos; corrección de la revisión cruzada de WP-C16, que esta función
 * citaba como RF-SRC-02, un requisito, no una regla de negocio decidida).
 */
export function compareScenarioLines(
  projections: readonly ScenarioLineProjection[],
): readonly ScenarioComparisonGroup[] {
  const order: string[] = [];
  const byVariant = new Map<string, ScenarioLineProjection[]>();
  for (const projection of projections) {
    const group = byVariant.get(projection.variantId);
    if (group) {
      group.push(projection);
    } else {
      byVariant.set(projection.variantId, [projection]);
      order.push(projection.variantId);
    }
  }

  return order.map((variantId) => {
    const group = byVariant.get(variantId)!;
    const best = group.reduce((best, current) =>
      current.marginPct > best.marginPct ? current : best,
    );
    return { variantId, projections: group, bestLineId: best.lineId };
  });
}
