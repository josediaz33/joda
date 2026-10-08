import { describe, expect, it } from "vitest";
import {
  executeDecantInput,
  executeDecantOutput,
  listDecantOrdersInput,
  planDecantInput,
  startDecantInput,
} from "./decant.js";

const ORDER_ID = "11111111-1111-4111-a111-111111111111";
const SALE_ID = "22222222-2222-4222-a222-222222222222";
const VARIANT_ID = "33333333-3333-4333-a333-333333333333";
const LOT_ID = "44444444-4444-4444-a444-444444444444";

describe("RN-FRA-01 · planDecantInput — el compromiso exige la venta (WP-C13)", () => {
  const base = { saleOrderId: SALE_ID, targetVariantId: VARIANT_ID, qtyUnits: 2 };

  it("acepta una orden con venta, variante y cantidad", () => {
    expect(() => planDecantInput.parse(base)).not.toThrow();
  });

  it("rechaza una orden sin saleOrderId — sin venta, el líquido consumido no tiene a quién cargarle el costo", () => {
    expect(() => planDecantInput.parse({ targetVariantId: VARIANT_ID, qtyUnits: 2 })).toThrow();
  });

  it("acepta sourceLotId para que el admin elija otro frasco", () => {
    expect(() => planDecantInput.parse({ ...base, sourceLotId: LOT_ID })).not.toThrow();
  });

  it("rechaza qtyUnits en cero", () => {
    expect(() => planDecantInput.parse({ ...base, qtyUnits: 0 })).toThrow();
  });

  it("rechaza qtyUnits con decimales — no existe medio decant", () => {
    expect(() => planDecantInput.parse({ ...base, qtyUnits: 1.5 })).toThrow();
  });

  it("rechaza un campo no declarado (.strict()): los ml esperados los calcula el servidor", () => {
    expect(() => planDecantInput.parse({ ...base, mlExpected: 10 })).toThrow();
  });
});

describe("RN-EST-03 · startDecantInput — pending → in_progress (WP-C13)", () => {
  it("acepta el id de la orden", () => {
    expect(() => startDecantInput.parse({ workOrderId: ORDER_ID })).not.toThrow();
  });

  it("rechaza un campo no declarado (.strict())", () => {
    expect(() => startDecantInput.parse({ workOrderId: ORDER_ID, status: "done" })).toThrow();
  });
});

describe("RN-FRA-03 · executeDecantInput — la merma real es obligatoria (RF-FRA-05)", () => {
  it("rechaza ejecutar sin declarar wasteActual", () => {
    expect(() => executeDecantInput.parse({ workOrderId: ORDER_ID })).toThrow();
  });

  it("acepta una merma real", () => {
    expect(() =>
      executeDecantInput.parse({ workOrderId: ORDER_ID, wasteActual: 0.35 }),
    ).not.toThrow();
  });

  it("acepta cero: declarar que no hubo merma es una declaración, omitirla no", () => {
    expect(() => executeDecantInput.parse({ workOrderId: ORDER_ID, wasteActual: 0 })).not.toThrow();
  });

  it("rechaza una merma negativa", () => {
    expect(() => executeDecantInput.parse({ workOrderId: ORDER_ID, wasteActual: -0.1 })).toThrow();
  });

  it("rechaza una merma con más de 3 decimales — mismo límite que Quantity.ml", () => {
    expect(() =>
      executeDecantInput.parse({ workOrderId: ORDER_ID, wasteActual: 0.3501 }),
    ).toThrow();
  });

  it("rechaza executedBy: el ejecutor sale de la sesión, no del cliente (RF-FRA-02)", () => {
    expect(() =>
      executeDecantInput.parse({ workOrderId: ORDER_ID, wasteActual: 0.35, executedBy: ORDER_ID }),
    ).toThrow();
  });
});

describe("RF-FRA-06 · listDecantOrdersInput — la cola son las órdenes sin ejecutar", () => {
  it("acepta sin filtro", () => {
    expect(() => listDecantOrdersInput.parse({})).not.toThrow();
  });

  it("acepta filtrar por in_progress", () => {
    expect(() => listDecantOrdersInput.parse({ status: "in_progress" })).not.toThrow();
  });

  it("rechaza filtrar por done: una orden ejecutada ya no está pendiente", () => {
    expect(() => listDecantOrdersInput.parse({ status: "done" })).toThrow();
  });
});

describe("RN-FRA-04 · executeDecantOutput — el COGS viaja como string (docs/api-conventions.md §3)", () => {
  const order = {
    id: ORDER_ID,
    saleOrderId: SALE_ID,
    sourceLotId: LOT_ID,
    targetVariantId: VARIANT_ID,
    qtyUnits: 1,
    mlPerUnit: 10,
    mlExpected: 10,
    wasteExpected: 0.2,
    wasteActual: 0.35,
    status: "done",
    executedBy: SALE_ID,
    executedAt: "2099-01-01T12:00:00.000Z",
    createdAt: "2099-01-01T11:00:00.000Z",
    createdBy: SALE_ID,
  };
  const output = {
    order,
    movements: [],
    cogs: "131210",
    costBreakdown: { liquid: "119720", waste: "4190", supplies: "7300" },
    skippedOptionalComponentIds: [],
  };

  it("acepta el COGS en guaraníes como string", () => {
    expect(() => executeDecantOutput.parse(output)).not.toThrow();
  });

  it("rechaza el COGS como number — un número pierde precisión con importes grandes", () => {
    expect(() => executeDecantOutput.parse({ ...output, cogs: 131210 })).toThrow();
  });
});
