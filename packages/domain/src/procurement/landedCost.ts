// Costo puesto (RN-COS-01, RN-COS-03; docs/domain-contracts.md §6.1;
// GLOSARIO.md "Costo puesto / landed cost"). El tipo de cambio es el REAL
// de la recepción, nunca el estimado de la orden de compra (RN-COS-01) —
// esta función no lo valida contra ninguna orden, es responsabilidad de
// quien la llama pasar el fx correcto.
import { InvalidLandedCostInputError } from "../shared/errors.js";
import { Money, roundPyg } from "../shared/money.js";
import type { Quantity } from "../shared/quantity.js";

// RN-DIN-04: amount_pyg = round_pyg(amount_minor / 100 × fx_rate_to_pyg).
// El /100 asume que la moneda extranjera representa su minor en centavos
// (dos decimales) — cierto para USD, BRL y ARS, las únicas monedas
// extranjeras del dominio (shared/money.ts, Currency).
const FOREIGN_CURRENCY_MINOR_SCALE = 100;

/**
 * RN-DIN-04 · convierte un importe en moneda extranjera a Gs. con el fx
 * REAL de la recepción, una sola vez — el resultado es un snapshot, no se
 * recalcula después. Vive acá y no en shared/money.ts porque hoy solo lo
 * necesita el costeo de procurement; si otro módulo llega a necesitarlo,
 * se promueve a shared/ en ese momento, no antes (alcance de WP-A05).
 */
function convertToPyg(amount: Money, fxRateToPyg: number): Money {
  if (amount.currency === "PYG") {
    throw new InvalidLandedCostInputError(
      "convertToPyg requiere un importe en moneda extranjera; recibió un importe ya en PYG.",
    );
  }
  if (!Number.isFinite(fxRateToPyg) || fxRateToPyg <= 0) {
    throw new InvalidLandedCostInputError(
      `fxRateToPyg debe ser un número finito y positivo, recibido ${fxRateToPyg}.`,
    );
  }

  const majorUnits = Number(amount.minor) / FOREIGN_CURRENCY_MINOR_SCALE;
  return Money.pyg(roundPyg(majorUnits * fxRateToPyg));
}

export interface LandedCostComponents {
  /** Precio del proveedor, en la moneda extranjera de la recepción. */
  readonly supplierPrice: Money;
  readonly freight?: Money;
  readonly customsClearance?: Money;
  readonly other?: Money;
}

export interface ComputeLandedCostInput {
  readonly components: LandedCostComponents;
  /** Tipo de cambio REAL de la recepción (RN-COS-01) — no el estimado de la orden de compra. */
  readonly fxRateToPyg: number;
}

/**
 * RN-COS-01 · costo puesto = (precio + flete + despacho + otros) × fx
 * real de la recepción. La suma de componentes ocurre en la moneda
 * extranjera y se convierte a Gs. una sola vez al final (RN-DIN-04):
 * sumar primero y convertir después, nunca convertir cada componente por
 * separado y sumar los Gs. resultantes.
 *
 * **Ejemplo (RN-COS-01).** Frasco de Layton 125 ml: USD 190,00 de precio +
 * USD 15,00 de flete y despacho, dólar a 7.300 → Gs. 1.496.500.
 */
export function computeLandedCost(input: ComputeLandedCostInput): Money {
  const { supplierPrice, freight, customsClearance, other } = input.components;

  const total = [freight, customsClearance, other]
    .filter((component): component is Money => component !== undefined)
    .reduce((sum, component) => sum.plus(component), supplierPrice);

  return convertToPyg(total, input.fxRateToPyg);
}

/**
 * RN-COS-03 · costo unitario del lote = costo puesto / cantidad inicial,
 * redondeado con roundPyg (vía Money.times, el único redondeo del
 * paquete).
 *
 * **Ejemplo.** El frasco de Layton anterior, convertido a granel:
 * `1.496.500 / 125 ml` = Gs. 11.972/ml.
 */
export function computeUnitLandedCost(landedCostPyg: Money, qtyInitial: Quantity): Money {
  if (!(qtyInitial.value > 0)) {
    throw new InvalidLandedCostInputError(
      `computeUnitLandedCost requiere una cantidad inicial positiva, recibido ${qtyInitial.value}.`,
    );
  }

  return landedCostPyg.times(1 / qtyInitial.value);
}
