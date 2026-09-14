// Selección de lotes por política (RN-LOT-05; docs/domain-contracts.md
// §6.1). Esta función decide de QUÉ lotes conviene consumir primero; no
// decide CUÁNTO se consume de cada uno ni arma las capas de costo — eso es
// costing.ts (RN-COS-04), que usa el orden que esta función produce para
// decidir cuánto sale de cada lote, pero devuelve el resultado ordenado
// por id ascendente (RN-LOT-05, orden de bloqueo), no en este orden.
import type { Money } from "../shared/money.js";
import type { Quantity } from "../shared/quantity.js";

export type AllocationPolicy = "fifo" | "fefo" | "serial" | "manual";

export type LotStatus = "available" | "open_for_decant" | "quarantine" | "damaged" | "depleted";

export interface LotSnapshot {
  readonly id: string;
  readonly receivedAt: Date;
  readonly expiryAt: Date | null;
  readonly available: Quantity;
  readonly unitCost: Money;
  readonly status: LotStatus;
}

/**
 * Solo los lotes en `available` con saldo positivo son candidatos a
 * consumo. Un lote en `quarantine`, `damaged`, `depleted` o
 * `open_for_decant` no participa aunque `available` muestre un número
 * distinto de cero — ese número, si existe, no es saldo vendible.
 */
function eligibleLots(lots: readonly LotSnapshot[]): readonly LotSnapshot[] {
  return lots.filter((lot) => lot.status === "available" && lot.available.value > 0);
}

/** Desempate universal de RN-LOT-05: "ante empate, desempata el id ascendente". */
function compareById(a: LotSnapshot, b: LotSnapshot): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** RN-LOT-05 · fifo: menor `receivedAt` primero. */
function compareByReceivedAt(a: LotSnapshot, b: LotSnapshot): number {
  return a.receivedAt.getTime() - b.receivedAt.getTime();
}

/**
 * RN-LOT-05 · fefo: menor `expiryAt` primero; los lotes sin vencimiento
 * (`null`) van al final, no al principio — es la trampa explícita de esta
 * política. `null` nunca es "el vencimiento más chico".
 *
 * Si cualquiera de los dos es `null`, el resultado sale de comparar
 * "es null" (1) contra "no es null" (0) — sin Infinity−Infinity (sería
 * NaN) ni una rama separada por cada combinación de null×null, null×fecha
 * y fecha×null. Queda simétrico (`compareByExpiryAt(a, b) ===
 * -compareByExpiryAt(b, a)` siempre), así que no importa en qué orden
 * Array.sort decida invocarlo — eso no es parte de su contrato.
 */
function compareByExpiryAt(a: LotSnapshot, b: LotSnapshot): number {
  if (a.expiryAt === null || b.expiryAt === null) {
    return Number(a.expiryAt === null) - Number(b.expiryAt === null);
  }
  return a.expiryAt.getTime() - b.expiryAt.getTime();
}

/**
 * RN-LOT-05 · ordena los lotes candidatos según `policy`. El resultado es
 * el orden en que costing.ts va a consumirlos, siempre determinístico:
 *
 * - `fifo`/`fefo` ordenan por su criterio temporal, con id ascendente
 *   como desempate.
 * - `serial`/`manual` no tienen criterio temporal propio — RN-LOT-05 dice
 *   que el lote "se elige explícitamente" (serial) o que "el operador
 *   elige el lote" (manual): la decisión de negocio ya ocurrió antes de
 *   llamar a esta función, afuera del dominio. Lo único que le queda a
 *   `selectLotsByPolicy` es un orden determinístico entre los candidatos
 *   que quedaron, y para eso usa el mismo desempate universal, id
 *   ascendente, en vez de inventar un criterio que RN-LOT-05 no da.
 *
 * Esto NO es todavía el orden de bloqueo final. RN-LOT-05 es explícito en
 * que ese orden es una propiedad de la API (el `SELECT ... FOR UPDATE`
 * siempre en id ascendente, para evitar interbloqueos en pedidos
 * multi-línea), no de la política de consumo — lo fija `allocateFromLots`
 * (costing.ts) sobre las capas ya construidas, independiente de cuál
 * política decidió las cantidades.
 */
export function selectLotsByPolicy(
  lots: readonly LotSnapshot[],
  policy: AllocationPolicy,
): readonly LotSnapshot[] {
  const candidates = eligibleLots(lots);

  switch (policy) {
    case "fifo":
      return [...candidates].sort((a, b) => compareByReceivedAt(a, b) || compareById(a, b));
    case "fefo":
      return [...candidates].sort((a, b) => compareByExpiryAt(a, b) || compareById(a, b));
    case "serial":
    case "manual":
      return [...candidates].sort(compareById);
  }
}
