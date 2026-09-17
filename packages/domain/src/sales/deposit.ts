// Señas (RN-SEN-01…04; ADR-013; GLOSARIO.md "Seña / depósito";
// `customer_deposits`/`customer_deposit_applications`,
// packages/db/migrations/0006_sales.sql). Una seña es un PASIVO: acredita
// `2.1.02.001 Señas de clientes` mientras no se aplica a un pedido
// (RN-SEN-01). Convertirla en ingreso es un asiento contable de
// `accounting/posting.ts` (Bloque H) — no algo que este archivo calcule ni
// decida; acá solo vive cuánto pasivo queda y si una aplicación es válida.
import { InvalidDepositInputError } from "../shared/errors.js";
import { Money } from "../shared/money.js";
import { err, ok, type Result } from "../shared/result.js";

/** RN-SEN-01 · cuenta de pasivo que acredita la seña mientras no se aplica ni se devuelve. */
export const DEPOSIT_LIABILITY_ACCOUNT_CODE = "2.1.02.001";

export interface Deposit {
  readonly id: string;
  readonly amountPyg: Money;
  readonly appliedPyg: Money;
  readonly refundedPyg: Money;
  /** `customer_deposits.expires_at` es `date`, sin vencimiento si es `null`. */
  readonly expiresAt: Date | null;
}

/** RN-SEN-01 · lo que queda como pasivo sin aplicar ni devolver — nunca ingreso, sin importar cuánto se aplicó. */
export function remainingDepositLiability(deposit: Deposit): Money {
  return deposit.amountPyg.minus(deposit.appliedPyg).minus(deposit.refundedPyg);
}

export interface DepositApplication {
  readonly depositId: string;
  readonly saleOrderId: string;
  readonly amountPyg: Money;
}

/**
 * Objeto plano con `code` — mismo criterio que `FreightError`
 * (procurement/freight.ts): esto se devuelve dentro de un `Result`, nadie
 * lo lanza. Es justo el ejemplo que cita docs/domain-contracts.md §4 ("seña
 * sobre-aplicada") de un fallo que el negocio contempla.
 */
export type DepositApplicationError = {
  readonly code: "DEPOSIT_LIMIT_EXCEEDED";
  readonly amountPyg: Money;
  readonly appliedPyg: Money;
  readonly refundedPyg: Money;
  readonly requestedPyg: Money;
};

/**
 * RN-SEN-02, RN-SEN-03 · aplica `requestedPyg` de `deposit` al pedido
 * `saleOrderId`. El límite `applied_pyg + refunded_pyg ≤ amount_pyg`
 * (RN-SEN-02) se revalida ACÁ, siempre — es un INVARIANTE, no una
 * precondición que el llamador ya garantiza (mismo `deposit.appliedPyg`
 * que se le pasa a esta función pudo quedar desactualizado entre que se
 * leyó y que se llamó). Cada aplicación es su propia fila (RN-SEN-03,
 * `customer_deposit_applications`): esta función no muta `deposit`, solo
 * devuelve el registro de la aplicación y el pasivo que queda, para que el
 * llamador decida qué persistir.
 *
 * **Ejemplo verificado (RN-SEN-03).** Seña de Gs. 500.000 aplicada íntegra
 * a un pedido: `remainingLiability` da 0 — el pasivo se agotó, tal como
 * describe el ejemplo de docs/domain-rules.md.
 */
export function applyDepositToOrder(
  deposit: Deposit,
  saleOrderId: string,
  requestedPyg: Money,
): Result<{ application: DepositApplication; remainingLiability: Money }, DepositApplicationError> {
  if (requestedPyg.isNegative() || requestedPyg.isZero()) {
    throw new InvalidDepositInputError(
      `applyDepositToOrder requiere requestedPyg positivo, recibido ${requestedPyg.minor.toString()}.`,
    );
  }

  const projectedApplied = deposit.appliedPyg.plus(requestedPyg);
  const projectedCommitted = projectedApplied.plus(deposit.refundedPyg);

  if (projectedCommitted.compare(deposit.amountPyg) > 0) {
    return err({
      code: "DEPOSIT_LIMIT_EXCEEDED",
      amountPyg: deposit.amountPyg,
      appliedPyg: deposit.appliedPyg,
      refundedPyg: deposit.refundedPyg,
      requestedPyg,
    });
  }

  return ok({
    application: { depositId: deposit.id, saleOrderId, amountPyg: requestedPyg },
    remainingLiability: deposit.amountPyg.minus(projectedApplied).minus(deposit.refundedPyg),
  });
}

/**
 * RN-SEN-04 · una seña vencida con saldo sin aplicar NO se cancela sola:
 * aparece en un reporte para decisión humana (devolución, aplicación
 * forzada, reconocimiento como ingreso — una decisión de negocio y
 * contable, no del sistema). Esta función solo identifica el caso para ese
 * reporte; a propósito, este archivo no tiene ningún `cancelDeposit` ni
 * `autoApplyDeposit` "para prolijidad".
 */
export function isDepositAwaitingManualReview(deposit: Deposit, now: Date): boolean {
  if (deposit.expiresAt === null) return false;
  return (
    deposit.expiresAt.getTime() < now.getTime() && !remainingDepositLiability(deposit).isZero()
  );
}
