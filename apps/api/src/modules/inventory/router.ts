import {
  adminMovementSchema,
  adminSerializedUnitSchema,
  createAdjustmentInput,
  createSerializedUnitInput,
  listSerializedUnitsInput,
  listSerializedUnitsOutput,
  lotHistoryInput,
  lotHistoryOutput,
  openLotInput,
  openLotOutput,
  serializedUnitHistoryInput,
  serializedUnitHistoryOutput,
  stockAvailabilityInput,
  stockAvailabilitySchema,
} from "@joda/contracts";
import type { PrismaClient } from "@joda/db";
import { appError, toTRPCError } from "../../middleware/errorMapper.js";
import { router, staffProcedure } from "../../trpc/trpc.js";
import { createDecantRouter } from "../decant/router.js";
import * as inventoryService from "./service.js";
import type { InventoryServiceDeps } from "./service.js";

/** `db === null` solo pasa en apps/api/src/trpc/router.test.ts (WP-C01), mismo criterio que requireDb de modules/catalog/router.ts. */
function requireDb(db: PrismaClient | null): PrismaClient {
  if (db === null) {
    throw toTRPCError(
      appError("INTERNAL", 500, "El servidor no tiene la base de datos configurada."),
    );
  }
  return db;
}

/** Igual que `requireDb`: las dependencias son `null` solo cuando no hay `authDeps` (router.test.ts). */
function requireDeps(deps: InventoryServiceDeps | null): InventoryServiceDeps {
  if (deps === null) {
    throw toTRPCError(appError("INTERNAL", 500, "El servidor no tiene el reloj configurado."));
  }
  return deps;
}

const READ = { permission: "inventory.stock:read" } as const;
const ADJUST = { permission: "inventory.stock:adjust" } as const;
// Abrir un frasco es el primer paso del fraccionamiento (RN-LOT-02, ADR-009):
// el mismo permiso que ejecuta las órdenes de fraccionamiento. Es el que usa
// WP-B11 para la política de escritura de `inventory_lots` en la apertura.
const OPEN_BOTTLE = { permission: "inventory.decant:execute" } as const;

export function createInventoryRouter(db: PrismaClient | null, deps: InventoryServiceDeps | null) {
  const stock = router({
    available: staffProcedure
      .meta(READ)
      .input(stockAvailabilityInput)
      .output(stockAvailabilitySchema)
      .query(({ ctx, input }) => inventoryService.getStockAvailability(requireDb(db), ctx, input)),
  });

  const lot = router({
    history: staffProcedure
      .meta(READ)
      .input(lotHistoryInput)
      .output(lotHistoryOutput)
      .query(({ ctx, input }) => inventoryService.getLotHistory(requireDb(db), ctx, input)),
    open: staffProcedure
      .meta(OPEN_BOTTLE)
      .input(openLotInput)
      .output(openLotOutput)
      .mutation(({ ctx, input }) =>
        inventoryService.openLot(requireDb(db), requireDeps(deps), ctx, input),
      ),
  });

  const adjustment = router({
    create: staffProcedure
      .meta(ADJUST)
      .input(createAdjustmentInput)
      .output(adminMovementSchema)
      .mutation(({ ctx, input }) => inventoryService.createAdjustment(requireDb(db), ctx, input)),
  });

  // WP-C12. El alta suelta es un ajuste de inventario (`inventory.stock:adjust`);
  // el flujo real carga los seriales al recibir la compra (WP-C15).
  const serial = router({
    create: staffProcedure
      .meta(ADJUST)
      .input(createSerializedUnitInput)
      .output(adminSerializedUnitSchema)
      .mutation(({ ctx, input }) =>
        inventoryService.createSerializedUnit(requireDb(db), requireDeps(deps), ctx, input),
      ),
    list: staffProcedure
      .meta(READ)
      .input(listSerializedUnitsInput)
      .output(listSerializedUnitsOutput)
      .query(({ ctx, input }) => inventoryService.listSerializedUnits(requireDb(db), ctx, input)),
    history: staffProcedure
      .meta(READ)
      .input(serializedUnitHistoryInput)
      .output(serializedUnitHistoryOutput)
      .query(({ ctx, input }) =>
        inventoryService.getSerializedUnitHistory(requireDb(db), ctx, input),
      ),
  });

  // WP-C13. `inventory.decant.*`: el módulo vive en modules/decant/ y se monta
  // acá porque el fraccionamiento es una transformación de inventario.
  const decant = createDecantRouter(db, deps);

  return router({ stock, lot, adjustment, serial, decant });
}

export type InventoryRouter = ReturnType<typeof createInventoryRouter>;
