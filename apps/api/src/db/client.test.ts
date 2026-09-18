import { PrismaClient } from "@joda/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jodaApiConnectionUrl, startTestDb, type TestDb } from "./testDb.js";
import { assertRlsNotBypassed } from "./client.js";

// docs/security-spec.md §3.1: joda_api es NOBYPASSRLS; el superusuario con
// el que arrancan las migraciones y Testcontainers es lo contrario. No es
// una regla de negocio, es la convención de arranque que ese documento fija
// (.claude/rules/testing.md, excepción de convención mecánica).
describe("assertRlsNotBypassed aborta si la credencial conectada elude RLS (docs/security-spec.md §3.1)", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await startTestDb();
  }, 60_000);

  afterAll(async () => {
    await testDb.stop();
  });

  it("no lanza cuando la conexión es joda_api (NOBYPASSRLS)", async () => {
    const db = new PrismaClient({ datasourceUrl: jodaApiConnectionUrl(testDb.container) });

    try {
      await expect(assertRlsNotBypassed(db)).resolves.toBeUndefined();
    } finally {
      await db.$disconnect();
    }
  });

  it("lanza cuando la conexión es el superusuario del contenedor (BYPASSRLS)", async () => {
    const db = new PrismaClient({ datasourceUrl: `${testDb.connectionUri}?connection_limit=1` });

    try {
      await expect(assertRlsNotBypassed(db)).rejects.toThrow(/BYPASSRLS/);
    } finally {
      await db.$disconnect();
    }
  });
});
