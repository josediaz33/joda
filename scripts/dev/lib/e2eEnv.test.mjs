// node --test scripts/dev/lib/*.test.mjs  (ver "test:dev-scripts" en package.json)
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { readE2eTargets } from "./e2eEnv.mjs";

// WP-M18: el humo de Playwright entra con las contraseñas conocidas de devUsers.mjs.
// `readE2eTargets` es la puerta de e2e/helpers/env.ts, así que la baranda vale también
// para quien corre `playwright test` sin pasar por `pnpm e2e:smoke`.
describe("readE2eTargets se niega a apuntar el humo fuera del entorno local (docs/runbooks/entorno-local.md)", () => {
  let dir = "";
  let envLocalPath = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "joda-e2e-env-"));
    envLocalPath = join(dir, ".env.local");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** @param {string} adminUrl @param {string} apiUrl */
  function writeEnvLocal(adminUrl, apiUrl) {
    writeFileSync(envLocalPath, `ADMIN_URL=${adminUrl}\nJODA_API_URL=${apiUrl}\n`);
  }

  test("devuelve el admin y la API de un .env.local de esta máquina", () => {
    writeEnvLocal("http://localhost:5173", "http://127.0.0.1:3333");

    assert.deepEqual(readE2eTargets({ env: {}, envLocalPath }), {
      adminUrl: "http://localhost:5173",
      apiUrl: "http://127.0.0.1:3333",
    });
  });

  test("rechaza un admin que no está en esta máquina", () => {
    writeEnvLocal("https://admin.joda.example", "http://127.0.0.1:3333");

    assert.throws(
      () => readE2eTargets({ env: {}, envLocalPath }),
      /ADMIN_URL no apunta a esta máquina/,
    );
  });

  test("rechaza una API que no está en esta máquina", () => {
    writeEnvLocal("http://localhost:5173", "https://api.joda.example");

    assert.throws(
      () => readE2eTargets({ env: {}, envLocalPath }),
      /JODA_API_URL no apunta a esta máquina/,
    );
  });

  test("rechaza NODE_ENV=production aunque el .env.local sea de esta máquina", () => {
    writeEnvLocal("http://localhost:5173", "http://127.0.0.1:3333");

    assert.throws(
      () => readE2eTargets({ env: { NODE_ENV: "Production" }, envLocalPath }),
      /NODE_ENV=production/,
    );
  });

  test("con NODE_ENV=production corta antes de buscar el .env.local", () => {
    assert.throws(
      () => readE2eTargets({ env: { JODA_ENV: "production" }, envLocalPath }),
      /NODE_ENV=production/,
    );
  });

  test("sin .env.local manda a correr pnpm dev:setup", () => {
    assert.throws(() => readE2eTargets({ env: {}, envLocalPath }), /pnpm dev:setup/);
  });

  test("un .env.local sin ADMIN_URL ni JODA_API_URL manda a correr pnpm dev:setup", () => {
    writeFileSync(envLocalPath, "PORT=3333\n");

    assert.throws(() => readE2eTargets({ env: {}, envLocalPath }), /ADMIN_URL\/JODA_API_URL/);
  });
});
