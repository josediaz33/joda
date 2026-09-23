import { uuidGenerator } from "../adapters/uuidGenerator.js";
import { createCatalogRouter } from "../modules/catalog/router.js";
import { createMarketRouter } from "../modules/market/router.js";
import { createAuthRouter } from "../modules/auth/router.js";
import type { AuthServiceDeps } from "../modules/auth/service.js";
import { createInventoryRouter } from "../modules/inventory/router.js";
import { createExampleRouter } from "./exampleRouter.js";
import { router } from "./trpc.js";

// Los módulos de negocio (catálogo, inventario, ventas, ...) se agregan acá
// con el WP de cada uno (docs/backlog.md, bloque C). `auth` (WP-C03) es el
// primero: es una función, no un objeto estático, porque createAuthRouter
// necesita el Postgres/Redis/StaffAuthProvider reales de apps/api/src/index.ts
// (AppRouter, el TYPE, sí se puede derivar sin invocar la función con
// argumentos reales — ver `ReturnType` abajo). `example` (WP-C06) también
// pasó a ser factory: su procedimiento `irreversibleEffect` necesita el
// mismo `db` que `authDeps`, no uno propio.
export function createAppRouter(authDeps: AuthServiceDeps | null) {
  return router({
    example: createExampleRouter(authDeps?.db ?? null),
    auth: createAuthRouter(authDeps),
    catalog: createCatalogRouter(authDeps?.db ?? null),
    // El reloj es el mismo de `authDeps` (real en producción, fijo en los
    // tests); los ids de los lotes que nacen en una apertura los genera
    // `uuidGenerator` (WP-C11).
    inventory: createInventoryRouter(
      authDeps?.db ?? null,
      authDeps ? { clock: authDeps.clock, idGenerator: uuidGenerator } : null,
    ),
    market: createMarketRouter(authDeps?.db ?? null),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
