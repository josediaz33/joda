import { defineConfig } from "vitest/config";

// Umbral de cobertura de shared/, tax/ y procurement/ (100% líneas y ramas —
// WP-A03/A04/A05, ver docs/testing-strategy.md §2.1 y
// docs/domain-contracts.md §8). Los barrels (index.ts) quedan afuera: son
// solo re-exports, sin lógica que cubrir.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/shared/**/*.ts", "src/tax/**/*.ts", "src/procurement/**/*.ts"],
      exclude: [
        "src/shared/index.ts",
        "src/tax/index.ts",
        "src/procurement/index.ts",
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
