// node --test scripts/dev/*.test.mjs  (ver "test:dev-scripts" en package.json)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

// WP-M18, punto 3 del encargo: «el seed se niega a correr con NODE_ENV=production».
// Los scripts de scripts/dev/ crean usuarios con contraseñas conocidas y reinician
// la base; ninguno puede correr contra producción. Cada uno se invoca de verdad, como
// lo hace `pnpm`, y tiene que cortar ANTES de leer .env.local, abrir Docker o
// tocar la red (por eso estos tests no necesitan nada de eso).
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Contención: estos tests invocan los scripts de verdad. Si la baranda de alguno se rompiera,
// el script seguiría de largo; con esto no llega a tocar nada del entorno de quien corre la
// suite. Docker apunta a un puerto cerrado (setup.mjs muere en «Docker no responde» antes de
// escribir nada), el proyecto de compose es otro y .env.local es un archivo que no existe
// (seed, e2e-smoke y test-auth-local mueren en «No existe .env.local»).
const CONTAINMENT = {
  DOCKER_HOST: "tcp://127.0.0.1:9",
  JODA_COMPOSE_PROJECT: "joda-guard-test",
  JODA_ENV_LOCAL_PATH: join(tmpdir(), "joda-guard-test-no-existe", ".env.local"),
};

function runEntrypoint(script, env) {
  return spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
    env: { ...process.env, ...CONTAINMENT, ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
}

// Todos los scripts de entrada de `pnpm dev:*`, `pnpm e2e:smoke` y `pnpm test:auth-local`.
// Uno nuevo en scripts/dev/ se suma acá: si llama a la baranda tarde (o nunca), este
// archivo es el que lo nota.
const ENTRYPOINTS = [
  ["dev:seed", "./seed.mjs"],
  ["dev:setup", "./setup.mjs"],
  ["dev:totp", "./totp.mjs"],
  ["e2e:smoke", "./e2e-smoke.mjs"],
  ["test:auth-local", "./test-auth-local.mjs"],
];

// Las grafías que una `.env` editada a mano o un valor pegado de una consola pueden
// traer. Una baranda que solo reconoce el literal `production` las deja pasar.
const PRODUCTION_SPELLINGS = [
  ["NODE_ENV=production", { NODE_ENV: "production" }],
  ["NODE_ENV=Production", { NODE_ENV: "Production" }],
  ["NODE_ENV=PRODUCTION", { NODE_ENV: "PRODUCTION" }],
  ["NODE_ENV=' production'", { NODE_ENV: " production" }],
  ["NODE_ENV='production\\n'", { NODE_ENV: "production\n" }],
  ["JODA_ENV=production", { JODA_ENV: "production" }],
  ["JODA_ENV=Production", { JODA_ENV: "Production" }],
];

describe("los scripts de scripts/dev/ se niegan a correr con NODE_ENV=production (docs/runbooks/entorno-local.md)", () => {
  for (const [name, script] of ENTRYPOINTS) {
    describe(name, () => {
      for (const [label, env] of PRODUCTION_SPELLINGS) {
        test(`con ${label} termina con error y lo explica, sin escribir nada por stdout`, () => {
          const result = runEntrypoint(script, env);

          assert.equal(result.status, 1);
          assert.match(result.stderr, /no corren con NODE_ENV=production/);
          assert.equal(result.stdout, "");
        });
      }
    });
  }

  // Controles de la contención: sin producción, cada script llega a SU primer paso real y
  // ahí muere, sin haber tocado nada. Si la baranda de uno se rompiera, sería esto lo que
  // pasaría con las grafías de producción de arriba.
  for (const [name, script, firstStep] of [
    ["dev:setup", "./setup.mjs", /Docker no responde/],
    ["dev:seed", "./seed.mjs", /No existe .env.local/],
    ["e2e:smoke", "./e2e-smoke.mjs", /No existe .env.local/],
    ["test:auth-local", "./test-auth-local.mjs", /No existe .env.local/],
  ]) {
    test(`${name} sin producción muere en su primer paso, sin tocar el entorno`, () => {
      const result = runEntrypoint(script, { NODE_ENV: "development", JODA_ENV: "" });

      assert.equal(result.status, 1);
      assert.match(result.stderr, firstStep);
    });
  }

  test("la baranda no corta de más: con NODE_ENV=development dev:totp no la nombra", () => {
    // Sin esto, los tests de arriba pasarían igual si el script fallara siempre.
    const result = runEntrypoint("./totp.mjs", { NODE_ENV: "development", JODA_ENV: "" });

    assert.doesNotMatch(result.stderr, /no corren con NODE_ENV=production/);
  });
});

describe("el humo de Playwright se niega a correr con NODE_ENV=production aunque no pase por e2e:smoke (docs/runbooks/entorno-local.md)", () => {
  // `pnpm --filter @joda/e2e smoke` y `playwright test` a mano no pasan por
  // scripts/dev/e2e-smoke.mjs: la baranda tiene que estar también en la configuración.
  const playwrightCli = createRequire(`${REPO_ROOT}e2e/package.json`).resolve(
    "@playwright/test/cli",
  );

  for (const [label, env] of [
    ["NODE_ENV=production", { NODE_ENV: "production" }],
    ["JODA_ENV=Production", { JODA_ENV: "Production" }],
  ]) {
    test(`con ${label}, playwright test --list termina con error y lo explica`, () => {
      const result = spawnSync(process.execPath, [playwrightCli, "test", "--list"], {
        cwd: `${REPO_ROOT}e2e`,
        env: { ...process.env, ...CONTAINMENT, ...env },
        encoding: "utf8",
        timeout: 60_000,
      });

      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /no corren con NODE_ENV=production/);
    });
  }
});
