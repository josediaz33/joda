import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "../setup/db.js";

// docs/testing-strategy.md §3 (Nivel 2 — Integración): prueba de la propia
// infraestructura de Testcontainers, no de una regla de negocio — no hay
// un RN-XXX-nn que citar (.claude/rules/testing.md, excepción §2.2).
describe("infraestructura de integración: base efímera por corrida", () => {
  let db: TestDb;

  // Este 60_000 es el timeout del hook de Vitest (para no colgarse si el
  // pull de la imagen o la migración se traban) — no es una medición ni
  // una aserción de que la corrida completa entra en el presupuesto de 60s
  // del criterio de aceptación de WP-B05. Esa medición es manual: ver el
  // tiempo real del job "Test" en CI para este PR.
  beforeAll(async () => {
    db = await startTestDb();
  }, 60_000);

  afterAll(async () => {
    await db.stop();
  });

  it("corre migrations y seed sobre Postgres real antes de los tests", async () => {
    const { rows } = await db.client.query(
      "SELECT description FROM app.permissions WHERE code = $1",
      ["catalog.product:read"],
    );

    expect(rows).toEqual([{ description: "Ver productos y variantes" }]);
  });
});
