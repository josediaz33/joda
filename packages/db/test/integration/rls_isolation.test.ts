import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "../setup/db.js";
import { runSmokeBusinessFlow } from "../../scripts/lib/smoke.mjs";

// docs/security-spec.md §3.1 y ADR-016: la API se conecta con el rol
// joda_api (NOBYPASSRLS), nunca con una credencial elevada — si usara la
// del owner de las tablas o `service_role`, RLS no se evaluaría y la Capa 1
// sería decorativa. docs/testing-strategy.md §3.2 exige que esta prueba se
// conecte como joda_api DE VERDAD, no como el superusuario del contenedor:
// un test que corriera con esa credencial pasaría aunque el aislamiento
// estuviera roto, porque un superusuario elude RLS siempre.
//
// Por eso acá se abre una segunda conexión, autenticada como joda_api, en
// vez de reusar la conexión superusuario de startTestDb() con `SET ROLE`.
// joda_api no tiene password en ninguna migración — provisionar esa
// credencial en producción es una decisión del Bloque C (API), todavía
// pendiente — así que se le asigna una password de un solo uso dentro del
// contenedor efímero de este test, exclusivamente para poder autenticarse.
const REAL_TENANT_ID = "11111111-1111-1111-1111-111111111111";
// No corresponde a ningún tenant sembrado — no hace falta que exista una
// fila en `tenants`, porque `app.current_tenant_id()` solo lee un valor de
// sesión (sin FK) y la política compara por igualdad de UUID. Cualquier
// UUID distinto de REAL_TENANT_ID prueba lo mismo.
const OTHER_TENANT_ID = "22222222-0000-0000-0000-000000000099";
const JODA_API_TEST_PASSWORD = "rls-isolation-test-only";

describe("RLS aísla por tenant con el rol de aplicación joda_api (docs/security-spec.md §3.1, ADR-016)", () => {
  let db: TestDb;
  let api: Client;

  beforeAll(async () => {
    db = await startTestDb();
    // Deja datos reales de un tenant (productos, lotes, movimientos de
    // inventario) para que "cero filas" sea una aserción real y no una
    // que pasaría igual sobre una base vacía.
    await runSmokeBusinessFlow(db.client);
    await db.client.query(`ALTER ROLE joda_api PASSWORD '${JODA_API_TEST_PASSWORD}'`);

    api = new Client({
      host: db.container.getHost(),
      port: db.container.getPort(),
      database: db.container.getDatabase(),
      user: "joda_api",
      password: JODA_API_TEST_PASSWORD,
    });
    await api.connect();
  }, 60_000);

  afterAll(async () => {
    await api.end();
    await db.stop();
  });

  it("sin tenant_id en contexto, joda_api no ve filas de ningún tenant", async () => {
    await api.query("BEGIN");
    const { rowCount } = await api.query("SELECT * FROM app.products");
    await api.query("ROLLBACK");

    expect(rowCount).toBe(0);
  });

  it("con el tenant_id de otro tenant, joda_api no ve las filas del tenant real", async () => {
    await api.query("BEGIN");
    await api.query("SELECT set_config('app.tenant_id', $1, true)", [OTHER_TENANT_ID]);
    const { rowCount } = await api.query("SELECT * FROM app.products");
    await api.query("ROLLBACK");

    expect(rowCount).toBe(0);
  });

  it("con su propio tenant_id, joda_api sí ve las filas de ese tenant (control positivo)", async () => {
    await api.query("BEGIN");
    await api.query("SELECT set_config('app.tenant_id', $1, true)", [REAL_TENANT_ID]);
    const { rowCount } = await api.query("SELECT * FROM app.products");
    await api.query("ROLLBACK");

    expect(rowCount).toBeGreaterThan(0);
  });

  it("joda_api no puede hacer UPDATE sobre el ledger (inventory_movements)", async () => {
    await api.query("BEGIN");
    await expect(
      api.query(
        "UPDATE app.inventory_movements SET total_cost_pyg = total_cost_pyg WHERE id = $1",
        [0],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await api.query("ROLLBACK");
  });
});
