import { describe, expect, it } from "vitest";
import { InvalidDecantInputError } from "../shared/errors.js";
import { Percentage } from "../shared/percentage.js";
import { Quantity } from "../shared/quantity.js";
import { computeTransferWaste, evaluateUnusableResidue } from "./waste.js";

describe("RN-FRA-02, RN-FRA-05 · computeTransferWaste — trasvase proporcional al volumen", () => {
  it("10 ml esperados con waste_factor 2% da 0,200 ml de merma esperada", () => {
    const result = computeTransferWaste(Quantity.ml(10), Percentage.of(0.02));

    expect(result).toEqual(Quantity.ml(0.2));
  });

  it("redondea a 3 decimales cuando el producto crudo tiene más precisión", () => {
    // 1 ml × 12,36% = 0,1236 crudo → redondeado a 3 decimales: 0,124.
    const result = computeTransferWaste(Quantity.ml(1), Percentage.of(0.1236));

    expect(result).toEqual(Quantity.ml(0.124));
  });
});

describe("RN-LOT-04, RN-FRA-05 · evaluateUnusableResidue — fondo no recuperable", () => {
  it("con unusable_residue_ml = 2,5 y el granel en 2,3 ml, el lote se agota y el residuo completo se da de baja", () => {
    const result = evaluateUnusableResidue({
      remaining: Quantity.ml(2.3),
      unusableResidueMl: Quantity.ml(2.5),
    });

    expect(result).toEqual({ depleted: true, residueToWasteOff: Quantity.ml(2.3) });
  });

  it("cuando el saldo restante iguala exactamente el umbral, también se considera agotado", () => {
    const result = evaluateUnusableResidue({
      remaining: Quantity.ml(2.5),
      unusableResidueMl: Quantity.ml(2.5),
    });

    expect(result).toEqual({ depleted: true, residueToWasteOff: Quantity.ml(2.5) });
  });

  it("con saldo por encima del umbral, el lote no se agota todavía", () => {
    const result = evaluateUnusableResidue({
      remaining: Quantity.ml(5),
      unusableResidueMl: Quantity.ml(2.5),
    });

    expect(result).toEqual({ depleted: false, residueToWasteOff: null });
  });

  it("un saldo restante negativo es un bug del llamador, no un fallo de negocio", () => {
    expect(() =>
      evaluateUnusableResidue({
        remaining: Quantity.ml(-1),
        unusableResidueMl: Quantity.ml(2.5),
      }),
    ).toThrow(InvalidDecantInputError);
  });
});
