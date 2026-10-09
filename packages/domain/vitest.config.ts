import { defaultExclude, defineConfig } from "vitest/config";

// Umbral de cobertura de shared/, tax/, procurement/, sourcing/, inventory/,
// decant/ y accounting/ (100% líneas y ramas — WP-A03/A04/A05/A06/A07/B14/C16,
// ver docs/testing-strategy.md §2.1 y docs/domain-contracts.md §8). Los
// barrels (index.ts) quedan afuera: son solo re-exports, sin lógica que
// cubrir.
//
// `exclude: dist/**` (WP-M01, backlog): el `defaultExclude` de Vitest 5 solo
// trae `node_modules` y `.git` — sin este agregado, `vitest run` también
// descubre `dist/**/*.test.js` cuando este paquete tiene un build local
// (`pnpm build`, o el `^build` que Turborepo corre antes de `typecheck`/`test`
// de cualquier consumidor de @joda/domain, como apps/api desde WP-C03). Eso
// no solo duplica cada test — `test/golden/registry.test.ts` (WP-A10)
// además ROMPE de verdad ahí adentro: busca sus `.json`/`.test.ts` hermanos
// por ruta relativa a `import.meta.url`, y esos `.ts` no existen dentro de
// `dist/`. Sin este `exclude`, `pnpm test` en la raíz queda roto para
// cualquiera que haya corrido un build de este paquete antes.
//
// `src/__boundary-check.generated.test.ts` — mismo motivo que el `exclude`
// de tsconfig.json (ver ese comentario): packages/config/test/
// boundaries.test.ts lo escribe y lo borra en cada test, y corre en
// paralelo con este paquete cuando Turbo ejecuta "test". Sin excluirlo acá
// también, una corrida de `vitest run` de este paquete podría, con la
// misma mala suerte de timing, descubrirlo como un archivo de test real a
// mitad de escritura.
export default defineConfig({
  test: {
    exclude: [...defaultExclude, "dist/**", "src/__boundary-check.generated.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "src/shared/**/*.ts",
        "src/tax/**/*.ts",
        "src/procurement/**/*.ts",
        "src/sourcing/**/*.ts",
        "src/inventory/**/*.ts",
        "src/decant/**/*.ts",
        "src/accounting/**/*.ts",
      ],
      exclude: [
        "src/shared/index.ts",
        "src/tax/index.ts",
        "src/procurement/index.ts",
        "src/sourcing/index.ts",
        "src/inventory/index.ts",
        "src/decant/index.ts",
        "src/accounting/index.ts",
        "**/*.test.ts",
      ],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
