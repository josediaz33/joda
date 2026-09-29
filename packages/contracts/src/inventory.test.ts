import { describe, expect, it } from "vitest";
import {
  createAdjustmentInput,
  movementIdSchema,
  openLotInput,
  openLotOutput,
} from "./inventory.js";

describe("inventory — movementIdSchema (docs/api-conventions.md §3, bigint identity como string)", () => {
  it("acepta un entero positivo en formato string", () => {
    expect(() => movementIdSchema.parse("42")).not.toThrow();
  });

  it("rechaza un negativo — inventory_movements.id es GENERATED ALWAYS AS IDENTITY, siempre positivo", () => {
    expect(() => movementIdSchema.parse("-1")).toThrow();
  });

  it("rechaza un number crudo — tiene que viajar como string (bigint no sobrevive JSON.stringify)", () => {
    expect(() => movementIdSchema.parse(42)).toThrow();
  });
});

describe("inventory — createAdjustmentInput (RF-INV-04, motivo obligatorio)", () => {
  const base = { lotId: "11111111-1111-4111-a111-111111111111" };

  it("qty en cero se rechaza — un ajuste sin cambio no es un ajuste", () => {
    expect(() => createAdjustmentInput.parse({ ...base, qty: 0, reason: "recuento" })).toThrow();
  });

  it("reason vacío se rechaza — el motivo es obligatorio", () => {
    expect(() => createAdjustmentInput.parse({ ...base, qty: -5, reason: "" })).toThrow();
  });

  it("reason con solo espacios se rechaza — .trim() antes de min(1)", () => {
    expect(() => createAdjustmentInput.parse({ ...base, qty: -5, reason: "   " })).toThrow();
  });

  it("un campo no declarado se rechaza (.strict())", () => {
    expect(() =>
      createAdjustmentInput.parse({ ...base, qty: -5, reason: "rotura", uom: "ml" }),
    ).toThrow();
  });

  it("qty negativo con motivo no vacío se acepta", () => {
    expect(() =>
      createAdjustmentInput.parse({ ...base, qty: -5, reason: "rotura en depósito" }),
    ).not.toThrow();
  });

  it("qty positivo (recuento halló más stock) se acepta", () => {
    expect(() =>
      createAdjustmentInput.parse({ ...base, qty: 3, reason: "conteo físico" }),
    ).not.toThrow();
  });

  it("qty con más de 3 decimales se rechaza — mismo límite que Quantity.ml", () => {
    expect(() =>
      createAdjustmentInput.parse({ ...base, qty: -12.5001, reason: "rotura" }),
    ).toThrow();
  });

  it("qty con exactamente 3 decimales se acepta", () => {
    expect(() =>
      createAdjustmentInput.parse({ ...base, qty: -12.501, reason: "rotura" }),
    ).not.toThrow();
  });
});

describe("inventory — openLotInput (RF-INV-08, RN-LOT-02: solo el lote sellado, el resto lo deriva el servidor)", () => {
  const lotId = "11111111-1111-4111-a111-111111111111";

  it("acepta un lotId uuid", () => {
    expect(() => openLotInput.parse({ lotId })).not.toThrow();
  });

  it("rechaza un lotId que no es uuid", () => {
    expect(() => openLotInput.parse({ lotId: "no-es-un-uuid" })).toThrow();
  });

  it("rechaza el volumen o el granel de destino: los deriva el servidor, aceptarlos del cliente permitiría abrir contra el granel de otro producto (.strict())", () => {
    expect(() => openLotInput.parse({ lotId, nominalVolumeMl: 125 })).toThrow();
    expect(() => openLotInput.parse({ lotId, bulkVariantId: lotId })).toThrow();
  });
});

describe("inventory — openLotOutput (RN-LOT-02, caso borde 21: sourceLot nulo cuando no hubo separación)", () => {
  const id = "11111111-1111-4111-a111-111111111111";
  const lot = {
    id,
    variantId: id,
    lotCode: null,
    batchCode: null,
    parentLotId: null,
    status: "open_for_decant",
    uom: "unit",
    qtyInitial: 1,
    onHand: 0,
    unitCost: { minor: "19000", currency: "USD" },
    fxRateToPyg: 7300,
    landedCostPyg: "1496500",
    unitLandedCostPyg: "1496500",
    manufacturedAt: null,
    expiryAt: null,
    openedAt: "2026-03-10T12:00:00.000Z",
    receivedAt: "2026-03-01T12:00:00.000Z",
  };

  it("acepta la apertura directa, sin lote de origen separado", () => {
    expect(() =>
      openLotOutput.parse({ sourceLot: null, openedSealedLot: lot, bulkLot: lot, movements: [] }),
    ).not.toThrow();
  });

  it("acepta la apertura con separación, con el lote original", () => {
    expect(() =>
      openLotOutput.parse({ sourceLot: lot, openedSealedLot: lot, bulkLot: lot, movements: [] }),
    ).not.toThrow();
  });

  it("rechaza una respuesta sin el granel creado", () => {
    expect(() =>
      openLotOutput.parse({ sourceLot: null, openedSealedLot: lot, movements: [] }),
    ).toThrow();
  });
});
