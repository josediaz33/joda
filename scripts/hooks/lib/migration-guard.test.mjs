// node --test scripts/hooks/lib/  (ver "test:hooks" en package.json)
import { test } from "node:test";
import assert from "node:assert/strict";
import { isMigrationFilePath } from "./migration-guard.mjs";

// Payload REAL, capturado del stdin real que Claude Code le mandó al hook
// en Windows durante un Edit sobre una migración existente (no un fixture
// armado a mano) — ver PR #13 para el detalle de cómo se capturó.
const REAL_WINDOWS_PAYLOAD =
  "c:\\Users\\jose.diaz.ITAPUA\\Desktop\\JODA Parfums ERP Ecomm\\packages\\db\\migrations\\0004_inventory.sql";

test("detecta el path absoluto de Windows con backslashes tal como lo manda la herramienta de verdad", () => {
  assert.equal(isMigrationFilePath(REAL_WINDOWS_PAYLOAD), true);
});

test("detecta un path relativo de Windows con backslashes", () => {
  assert.equal(isMigrationFilePath("packages\\db\\migrations\\0002_identity_rbac.sql"), true);
});

test("detecta un path POSIX (Linux/Mac, para cuando esto corra en CI)", () => {
  assert.equal(
    isMigrationFilePath("/home/runner/work/joda/packages/db/migrations/0001_foundation.sql"),
    true,
  );
});

test("detecta un path relativo POSIX simple", () => {
  assert.equal(isMigrationFilePath("packages/db/migrations/0001_foundation.sql"), true);
});

test("es insensible a mayúsculas/minúsculas en la extensión", () => {
  assert.equal(
    isMigrationFilePath("C:\\repo\\packages\\db\\migrations\\0001_foundation.SQL"),
    true,
  );
});

test("no detecta un .sql fuera de packages/db/migrations/", () => {
  assert.equal(isMigrationFilePath("packages/db/seed/00_roles.sql"), false);
  assert.equal(isMigrationFilePath("packages\\db\\tests\\invariants.sql"), false);
});

test("no detecta un archivo que no es .sql dentro del directorio de migraciones", () => {
  assert.equal(isMigrationFilePath("packages/db/migrations/README.md"), false);
});

test("no detecta un .sql en un subdirectorio de migrations/ (el patrón es plano, no recursivo)", () => {
  assert.equal(isMigrationFilePath("packages/db/migrations/archive/0000_old.sql"), false);
});

test("no rompe con undefined/null/vacío", () => {
  assert.equal(isMigrationFilePath(undefined), false);
  assert.equal(isMigrationFilePath(null), false);
  assert.equal(isMigrationFilePath(""), false);
});
