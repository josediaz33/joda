import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "../setup/db.js";

// docs/testing-strategy.md §3 (Nivel 2 — Integración): prueba de la propia
// infraestructura de Testcontainers, no de una regla de negocio — no hay
// un RN-XXX-nn que citar (.claude/rules/testing.md, excepción §2.2).
describe("infraestructura de integración: base efímera por corrida", () => {
  let db: TestDb;

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
