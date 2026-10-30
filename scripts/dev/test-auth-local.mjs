#!/usr/bin/env node
// `pnpm test:auth-local` (WP-M18): corre el contrato de StaffAuthProvider TAMBIÉN
// contra el GoTrue local, con el adaptador real (supabasePasswordProvider.ts) y sin
// cambiarlo. La corrida por defecto (`pnpm test`) sigue usando solo el proveedor
// falso: la del GoTrue local necesita este entorno y se habilita acá, con
// JODA_TEST_AUTH_LOCAL=1 y las variables de `.env.local`.
//
// Avanza WP-C03b pero no lo cierra: ese WP es contra un proyecto REAL de Supabase.
import { createRequire } from "node:module";
import { join } from "node:path";
import { REPO_ROOT } from "./lib/config.mjs";
import { assertDevelopmentEnvironment } from "./lib/guards.mjs";
import { run } from "./lib/process.mjs";
import { readLocalEnv } from "./lib/runtime.mjs";

async function main() {
  assertDevelopmentEnvironment({ env: process.env });
  const values = readLocalEnv();
  assertDevelopmentEnvironment({
    env: process.env,
    urls: [["SUPABASE_URL", values.SUPABASE_URL]],
  });

  const apiDir = join(REPO_ROOT, "apps", "api");
  const vitestCli = createRequire(join(apiDir, "package.json")).resolve("vitest/vitest.mjs");
  const { code } = await run(
    process.execPath,
    [vitestCli, "run", "src/adapters/staffAuth/staffAuthProvider.contract.test.ts"],
    {
      cwd: apiDir,
      env: {
        JODA_TEST_AUTH_LOCAL: "1",
        SUPABASE_URL: values.SUPABASE_URL,
        SUPABASE_ANON_KEY: values.SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: values.SUPABASE_SERVICE_ROLE_KEY,
      },
    },
  );
  process.exit(code);
}

main().catch((error) => {
  console.error(`[test:auth-local] ${error.message}`);
  process.exit(1);
});
