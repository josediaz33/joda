// Disponibilidad de una variante de decant bajo pedido (RN-FRA-06;
// docs/domain-contracts.md §6.2). No devuelve un Result: la disponibilidad
// siempre se puede calcular, aunque dé cero — no hay ningún fallo de
// negocio que rechazar acá, solo un número que mostrarle al cliente.
import { InvalidDecantInputError } from "../shared/errors.js";
import type { Percentage } from "../shared/percentage.js";
import type { Quantity } from "../shared/quantity.js";

export interface DecantAvailabilityBomComponent {
  readonly available: Quantity;
  readonly perUnit: Quantity;
}

export interface DecantAvailabilityInput {
  readonly bulkAvailable: Quantity;
  readonly mlPerUnit: number;
  readonly wasteFactor: Percentage;
  readonly bom: readonly DecantAvailabilityBomComponent[];
}

/**
 * RN-FRA-06 · el mínimo entre lo que da el líquido (piso del granel
 * disponible sobre ml por unidad, con su merma incluida) y lo que da cada
 * insumo del BOM (piso del disponible sobre lo que consume una unidad). Sin
 * insumos que limiten (`bom` vacío), la disponibilidad es solo la del
 * líquido.
 *
 * **Ejemplo verificado.** Granel 114,65 ml, decant de 10 ml al 2%, 99
 * viales, 99 atomizadores, 199 etiquetas → `por_líquido` = piso(114,65 /
 * 10,2) = 11; `por_insumos` = mín(99, 99, 199) = 99; disponible = 11.
 */
export function decantAvailability(input: DecantAvailabilityInput): number {
  if (!Number.isFinite(input.mlPerUnit) || input.mlPerUnit <= 0) {
    throw new InvalidDecantInputError(
      `decantAvailability requiere mlPerUnit positivo y finito, recibido ${input.mlPerUnit}.`,
    );
  }

  const mlPerUnitWithWaste = input.mlPerUnit * (1 + input.wasteFactor.value);
  const byLiquid = Math.floor(input.bulkAvailable.value / mlPerUnitWithWaste);

  return input.bom.reduce((min, component) => {
    if (!(component.perUnit.value > 0)) {
      throw new InvalidDecantInputError(
        `decantAvailability requiere perUnit positivo por componente del BOM, recibido ${component.perUnit.value}.`,
      );
    }
    const bySupply = Math.floor(component.available.value / component.perUnit.value);
    return Math.min(min, bySupply);
  }, byLiquid);
}
