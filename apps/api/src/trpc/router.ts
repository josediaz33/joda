import { createAuthRouter } from "../modules/auth/router.js";
import type { AuthServiceDeps } from "../modules/auth/service.js";
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
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
