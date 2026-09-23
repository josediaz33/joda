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

  it("deja los estados de recepción para el flujo de C15", () => {
    expect(
      transitionPurchaseOrderInput.safeParse({
        id: "77777777-7777-4777-a777-777777777781",
        toStatus: "partially_received",
      }).success,
    ).toBe(false);
  });
});
