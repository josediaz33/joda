#!/usr/bin/env node
// `pnpm e2e:smoke` (WP-M18): el humo de punta a punta, con Playwright, contra el
// entorno local YA sembrado (`pnpm dev:setup`). Compila los paquetes, instala el
// navegador si falta y corre e2e/. Playwright mismo levanta la API y el admin si no
// están corriendo (e2e/playwright.config.ts) y reutiliza los que ya estén.
// Argumentos extra pasan a Playwright: `pnpm e2e:smoke --headed`, `... --grep Catálogo`.
import { createRequire } from "node:module";
import { join } from "node:path";
import { REPO_ROOT } from "./lib/config.mjs";
import { assertDevelopmentEnvironment } from "./lib/guards.mjs";
import { log, run, runOrFail } from "./lib/process.mjs";
import { buildWorkspaceDependencies, readLocalEnv } from "./lib/runtime.mjs";

async function main() {
  assertDevelopmentEnvironment({ env: process.env });
  const values = readLocalEnv();
  assertDevelopmentEnvironment({
    env: process.env,
    urls: [
      ["JODA_API_URL", values.JODA_API_URL],
      ["SUPABASE_URL", values.SUPABASE_URL],
    ],
  });

  const requireFromE2e = createRequire(join(REPO_ROOT, "e2e", "package.json"));
  const playwrightCli = requireFromE2e.resolve("@playwright/test/cli");

  log("compilando los paquetes de los que dependen la API y el admin…");
  await buildWorkspaceDependencies();

  // Idempotente: si Chromium ya está instalado no descarga nada.
  log("comprobando el navegador de Playwright (Chromium)…");
  await runOrFail(process.execPath, [playwrightCli, "install", "chromium"], {
    cwd: join(REPO_ROOT, "e2e"),
  });

  log("corriendo el humo…");
  const { code } = await run(process.execPath, [playwrightCli, "test", ...process.argv.slice(2)], {
    cwd: join(REPO_ROOT, "e2e"),
    // NODE_ENV explícito: lo hereda la API que Playwright levanta, y con `test` no arrancaría.
    env: { NODE_ENV: "development" },
  });
  process.exit(code);
}

main().catch((error) => {
  console.error(`[e2e:smoke] ${error.message}`);
  process.exit(1);
});
