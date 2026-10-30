import { defineConfig, devices } from "@playwright/test";
import { readE2eEnv } from "./helpers/env";

// Humo de punta a punta (WP-M18, docs/testing-strategy.md §6, nivel 5): el admin real
// en un navegador real contra la API real, Postgres, Redis y el Auth local sembrados por
// `pnpm dev:setup`. Se corre con `pnpm e2e:smoke` (docs/runbooks/entorno-local.md).
//
// Cómo sumar pantallas (WP-E06, WP-E07, ...): un archivo `specs/<modulo>.spec.ts` por
// módulo del admin, con `loginAs(page, "<rol>")` de helpers/login.ts para entrar y
// `apiAs("<rol>")` de helpers/api.ts para preparar o comprobar datos por la API. Los datos
// de muestra están en scripts/dev/lib/sampleData.mjs: si una pantalla necesita más, se
// agregan ahí (por la API), no en el spec.
const env = readE2eEnv();

export default defineConfig({
  testDir: "./specs",
  outputDir: "./test-results",
  // Un solo trabajador: los specs comparten la misma base y el contador de intentos de
  // contraseña y de segundo factor de Redis.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]]
    : [["list"]],
  use: {
    baseURL: env.adminUrl,
    locale: "es-PY",
    timezoneId: "America/Asuncion",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Levanta lo que falte y reutiliza lo que ya esté corriendo (`pnpm dev`) fuera de CI.
  // Los paquetes compilados los deja listos `pnpm e2e:smoke` (scripts/dev/e2e-smoke.mjs).
  webServer: [
    {
      command: "pnpm --filter @joda/api dev",
      url: `${env.apiUrl}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { NODE_ENV: "development" },
    },
    {
      command: "pnpm --filter @joda/admin dev",
      url: env.adminUrl,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { NODE_ENV: "development" },
    },
  ],
});
