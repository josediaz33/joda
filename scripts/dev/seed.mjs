#!/usr/bin/env node
// `pnpm dev:seed` (WP-M18): vuelve a sembrar SOLO los datos de muestra, por la API,
// contra una API ya levantada (`pnpm dev`). Es lo que `pnpm dev:setup` corre al
// final; sirve para reponer el catálogo sin reiniciar la base. Re-ejecutable:
// cada paso busca antes de crear. Para empezar de cero, `pnpm dev:setup`.
import { assertDevelopmentEnvironment } from "./lib/guards.mjs";
import { log, waitForHttp } from "./lib/process.mjs";
import { readLocalEnv } from "./lib/runtime.mjs";
import { seedSampleData } from "./lib/sampleData.mjs";

async function main() {
  // Primero la baranda: con NODE_ENV=production no se toca nada, ni siquiera
  // .env.local (scripts/dev/seed.test.mjs lo comprueba).
  assertDevelopmentEnvironment({ env: process.env });

  const values = readLocalEnv();
  assertDevelopmentEnvironment({
    env: process.env,
    urls: [
      ["DATABASE_URL", values.DATABASE_URL],
      ["JODA_API_URL", values.JODA_API_URL],
      ["SUPABASE_URL", values.SUPABASE_URL],
    ],
  });

  await waitForHttp(`${values.JODA_API_URL}/`, {
    what: `la API en ${values.JODA_API_URL} (levantala con \`pnpm dev\`)`,
    timeoutMs: 15_000,
  });
  await seedSampleData({ apiUrl: values.JODA_API_URL, databaseUrl: values.DATABASE_URL });
  log("datos de muestra al día");
}

main().catch((error) => {
  console.error(`[dev:seed] ${error.message}`);
  process.exit(1);
});
