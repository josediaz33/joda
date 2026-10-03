import { describe, expect, it } from "vitest";
import {
  createPurchaseOrderInput,
  createSupplierInput,
  transitionPurchaseOrderInput,
} from "./market.js";

const line = {
  variantId: "77777777-7777-4777-a777-777777777781",
  qtyOrdered: "2",
  uom: "unit",
  unitPriceMinor: "1200",
};
const order = {
  supplierId: "88888888-8888-4888-a888-888888888881",
  code: "PO-1",
  currency: "USD",
  lines: [line],
};

describe("docs/api-conventions.md §3 · contratos de compras", () => {
  it("rechaza atributos ajenos, importes numéricos y cantidades cero", () => {
    expect(
      createSupplierInput.safeParse({
        code: "S",
        name: "Proveedor",
        defaultCurrency: "USD",
        paymentTermsDays: 0,
        margin: 10,
      }).success,
    ).toBe(false);
    expect(
      createPurchaseOrderInput.safeParse({ ...order, lines: [{ ...line, unitPriceMinor: 1200 }] })
        .success,
    ).toBe(false);
    expect(
      createPurchaseOrderInput.safeParse({ ...order, lines: [{ ...line, qtyOrdered: "0.000" }] })
        .success,
    ).toBe(false);
    expect(
      createPurchaseOrderInput.safeParse({ ...order, fxRateToPyg: "0.00000000" }).success,
    ).toBe(false);
  });

  it("limita importes a bigint, cantidades a numeric(14,3) y cambio a numeric(18,8)", () => {
    expect(
      createPurchaseOrderInput.safeParse({
        ...order,
        freightMinor: "9223372036854775807",
        fxRateToPyg: "9999999999.99999999",
        lines: [{ ...line, qtyOrdered: "99999999999.999", unitPriceMinor: "9223372036854775807" }],
      }).success,
    ).toBe(true);
    expect(
      createPurchaseOrderInput.safeParse({ ...order, freightMinor: "9223372036854775808" }).success,
    ).toBe(false);
    expect(
      createPurchaseOrderInput.safeParse({ ...order, fxRateToPyg: "10000000000" }).success,
    ).toBe(false);
    expect(
      createPurchaseOrderInput.safeParse({
        ...order,
        lines: [{ ...line, qtyOrdered: "100000000000" }],
      }).success,
    ).toBe(false);
    expect(
      createPurchaseOrderInput.safeParse({
        ...order,
        lines: [{ ...line, unitPriceMinor: "9223372036854775808" }],
      }).success,
    ).toBe(false);
  });

  it("una OC nueva no acepta estado provisto por el cliente", () => {
    expect(createPurchaseOrderInput.safeParse({ ...order, status: "approved" }).success).toBe(
      false,
    );
  });

  it("deja los estados de recepción para el flujo de C15", () => {
    expect(
      transitionPurchaseOrderInput.safeParse({
        id: "77777777-7777-4777-a777-777777777781",
        toStatus: "partially_received",
      }).success,
    ).toBe(false);
  });
});
