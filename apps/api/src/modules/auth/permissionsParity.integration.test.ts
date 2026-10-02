import { permissionCode } from "@joda/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "../../db/testDb.js";

// WP-M11. `packages/contracts/src/security/permissions.ts` (el literal que
// valida `auth.session.current` en `router.ts`) y la tabla `permissions` que
// siembra `packages/db/seed/0001_seed_base.sql` son dos copias del mismo
// catálogo (`docs/security-spec.md` §2). Un código que existe en la base y no
// en el contrato rompe `permissionCode.array().parse(...)` para todo usuario
// que lo tenga, y el admin no carga; uno que está en el contrato y no en la
// base se puede pedir en `meta.permission` pero no se puede otorgar nunca.
// No es una regla de negocio sino una convención mecánica entre dos archivos:
// cita el documento que la define (`.claude/rules/testing.md`, excepción de
// convención mecánica).
describe("paridad entre los permisos de contratos y los del seed (docs/security-spec.md §2)", () => {
  let testDb: TestDb;
  let seededCodes: string[];

  beforeAll(async () => {
    testDb = await startTestDb();
    const { rows } = await testDb.superuserClient.query<{ code: string }>(
      "SELECT code FROM app.permissions ORDER BY code",
    );
    seededCodes = rows.map((row) => row.code);
  }, 60_000);

  afterAll(async () => {
    await testDb.stop();
  });

  it("todo código de packages/contracts está sembrado en permissions", () => {
    const missingInSeed = permissionCode.options.filter((code) => !seededCodes.includes(code));

    expect(missingInSeed).toEqual([]);
  });

  it("todo código sembrado en permissions está en packages/contracts", () => {
    const missingInContracts = seededCodes.filter(
      (code) => !(permissionCode.options as readonly string[]).includes(code),
    );

    expect(missingInContracts).toEqual([]);
  });
});
