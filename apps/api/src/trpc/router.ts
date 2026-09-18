import { exampleRouter } from "./exampleRouter.js";
import { router } from "./trpc.js";

// Los módulos de negocio (catálogo, inventario, ventas, ...) se agregan acá
// con el WP de cada uno (docs/backlog.md, bloque C). Por ahora solo el
// router de ejemplo del esqueleto.
export const appRouter = router({
  example: exampleRouter,
});

export type AppRouter = typeof appRouter;
