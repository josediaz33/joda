// Alta de una unidad serializada (RN-SER-02, RN-SER-03; RF-INV-10). Un reloj
// de USD 800 no es "cantidad = 1": lleva número de serie, garantía y su
// propia trazabilidad de venta. Esta función decide si se puede REGISTRAR una
// unidad más contra un lote; no escribe nada.
//
// Lo que NO decide, porque lo impone la base y duplicarlo sería una segunda
// verdad:
//   · RN-SER-01, el número de serie único por tenant: `UNIQUE (tenant_id,
//     serial_number)`.
//   · RN-SER-04, que la unidad sea de la variante de su lote: la FK
//     compuesta `serialized_units_lot_id_fkey` (0029).
//
// RN-SER-03 tiene una carrera que esta función no puede cerrar sola: dos
// altas simultáneas ven "2 de 3" y registran la cuarta. `registeredCount` es
// una lectura, y solo vale si quien orquesta bloqueó el lote (`FOR UPDATE`)
// ANTES de contar. Esa es una propiedad de la API, no del cálculo.
import { InvalidSerializedUnitInputError } from "../shared/errors.js";
import { Quantity } from "../shared/quantity.js";
import { err, ok, type Result } from "../shared/result.js";

export interface RegisterSerializedUnitInput {
  /** `product_variants.is_serialized` de la variante del lote. */
  readonly variantIsSerialized: boolean;
  /** `inventory_lots.qty_initial`, en `unit`: con cuántas unidades nació el lote. */
  readonly lotQtyInitial: Quantity;
  /**
   * Unidades serializadas ya registradas de este lote, de TODOS los estados:
   * las vendidas, en cuarentena o devueltas también cuentan. Una unidad
   * vendida sigue siendo una de las que el lote trajo.
   */
  readonly registeredCount: number;
}

export type SerializedUnitRegistrationError =
  | { readonly code: "VARIANT_NOT_SERIALIZED" }
  | {
      readonly code: "LOT_SERIAL_CAPACITY_EXCEEDED";
      readonly capacity: Quantity;
      readonly registered: number;
    };

export interface SerializedUnitRegistrationPlan {
  /** Unidades del lote que quedan sin registrar después de este alta. */
  readonly remainingAfter: Quantity;
}

/**
 * RN-SER-02 · solo una variante `is_serialized` lleva unidades con número de
 * serie. RN-SER-03 · las unidades registradas de un lote no superan su
 * `qty_initial`.
 *
 * **Ejemplo.** Lote de 3 relojes con 2 ya registrados: el tercer alta se
 * acepta y deja 0 sin registrar; un cuarto se rechaza con
 * `LOT_SERIAL_CAPACITY_EXCEEDED`.
 */
export function planSerializedUnitRegistration(
  input: RegisterSerializedUnitInput,
): Result<SerializedUnitRegistrationPlan, SerializedUnitRegistrationError> {
  if (!Number.isInteger(input.registeredCount) || input.registeredCount < 0) {
    throw new InvalidSerializedUnitInputError(
      `planSerializedUnitRegistration requiere registeredCount entero no negativo, recibido ${input.registeredCount}.`,
    );
  }

  // Antes que la cantidad: dar de alta un serial sobre un lote de granel (en
  // ml) es algo que un usuario puede pedir, y es un rechazo de negocio, no un
  // bug. Solo una variante serializada tiene un lote en unidades (el CHECK de
  // product_variants lo ata), así que de acá en más un lote en ml es un dato
  // corrupto.
  if (!input.variantIsSerialized) {
    return err({ code: "VARIANT_NOT_SERIALIZED" });
  }

  if (input.lotQtyInitial.uom !== "unit" || input.lotQtyInitial.value < 1) {
    throw new InvalidSerializedUnitInputError(
      `planSerializedUnitRegistration requiere lotQtyInitial en unidades y de al menos 1, recibido ${input.lotQtyInitial.value} ${input.lotQtyInitial.uom}.`,
    );
  }
  if (input.registeredCount >= input.lotQtyInitial.value) {
    return err({
      code: "LOT_SERIAL_CAPACITY_EXCEEDED",
      capacity: input.lotQtyInitial,
      registered: input.registeredCount,
    });
  }

  return ok({
    remainingAfter: Quantity.units(input.lotQtyInitial.value - input.registeredCount - 1),
  });
}
