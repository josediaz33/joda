// Percentage — porcentaje en [0, 1] (0,02 = 2%). Usado para factores como
// waste_factor (RN-FRA-02, fuera de alcance acá): fuera de rango es un bug
// del llamador, no un caso de negocio.
import { InvalidPercentageError } from "./errors.js";
import { Quantity } from "./quantity.js";

export class Percentage {
  private constructor(readonly value: number) {}

  static of(value: number): Percentage {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new InvalidPercentageError(
        `Percentage.of requiere un valor en [0, 1], recibido ${value}.`,
      );
    }
    return new Percentage(value);
  }

  applyTo(q: Quantity): Quantity {
    return q.times(this.value);
  }
}
