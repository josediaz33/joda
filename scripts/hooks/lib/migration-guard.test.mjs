// node --test scripts/hooks/lib/  (ver "test:hooks" en package.json)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  existsInMainBranch,
  isMigrationFilePath,
  migrationRepoRelativePath,
} from "./migration-guard.mjs";

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

// migrationRepoRelativePath ---------------------------------------------

test("migrationRepoRelativePath extrae la ruta relativa de un path absoluto de Windows", () => {
  assert.equal(
    migrationRepoRelativePath(
      "c:\\Users\\jose\\repo\\packages\\db\\migrations\\0014_rls_sweep.sql",
    ),
    "packages/db/migrations/0014_rls_sweep.sql",
  );
});

test("migrationRepoRelativePath extrae la ruta relativa de un path POSIX relativo", () => {
  assert.equal(
    migrationRepoRelativePath("packages/db/migrations/0001_foundation.sql"),
    "packages/db/migrations/0001_foundation.sql",
  );
});

test("migrationRepoRelativePath devuelve null para un path que no es de migración", () => {
  assert.equal(migrationRepoRelativePath("packages/db/seed/0001_seed_base.sql"), null);
});

// existsInMainBranch ------------------------------------------------------
//
// Repo git temporal y real (no un mock): así el guarda se prueba contra el
// mismo git que corre en producción, sin depender de si `main` está
// fetcheada en el checkout que ejecuta este test (no lo está, por ejemplo,
// en el job `test` de CI — ver .github/workflows/ci.yml, checkout de
// profundidad 1 sobre la rama del PR, sin `main` local) ni del contenido
// real del repo de JODA, que cambia con cada migración nueva.

function runGit(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function withFixtureRepo(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "migration-guard-"));
  try {
    runGit(dir, "init", "-q", "-b", "main");
    runGit(dir, "config", "user.email", "hooks-test@example.invalid");
    runGit(dir, "config", "user.name", "hooks-test");
    runGit(dir, "config", "commit.gpgsign", "false");
    const migrationsDir = path.join(dir, "packages", "db", "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(path.join(migrationsDir, "0001_foundation.sql"), "-- v1\n");
    runGit(dir, "add", "-A");
    runGit(dir, "commit", "-q", "-m", "0001 fusionada a main");
    runGit(dir, "checkout", "-q", "-b", "feat/nueva-migracion");
    writeFileSync(path.join(migrationsDir, "0002_nueva.sql"), "-- v2, sin fusionar\n");
    runGit(dir, "add", "-A");
    runGit(dir, "commit", "-q", "-m", "0002 sin fusionar a main");
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("existsInMainBranch: true para una migración ya fusionada a main (caso 1 — editarla se bloquea)", () => {
  withFixtureRepo((dir) => {
    assert.equal(
      existsInMainBranch("packages/db/migrations/0001_foundation.sql", { cwd: dir }),
      true,
    );
  });
});

test("existsInMainBranch: false para una migración nueva de la rama actual, sin fusionar (caso 2 — editarla se permite)", () => {
  withFixtureRepo((dir) => {
    assert.equal(existsInMainBranch("packages/db/migrations/0002_nueva.sql", { cwd: dir }), false);
  });
});

test("existsInMainBranch: false para un archivo que todavía no existe en ningún lado (caso 3 — crear migración nueva se permite)", () => {
  withFixtureRepo((dir) => {
    assert.equal(
      existsInMainBranch("packages/db/migrations/9999_no_existe.sql", { cwd: dir }),
      false,
    );
  });
});

test("existsInMainBranch: false sin correr git si relativePath es null o vacío", () => {
  assert.equal(existsInMainBranch(null), false);
  assert.equal(existsInMainBranch(""), false);
});

test("existsInMainBranch: tira si la rama main no se puede resolver — falla CERRADO, no abierto", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "migration-guard-nomain-"));
  try {
    runGit(dir, "init", "-q", "-b", "trunk");
    runGit(dir, "config", "user.email", "hooks-test@example.invalid");
    runGit(dir, "config", "user.name", "hooks-test");
    runGit(dir, "config", "commit.gpgsign", "false");
    writeFileSync(path.join(dir, "readme.txt"), "repo sin rama main\n");
    runGit(dir, "add", "-A");
    runGit(dir, "commit", "-q", "-m", "sin rama main");
    assert.throws(
      () => existsInMainBranch("packages/db/migrations/0001_foundation.sql", { cwd: dir }),
      /No se pudo resolver la rama 'main'/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
