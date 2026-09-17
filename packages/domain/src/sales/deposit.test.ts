import { describe, expect, it } from "vitest";
import { InvalidDepositInputError } from "../shared/errors.js";
import { Money } from "../shared/money.js";
import {
  applyDepositToOrder,
  DEPOSIT_LIABILITY_ACCOUNT_CODE,
  isDepositAwaitingManualReview,
  remainingDepositLiability,
  type Deposit,
} from "./deposit.js";

function makeDeposit(overrides: Partial<Deposit> = {}): Deposit {
  return {
    id: "deposit-1",
    amountPyg: Money.pyg(500_000n),
    appliedPyg: Money.pyg(0n),
    refundedPyg: Money.pyg(0n),
    expiresAt: null,
    ...overrides,
  };
}

describe("RN-SEN-01 · la seña es un pasivo, no un ingreso", () => {
  it("acredita la cuenta de pasivo 2.1.02.001 Señas de clientes", () => {
    expect(DEPOSIT_LIABILITY_ACCOUNT_CODE).toBe("2.1.02.001");
  });

  it("una seña recién recibida, sin aplicar ni devolver, tiene su monto íntegro como pasivo", () => {
    const deposit = makeDeposit({ amountPyg: Money.pyg(500_000n) });

    expect(remainingDepositLiability(deposit)).toEqual(Money.pyg(500_000n));
  });
});

describe("RN-SEN-02 · applied_pyg + refunded_pyg ≤ amount_pyg es un invariante", () => {
  it("aplicar menos del pasivo disponible reduce el pasivo restante exactamente en lo aplicado", () => {
    const deposit = makeDeposit({ amountPyg: Money.pyg(500_000n) });

    const result = applyDepositToOrder(deposit, "order-1", Money.pyg(200_000n));

    expect(result).toEqual({
      ok: true,
      value: {
        application: {
          depositId: "deposit-1",
          saleOrderId: "order-1",
          amountPyg: Money.pyg(200_000n),
        },
        remainingLiability: Money.pyg(300_000n),
      },
    });
  });

  it("aplicar más de lo que queda de pasivo — incluido lo ya devuelto — devuelve err() con DEPOSIT_LIMIT_EXCEEDED, sin lanzar", () => {
    const deposit = makeDeposit({
      amountPyg: Money.pyg(500_000n),
      appliedPyg: Money.pyg(300_000n),
      refundedPyg: Money.pyg(100_000n),
    });

    const result = applyDepositToOrder(deposit, "order-1", Money.pyg(150_000n));

    expect(result).toEqual({
      ok: false,
      error: {
        code: "DEPOSIT_LIMIT_EXCEEDED",
        amountPyg: Money.pyg(500_000n),
        appliedPyg: Money.pyg(300_000n),
        refundedPyg: Money.pyg(100_000n),
        requestedPyg: Money.pyg(150_000n),
      },
    });
  });

  it("el invariante se revalida siempre, incluso si applied_pyg + refunded_pyg del input ya está en el límite", () => {
    const deposit = makeDeposit({
      amountPyg: Money.pyg(500_000n),
      appliedPyg: Money.pyg(500_000n),
      refundedPyg: Money.pyg(0n),
    });

    const result = applyDepositToOrder(deposit, "order-1", Money.pyg(1n));

    expect(result.ok).toBe(false);
  });

  it("aplicar un monto no positivo es un bug del llamador: lanza InvalidDepositInputError", () => {
    const deposit = makeDeposit();

    expect(() => applyDepositToOrder(deposit, "order-1", Money.pyg(0n))).toThrow(
      InvalidDepositInputError,
    );
    expect(() => applyDepositToOrder(deposit, "order-1", Money.pyg(-1n))).toThrow(
      InvalidDepositInputError,
    );
  });
});

describe("RN-SEN-03 · aplicación parcial — cada aplicación es su propia fila", () => {
  it("ejemplo verificado de docs/domain-rules.md: seña de 500.000 aplicada íntegra a un pedido deja el pasivo en 0", () => {
    const deposit = makeDeposit({ amountPyg: Money.pyg(500_000n) });

    const result = applyDepositToOrder(deposit, "order-1", Money.pyg(500_000n));

    expect(result).toEqual({
      ok: true,
      value: {
        application: {
          depositId: "deposit-1",
          saleOrderId: "order-1",
          amountPyg: Money.pyg(500_000n),
        },
        remainingLiability: Money.pyg(0n),
      },
    });
  });

  it("no muta el deposit recibido: remainingDepositLiability del original sigue siendo el monto íntegro", () => {
    const deposit = makeDeposit({ amountPyg: Money.pyg(500_000n) });

    applyDepositToOrder(deposit, "order-1", Money.pyg(500_000n));

    expect(remainingDepositLiability(deposit)).toEqual(Money.pyg(500_000n));
  });
});

describe("RN-SEN-04 · seña vencida con saldo sin aplicar no se cancela sola", () => {
  const now = new Date("2026-06-01T00:00:00.000Z");

  it("vencida y con saldo sin aplicar: queda marcada para revisión manual", () => {
    const deposit = makeDeposit({
      amountPyg: Money.pyg(500_000n),
      appliedPyg: Money.pyg(200_000n),
      expiresAt: new Date("2026-05-01T00:00:00.000Z"),
    });

    expect(isDepositAwaitingManualReview(deposit, now)).toBe(true);
  });

  it("vencida pero sin saldo pendiente (aplicada por completo): no queda para revisión", () => {
    const deposit = makeDeposit({
      amountPyg: Money.pyg(500_000n),
      appliedPyg: Money.pyg(500_000n),
      expiresAt: new Date("2026-05-01T00:00:00.000Z"),
    });

    expect(isDepositAwaitingManualReview(deposit, now)).toBe(false);
  });

  it("sin vencimiento (expiresAt null): nunca queda para revisión", () => {
    const deposit = makeDeposit({ expiresAt: null });

    expect(isDepositAwaitingManualReview(deposit, now)).toBe(false);
  });

  it("con saldo pendiente pero todavía no vencida: no queda para revisión", () => {
    const deposit = makeDeposit({
      amountPyg: Money.pyg(500_000n),
      appliedPyg: Money.pyg(200_000n),
      expiresAt: new Date("2026-12-01T00:00:00.000Z"),
    });

    expect(isDepositAwaitingManualReview(deposit, now)).toBe(false);
  });
});
