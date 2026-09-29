import { defaultExclude, defineConfig } from "vitest/config";

// `exclude: dist/**` (WP-M06, backlog): el `defaultExclude` de Vitest 5 solo
// trae `node_modules` y `.git` — sin este agregado, `vitest run` también
// descubre `dist/**/*.test.js` cuando este paquete tiene un build local
// (`pnpm build`), y cada test corre dos veces: una sobre `src/` y otra sobre
// el compilado. Es el mismo defecto que WP-M01 cerró en
// packages/domain/vitest.config.ts, que no alcanzaba a apps/api.
export default defineConfig({
  test: {
    exclude: [...defaultExclude, "dist/**"],
  },
});
