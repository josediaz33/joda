import {
  adminDecantWorkOrderSchema,
  executeDecantInput,
  executeDecantOutput,
  listDecantOrdersInput,
  listDecantOrdersOutput,
  planDecantInput,
  planDecantOutput,
  startDecantInput,
} from "@joda/contracts";
import type { PrismaClient } from "@joda/db";
import { appError, toTRPCError } from "../../middleware/errorMapper.js";
import { router, staffProcedure } from "../../trpc/trpc.js";
import * as decantService from "./service.js";
import type { DecantServiceDeps } from "./service.js";

/** `db === null` solo pasa en apps/api/src/trpc/router.test.ts (WP-C01), mismo criterio que requireDb de modules/inventory/router.ts. */
function requireDb(db: PrismaClient | null): PrismaClient {
  if (db === null) {
    throw toTRPCError(
      appError("INTERNAL", 500, "El servidor no tiene la base de datos configurada."),
    );
  }
  return db;
}

/** Igual que `requireDb`: las dependencias son `null` solo cuando no hay `authDeps` (router.test.ts). */
function requireDeps(deps: DecantServiceDeps | null): DecantServiceDeps {
  if (deps === null) {
    throw toTRPCError(appError("INTERNAL", 500, "El servidor no tiene el reloj configurado."));
  }
  return deps;
}

// Planificar, iniciar y ejecutar son lo mismo que `inventory.decant:execute`
// (docs/security-spec.md §2): es el permiso que la política de escritura de
// `inventory_movements` (WP-B11d) pide para los movimientos de la ejecución.
// La cola solo lee: el mismo permiso que ver saldos y lotes.
const EXECUTE = { permission: "inventory.decant:execute" } as const;
const READ = { permission: "inventory.stock:read" } as const;

/**
 * Se monta bajo `inventory` (`inventory.decant.*`): el fraccionamiento es una
 * transformación de inventario (ADR-009, ADR-010). El dominio dice que el
 * decant tiene DOS momentos y acá son procedimientos distintos: `plan` (el
 * compromiso: crea la orden, no consume) y `execute` (la merma real y los
 * movimientos definitivos), con `start` entre medio (RN-EST-03).
 */
export function createDecantRouter(db: PrismaClient | null, deps: DecantServiceDeps | null) {
  return router({
    plan: staffProcedure
      .meta(EXECUTE)
      .input(planDecantInput)
      .output(planDecantOutput)
      .mutation(({ ctx, input }) => decantService.planWorkOrder(requireDb(db), ctx, input)),
    start: staffProcedure
      .meta(EXECUTE)
      .input(startDecantInput)
      .output(adminDecantWorkOrderSchema)
      .mutation(({ ctx, input }) => decantService.startWorkOrder(requireDb(db), ctx, input)),
    execute: staffProcedure
      .meta(EXECUTE)
      .input(executeDecantInput)
      .output(executeDecantOutput)
      .mutation(({ ctx, input }) =>
        decantService.executeWorkOrder(requireDb(db), requireDeps(deps), ctx, input),
      ),
    list: staffProcedure
      .meta(READ)
      .input(listDecantOrdersInput)
      .output(listDecantOrdersOutput)
      .query(({ ctx, input }) => decantService.listDecantOrders(requireDb(db), ctx, input)),
  });
}
