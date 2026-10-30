// node --test scripts/dev/*.test.mjs  (ver "test:dev-scripts" en package.json)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

// WP-M18, punto 3 del encargo: «el seed se niega a correr con NODE_ENV=production».
// Los scripts de scripts/dev/ crean usuarios con contraseñas conocidas y reinician
// la base; ninguno puede correr contra producción. Cada uno se invoca de verdad, como
// lo hace `pnpm`, y tiene que cortar ANTES de leer .env.local, abrir Docker o
// tocar la red (por eso estos tests no necesitan nada de eso).
function runEntrypoint(script, env) {
  return spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("los scripts de scripts/dev/ se niegan a correr con NODE_ENV=production (docs/runbooks/entorno-local.md)", () => {
  test("dev:seed termina con error y lo explica", () => {
    const result = runEntrypoint("./seed.mjs", { NODE_ENV: "production" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /no corren con NODE_ENV=production/);
  });

  test("dev:setup termina con error y lo explica", () => {
    const result = runEntrypoint("./setup.mjs", { NODE_ENV: "production" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /no corren con NODE_ENV=production/);
  });

  test("dev:totp termina con error y lo explica", () => {
    const result = runEntrypoint("./totp.mjs", { NODE_ENV: "production" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /no corren con NODE_ENV=production/);
  });

  test("dev:seed no imprime nada por la salida estándar antes de negarse", () => {
    const result = runEntrypoint("./seed.mjs", { NODE_ENV: "production" });

    assert.equal(result.stdout, "");
  });
});
