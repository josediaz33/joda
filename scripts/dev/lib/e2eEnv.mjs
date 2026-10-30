import { existsSync, readFileSync } from "node:fs";
import { ENV_LOCAL_PATH } from "./config.mjs";
import { parseDotenv } from "./dotenv.mjs";
import { assertDevelopmentEnvironment } from "./guards.mjs";

// A qué apunta el humo de Playwright (WP-M18). Vive acá y no en e2e/helpers/ para que
// la baranda corra por TODAS las puertas: `pnpm e2e:smoke`, pero también
// `pnpm --filter @joda/e2e smoke` o `playwright test` a mano, que no pasan por
// scripts/dev/e2e-smoke.mjs. Los specs entran con contraseñas conocidas (devUsers.mjs):
// contra un servidor que no sea de esta máquina no pueden correr.

/**
 * @param {{ env?: Record<string, string | undefined>; envLocalPath?: string }} [options]
 * @returns {{ adminUrl: string; apiUrl: string }}
 */
export function readE2eTargets({ env = process.env, envLocalPath = ENV_LOCAL_PATH } = {}) {
  // Antes de leer nada: con NODE_ENV=production no se toca ni el disco.
  assertDevelopmentEnvironment({ env });
  if (!existsSync(envLocalPath)) {
    throw new Error(
      "No existe .env.local: corré `pnpm dev:setup` antes del humo (docs/runbooks/entorno-local.md).",
    );
  }
  const values = parseDotenv(readFileSync(envLocalPath, "utf8"));
  const adminUrl = values.ADMIN_URL;
  const apiUrl = values.JODA_API_URL;
  if (!adminUrl || !apiUrl) {
    throw new Error(".env.local no tiene ADMIN_URL/JODA_API_URL: volvé a correr `pnpm dev:setup`.");
  }
  assertDevelopmentEnvironment({
    env,
    urls: [
      ["ADMIN_URL", adminUrl],
      ["JODA_API_URL", apiUrl],
    ],
  });
  return { adminUrl, apiUrl };
}
