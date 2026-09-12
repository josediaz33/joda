import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CurrencyMismatchError,
  InvalidAllocationError,
  InvalidMoneyAmountError,
} from "./errors.js";
import { Money, roundPyg } from "./money.js";

describe("Money — representación (RN-DIN-01)", () => {
  it("el guaraní es un bigint de unidades enteras", () => {
    const price = Money.pyg(2_450_000n);

    expect(price.minor).toBe(2_450_000n);
    expect(typeof price.minor).toBe("bigint");
    expect(price.currency).toBe("PYG");
  });

  it("una moneda extranjera se representa en su unidad menor — USD 190,00 → 19000n", () => {
    const price = Money.of(19_000n, "USD");

    expect(price.minor).toBe(19_000n);
    expect(price.currency).toBe("USD");
  });

  it("zero() crea un importe en cero en la moneda dada", () => {
    expect(Money.zero("PYG").isZero()).toBe(true);
    expect(Money.zero("USD").currency).toBe("USD");
  });
});

describe("roundPyg — redondeo (RN-DIN-02)", () => {
  it.each([
    [113_636.36, 113_636n],
    [113_636.5, 113_637n],
    [113_636.64, 113_637n],
    [-0.5, 0n],
  ])("redondea %f a %s", (value, expected) => {
    expect(roundPyg(value)).toBe(expected);
  });

  it("rechaza un valor no finito", () => {
    expect(() => roundPyg(Number.NaN)).toThrow(InvalidMoneyAmountError);
    expect(() => roundPyg(Number.POSITIVE_INFINITY)).toThrow(InvalidMoneyAmountError);
  });
});

describe("Money.plus / Money.minus — docs/domain-contracts.md §3.1", () => {
  it("suma dos importes de la misma moneda", () => {
    expect(Money.pyg(100_000n).plus(Money.pyg(45_000n)).minor).toBe(145_000n);
  });

  it("resta dos importes de la misma moneda", () => {
    expect(Money.pyg(100_000n).minus(Money.pyg(45_000n)).minor).toBe(55_000n);
  });

  it("plus lanza CurrencyMismatchError al sumar monedas distintas (RN-DIN-03)", () => {
    expect(() => Money.pyg(100_000n).plus(Money.of(100n, "USD"))).toThrow(CurrencyMismatchError);
  });

  it("minus lanza CurrencyMismatchError al restar monedas distintas (RN-DIN-03)", () => {
    expect(() => Money.pyg(100_000n).minus(Money.of(100n, "USD"))).toThrow(CurrencyMismatchError);
  });
});

describe("Money.times — docs/domain-contracts.md §3.1", () => {
  it("multiplica por un factor y redondea el resultado con roundPyg", () => {
    // Mismo cálculo que RN-DIN-04 (USD 190,00 x 7.300 = Gs. 1.387.000),
    // expresado como Money.of(19000n, 'USD').times(73) en vez de dividir
    // por 100 y multiplicar por 7300 por separado.
    expect(Money.of(19_000n, "USD").times(73).minor).toBe(1_387_000n);
  });

  it("rechaza un factor no finito", () => {
    expect(() => Money.pyg(100n).times(Number.NaN)).toThrow(InvalidMoneyAmountError);
  });

  it("pierde exactitud por encima de Number.MAX_SAFE_INTEGER — Number(minor) redondea al representable más cercano", () => {
    // Number.MAX_SAFE_INTEGER = 9_007_199_254_740_991 = 2^53 − 1. Dos
    // unidades por encima (2^53 + 1) no es representable como Number: se
    // redondea a 2^53 antes de que roundPyg vea nada. times(1) debería
    // devolver el mismo minor recibido y no lo hace — documenta la
    // pérdida, no la evita (ningún guaraní real se acerca a esta magnitud).
    expect(Money.pyg(9_007_199_254_740_993n).times(1).minor).toBe(9_007_199_254_740_992n);
  });
});

describe("Money.isZero / Money.isNegative — docs/domain-contracts.md §3.1", () => {
  it("isZero es true solo en cero", () => {
    expect(Money.pyg(0n).isZero()).toBe(true);
    expect(Money.pyg(1n).isZero()).toBe(false);
  });

  it("isNegative es true solo por debajo de cero", () => {
    expect(Money.pyg(-1n).isNegative()).toBe(true);
    expect(Money.pyg(1n).isNegative()).toBe(false);
  });
});

describe("Money.compare — docs/domain-contracts.md §3.1", () => {
  it("devuelve 0 cuando son iguales", () => {
    expect(Money.pyg(100n).compare(Money.pyg(100n))).toBe(0);
  });

  it("devuelve -1 cuando el primero es menor", () => {
    expect(Money.pyg(50n).compare(Money.pyg(100n))).toBe(-1);
  });

  it("devuelve 1 cuando el primero es mayor", () => {
    expect(Money.pyg(100n).compare(Money.pyg(50n))).toBe(1);
  });

  it("lanza CurrencyMismatchError al comparar monedas distintas", () => {
    expect(() => Money.pyg(100n).compare(Money.of(100n, "USD"))).toThrow(CurrencyMismatchError);
  });
});

describe("Money.toJSON — docs/domain-contracts.md §3.1", () => {
  it("serializa minor como string para no perder precisión de bigint en JSON", () => {
    expect(Money.pyg(2_450_000n).toJSON()).toEqual({ minor: "2450000", currency: "PYG" });
  });
});

describe("Money.allocate — prorrateo exacto (docs/domain-contracts.md §3.1)", () => {
  it("reparte en partes iguales cuando el total es divisible exacto", () => {
    expect(
      Money.pyg(9n)
        .allocate([1, 1, 1])
        .map((p) => p.minor),
    ).toEqual([3n, 3n, 3n]);
  });

  it("imputa el resto a los pesos con mayor remanente, desempatando por índice ascendente", () => {
    const parts = Money.pyg(10n).allocate([1, 1, 1]);

    expect(parts.map((p) => p.minor)).toEqual([4n, 3n, 3n]);
  });

  it("reparte proporcionalmente entre pesos distintos", () => {
    // Los números coinciden con el ejemplo de RN-COS-02 (docs/domain-rules.md)
    // solo como referencia de una fuente real; el prorrateo de flete en sí
    // — con su propia regla de a qué línea se imputa la diferencia — es WP-A05.
    const parts = Money.pyg(300_000n).allocate([1_000_000, 500_000, 200_000]);

    expect(parts.map((p) => p.minor)).toEqual([176_471n, 88_235n, 35_294n]);
  });

  it("reparte correctamente un total negativo (por ejemplo, una nota de crédito)", () => {
    const parts = Money.pyg(-10n).allocate([1, 1, 1]);

    expect(parts.map((p) => p.minor)).toEqual([-3n, -3n, -4n]);
    expect(parts.reduce((sum, p) => sum + p.minor, 0n)).toBe(-10n);
  });

  it("un peso en cero recibe cero cuando hay otros pesos con remanente", () => {
    const parts = Money.pyg(10n).allocate([0, 1, 1]);

    expect(parts.reduce((sum, p) => sum + p.minor, 0n)).toBe(10n);
    expect(parts[0]?.minor).toBe(0n);
  });

  it("con un solo peso, ese peso recibe el total completo", () => {
    expect(Money.pyg(12_345n).allocate([1])).toEqual([Money.pyg(12_345n)]);
  });

  it("rechaza un arreglo de pesos vacío", () => {
    expect(() => Money.pyg(100n).allocate([])).toThrow(InvalidAllocationError);
  });

  it("rechaza un peso negativo", () => {
    expect(() => Money.pyg(100n).allocate([1, -1])).toThrow(InvalidAllocationError);
  });

  it("rechaza un peso no finito", () => {
    expect(() => Money.pyg(100n).allocate([1, Number.NaN])).toThrow(InvalidAllocationError);
  });

  it("rechaza cuando todos los pesos son cero", () => {
    expect(() => Money.pyg(100n).allocate([0, 0])).toThrow(InvalidAllocationError);
  });

  it("rechaza un peso con más de 6 decimales — pierde precisión en silencio si no", () => {
    expect(() => Money.pyg(100n).allocate([1, 0.1234567])).toThrow(InvalidAllocationError);
  });

  it("reparte sin perder ni ganar unidades, para cualquier total y cualquier conjunto de pesos", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 20 }),
        (total, weights) => {
          const parts = Money.pyg(total).allocate(weights);
          const sum = parts.reduce((a, b) => a.plus(b), Money.pyg(0n));

          expect(sum.minor).toBe(total); // exacto, siempre
          expect(parts).toHaveLength(weights.length);
        },
      ),
    );
  });
});
