import { readSqlFile } from "./sql-files.mjs";
import { testFile } from "./tasks.mjs";

// packages/db/tests/invariants.sql — cada prueba INTENTA una operación
// inválida y espera que la base la rechace (ver docs/backlog.md WP-B03).
// El helper pg_temp.expect_fail() del propio archivo atrapa la excepción y
// la registra en una tabla `results`; nunca relanza. Por eso "no hubo error
// de SQL" no alcanza para decir que pasó: hay que leer esa tabla.
const EXPECTED_INVARIANT_COUNT = 131;

export async function runInvariants(client) {
  const file = testFile("invariants.sql");
  console.log(`[db:test] ${file}`);
  await client.query(readSqlFile(file));

  const { rows } = await client.query("SELECT n, nombre, resultado FROM results ORDER BY n");
  for (const r of rows) {
    console.log(`  ${String(r.n).padStart(2, " ")}. ${r.resultado} — ${r.nombre}`);
  }

  const total = rows.length;
  const fallaron = rows.filter((r) => r.resultado.startsWith("FALLO")).length;

  // Si una prueba no llegó a insertar su fila (por ejemplo, un error de
  // sintaxis en el propio archivo de test antes de terminarlo), `fallaron`
  // da 0 igual que si las 18 hubieran pasado. Se exige el total exacto,
  // no solo cero fallos, para no reportar verde con menos invariantes
  // verificados que los que hay.
  if (total !== EXPECTED_INVARIANT_COUNT) {
    throw new Error(
      `invariants.sql registró ${total} prueba(s) en \`results\`, se esperaban ` +
        `${EXPECTED_INVARIANT_COUNT} — alguna no llegó a correr.`,
    );
  }
  if (fallaron > 0) {
    throw new Error(`${fallaron}/${total} invariantes fallaron (ver detalle arriba).`);
  }

  console.log(`[db:test] invariants.sql OK — ${total}/${total} invariantes en verde`);
}
