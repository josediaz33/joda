import { defineConfig } from "vitest/config";

// Umbral de cobertura de shared/ (100% líneas y ramas — WP-A03, ver
// docs/testing-strategy.md §2.1). Los barrels (index.ts) quedan afuera:
// son solo re-exports, sin lógica que cubrir.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/shared/**/*.ts"],
      exclude: ["src/shared/index.ts", "**/*.test.ts"],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
