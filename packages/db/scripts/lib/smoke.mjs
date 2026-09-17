import { readSqlFile } from "./sql-files.mjs";
import { testFile } from "./tasks.mjs";

// packages/db/tests/smoke_business_flow.sql corre el flujo de negocio real
// de punta a punta (compra en USD con flete → recepción → apertura de
// frasco → fraccionamiento con merma → venta → asiento contable) y termina
// con un puñado de SELECT pensados para que alguien los lea a mano en
// psql ("debe estar VACÍO", "el asiento cuadra"). Acá se afirman en código
// las dos que importan (docs/domain-rules.md, packages/db/README.md
// "Verificación"): deriva cero contra el ledger y el asiento balanceado.
const SALE_ENTRY_ID = "f0000000-0000-0000-0000-000000000001";

export async function runSmokeBusinessFlow(client) {
  const file = testFile("smoke_business_flow.sql");
  console.log(`[db:test] ${file}`);
  await client.query(readSqlFile(file));

  const drift = await client.query("SELECT count(*)::int AS filas FROM v_balance_drift");
  const filasConDeriva = drift.rows[0].filas;
  if (filasConDeriva !== 0) {
    throw new Error(
      `v_balance_drift tiene ${filasConDeriva} fila(s) — el ledger y la ` +
        "proyección de saldos no cuadran.",
    );
  }

  const asiento = await client.query(
    `SELECT sum(debit_pyg) - sum(credit_pyg) AS diferencia
       FROM journal_lines
      WHERE entry_id = $1`,
    [SALE_ENTRY_ID],
  );
  const diferencia = Number(asiento.rows[0].diferencia);
  if (diferencia !== 0) {
    throw new Error(`El asiento ${SALE_ENTRY_ID} no cuadra: diferencia de ${diferencia} Gs.`);
  }

  console.log("[db:test] smoke_business_flow.sql OK — deriva cero, asiento cuadrado");
}
