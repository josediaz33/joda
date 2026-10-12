import { describe, expect, it } from "vitest";
import { InvalidSaleOrderInputError } from "../shared/errors.js";
import { Money } from "../shared/money.js";
import { Quantity } from "../shared/quantity.js";
import type { VatRate } from "../tax/vat.js";
import { priceSaleOrder, SALE_ORDER_MAX_SUBTOTAL_PYG } from "./orderPricing.js";

const line = (unitPrice: bigint, qty = 1, vatRate: VatRate = "iva_10") => ({
  unitPrice: Money.pyg(unitPrice),
  qty: Quantity.units(qty),
  vatRate,
});
const noDiscount = Money.pyg(0n);

describe("RN-VTA-01 · total_pyg = subtotal_pyg − discount_pyg + shipping_pyg, calculado desde las líneas", () => {
  it("la línea es cantidad por precio y, sin descuento, el total es el subtotal", () => {
    const result = priceSaleOrder({ lines: [line(245_000n, 2)], discountPyg: noDiscount });

    expect(result).toEqual({
      ok: true,
      value: {
        lines: [{ lineTotalPyg: Money.pyg(490_000n), vatPyg: Money.pyg(44_545n) }],
        subtotalPyg: Money.pyg(490_000n),
        discountPyg: Money.pyg(0n),
        shippingPyg: Money.pyg(0n),
        totalPyg: Money.pyg(490_000n),
        vat10Pyg: Money.pyg(44_545n),
        vat5Pyg: Money.pyg(0n),
        exemptPyg: Money.pyg(0n),
      },
    });
  });

  it("el descuento del pedido se resta del subtotal y el envío de una venta de mostrador es cero", () => {
    const result = priceSaleOrder({
      lines: [line(100_000n), line(50_000n)],
      discountPyg: Money.pyg(15_000n),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        subtotalPyg: Money.pyg(150_000n),
        discountPyg: Money.pyg(15_000n),
        shippingPyg: Money.pyg(0n),
        totalPyg: Money.pyg(135_000n),
      },
    });
  });

  it("un descuento igual al subtotal deja el total en cero y el IVA en cero: cero no es negativo", () => {
    const result = priceSaleOrder({
      lines: [line(100_000n), line(50_000n, 1, "iva_5")],
      discountPyg: Money.pyg(150_000n),
    });

    expect(result).toEqual({
      ok: true,
      value: {
        lines: [
          { lineTotalPyg: Money.pyg(100_000n), vatPyg: Money.pyg(0n) },
          { lineTotalPyg: Money.pyg(50_000n), vatPyg: Money.pyg(0n) },
        ],
        subtotalPyg: Money.pyg(150_000n),
        discountPyg: Money.pyg(150_000n),
        shippingPyg: Money.pyg(0n),
        totalPyg: Money.pyg(0n),
        vat10Pyg: Money.pyg(0n),
        vat5Pyg: Money.pyg(0n),
        exemptPyg: Money.pyg(0n),
      },
    });
  });
});

describe("docs/domain-rules.md caso borde 19 · un descuento que deja el total negativo se rechaza, nunca se trunca", () => {
  it("devuelve NEGATIVE_TOTAL con los tres importes, sin lanzar", () => {
    const result = priceSaleOrder({ lines: [line(50_000n)], discountPyg: Money.pyg(50_001n) });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "NEGATIVE_TOTAL",
        subtotalPyg: Money.pyg(50_000n),
        discountPyg: Money.pyg(50_001n),
        shippingPyg: Money.pyg(0n),
      },
    });
  });
});

describe("RN-IVA-01 · el IVA se extrae del precio con impuesto incluido, por tasa", () => {
  it("separa IVA 10%, IVA 5% y el monto exento del pedido", () => {
    const result = priceSaleOrder({
      lines: [line(110_000n), line(21_000n, 1, "iva_5"), line(50_000n, 1, "exenta")],
      discountPyg: noDiscount,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        lines: [
          { lineTotalPyg: Money.pyg(110_000n), vatPyg: Money.pyg(10_000n) },
          { lineTotalPyg: Money.pyg(21_000n), vatPyg: Money.pyg(1_000n) },
          { lineTotalPyg: Money.pyg(50_000n), vatPyg: Money.pyg(0n) },
        ],
        totalPyg: Money.pyg(181_000n),
        vat10Pyg: Money.pyg(10_000n),
        vat5Pyg: Money.pyg(1_000n),
        exemptPyg: Money.pyg(50_000n),
      },
    });
  });
});

describe("RN-IVA-02/03 · el IVA se resuelve a nivel de documento y la diferencia va a la última línea de la tasa", () => {
  it("tres líneas de Gs. 33.333 al 10%: la tercera pasa de 3.030 a 3.031 y el pedido declara 9.091", () => {
    const result = priceSaleOrder({
      lines: [line(33_333n), line(33_333n), line(33_333n)],
      discountPyg: noDiscount,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        lines: [
          { vatPyg: Money.pyg(3_030n) },
          { vatPyg: Money.pyg(3_030n) },
          { vatPyg: Money.pyg(3_031n) },
        ],
        vat10Pyg: Money.pyg(9_091n),
      },
    });
  });

  it("el descuento se reparte entre las líneas en proporción a su importe y el IVA sale de lo que se paga", () => {
    const result = priceSaleOrder({
      lines: [line(100_000n, 1, "iva_10"), line(50_000n, 1, "iva_5")],
      discountPyg: Money.pyg(15_000n),
    });

    // Partes del descuento: 10.000 y 5.000. Se pagan 90.000 (10%) y 45.000 (5%).
    expect(result).toMatchObject({
      ok: true,
      value: {
        lines: [
          { lineTotalPyg: Money.pyg(100_000n), vatPyg: Money.pyg(8_182n) },
          { lineTotalPyg: Money.pyg(50_000n), vatPyg: Money.pyg(2_143n) },
        ],
        vat10Pyg: Money.pyg(8_182n),
        vat5Pyg: Money.pyg(2_143n),
      },
    });
  });

  it("un descuento que no se reparte exacto asigna la unidad que sobra por el mayor resto: 100 sobre 100.000 y 50.000 son 67 y 33", () => {
    const result = priceSaleOrder({
      lines: [line(100_000n), line(50_000n)],
      discountPyg: Money.pyg(100n),
    });

    // Se pagan 99.933 y 49.967; el IVA de cada una es 9.085 y 4.542, y el del documento (149.900 / 11) también suma 13.627.
    expect(result).toMatchObject({
      ok: true,
      value: {
        lines: [{ vatPyg: Money.pyg(9_085n) }, { vatPyg: Money.pyg(4_542n) }],
        totalPyg: Money.pyg(149_900n),
        vat10Pyg: Money.pyg(13_627n),
      },
    });
  });
});

describe("RN-IVA-02 · el límite del subtotal es el del reparto exacto de Money.allocate", () => {
  it("acepta un subtotal en el límite", () => {
    const result = priceSaleOrder({
      lines: [line(SALE_ORDER_MAX_SUBTOTAL_PYG)],
      discountPyg: noDiscount,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { subtotalPyg: Money.pyg(9_000_000_000n) },
    });
  });

  it("rechaza con SUBTOTAL_TOO_LARGE un subtotal que lo supera, sin lanzar", () => {
    const result = priceSaleOrder({
      lines: [line(4_500_000_000n, 2), line(1n)],
      discountPyg: noDiscount,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "SUBTOTAL_TOO_LARGE", subtotalPyg: Money.pyg(9_000_000_001n) },
    });
  });
});

describe("docs/domain-contracts.md §4 · una entrada fuera de rango es un bug, no un fallo del negocio", () => {
  it("un pedido sin líneas lanza", () => {
    expect(() => priceSaleOrder({ lines: [], discountPyg: noDiscount })).toThrow(
      InvalidSaleOrderInputError,
    );
  });

  it("una cantidad cero lanza", () => {
    expect(() =>
      priceSaleOrder({
        lines: [{ ...line(1_000n), qty: Quantity.units(0) }],
        discountPyg: noDiscount,
      }),
    ).toThrow(InvalidSaleOrderInputError);
  });

  it("una cantidad con decimales lanza", () => {
    expect(() =>
      priceSaleOrder({
        lines: [{ ...line(1_000n), qty: Quantity.ml(1.5) }],
        discountPyg: noDiscount,
      }),
    ).toThrow(InvalidSaleOrderInputError);
  });
});
