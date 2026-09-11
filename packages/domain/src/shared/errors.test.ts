import { describe, expect, it } from "vitest";
import {
  CurrencyMismatchError,
  DomainError,
  InvalidAllocationError,
  InvalidMoneyAmountError,
  InvalidPercentageError,
  InvalidQuantityError,
  UomMismatchError,
} from "./errors.js";

describe("DomainError — docs/domain-contracts.md §4.2", () => {
  it("expone el código y el mensaje, y es una instancia de Error con su propio nombre", () => {
    const error = new DomainError("ALGO", "algo pasó");

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("ALGO");
    expect(error.message).toBe("algo pasó");
    expect(error.name).toBe("DomainError");
  });
});

describe("jerarquía de errores de dominio — docs/domain-contracts.md §4.2", () => {
  it("CurrencyMismatchError es un DomainError y lleva la moneda esperada y la recibida", () => {
    const error = new CurrencyMismatchError("PYG", "USD");

    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe("CURRENCY_MISMATCH");
    expect(error.expected).toBe("PYG");
    expect(error.actual).toBe("USD");
    expect(error.name).toBe("CurrencyMismatchError");
  });

  it("UomMismatchError es un DomainError y lleva la unidad esperada y la recibida", () => {
    const error = new UomMismatchError("unit", "ml");

    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe("UOM_MISMATCH");
    expect(error.expected).toBe("unit");
    expect(error.actual).toBe("ml");
    expect(error.name).toBe("UomMismatchError");
  });

  it("InvalidQuantityError, InvalidPercentageError, InvalidMoneyAmountError e InvalidAllocationError llevan su propio código", () => {
    expect(new InvalidQuantityError("x")).toBeInstanceOf(DomainError);
    expect(new InvalidQuantityError("x").code).toBe("INVALID_QUANTITY");
    expect(new InvalidPercentageError("x").code).toBe("INVALID_PERCENTAGE");
    expect(new InvalidMoneyAmountError("x").code).toBe("INVALID_MONEY_AMOUNT");
    expect(new InvalidAllocationError("x").code).toBe("INVALID_ALLOCATION");
  });
});
