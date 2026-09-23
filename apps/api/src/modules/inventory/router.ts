import {
  adminMovementSchema,
  createAdjustmentInput,
  lotHistoryInput,
  lotHistoryOutput,
  stockAvailabilityInput,
  stockAvailabilitySchema,
} from "@joda/contracts";
import type { PrismaClient } from "@joda/db";
import { appError, toTRPCError } from "../../middleware/errorMapper.js";
import { router, staffProcedure } from "../../trpc/trpc.js";
import * as inventoryService from "./service.js";

/** `db === null` solo pasa en apps/api/src/trpc/router.test.ts (WP-C01), mismo criterio que requireDb de modules/catalog/router.ts. */
function requireDb(db: PrismaClient | null): PrismaClient {
  if (db === null) {
    throw toTRPCError(
      appError("INTERNAL", 500, "El servidor no tiene la base de datos configurada."),
    );
  }
  return db;
}

const READ = { permission: "inventory.stock:read" } as const;
const ADJUST = { permission: "inventory.stock:adjust" } as const;

export function createInventoryRouter(db: PrismaClient | null) {
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
  });

  const adjustment = router({
    create: staffProcedure
      .meta(ADJUST)
      .input(createAdjustmentInput)
      .output(adminMovementSchema)
      .mutation(({ ctx, input }) => inventoryService.createAdjustment(requireDb(db), ctx, input)),
  });

  return router({ stock, lot, adjustment });
}

export type InventoryRouter = ReturnType<typeof createInventoryRouter>;
