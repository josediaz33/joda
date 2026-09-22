import {
  adminBomComponentSchema,
  adminCategorySchema,
  adminProductSchema,
  adminTagSchema,
  adminVariantSchema,
  archiveProductInput,
  byProductIdInput,
  byVariantIdInput,
  createBomComponentInput,
  createCategoryInput,
  createProductInput,
  createTagInput,
  createVariantInput,
  listBomComponentsInput,
  listCategoriesOutput,
  listProductsInput,
  listProductsOutput,
  listTagsOutput,
  listVariantsInput,
  paginationInputSchema,
  removeBomComponentInput,
  removeBomComponentOutput,
  updateBomComponentInput,
  updateCategoryInput,
  updateProductInput,
  updateTagInput,
  updateVariantInput,
} from "@joda/contracts";
import type { PrismaClient } from "@joda/db";
import { z } from "zod";
import { appError, toTRPCError } from "../../middleware/errorMapper.js";
import { router, staffProcedure } from "../../trpc/trpc.js";
import type { RequestContext } from "../../trpc/context.js";
import type { TenantTxContext } from "../../db/withTenantTx.js";
import * as catalogService from "./service.js";

/** `db === null` solo pasa en apps/api/src/trpc/router.test.ts (WP-C01), que levanta `buildServer()` sin Postgres — mismo criterio que requireDb de trpc/exampleRouter.ts. */
function requireDb(db: PrismaClient | null): PrismaClient {
  if (db === null) {
    throw toTRPCError(
      appError("INTERNAL", 500, "El servidor no tiene la base de datos configurada."),
    );
  }
  return db;
}

/** Mismo criterio que requireStaffContext de trpc/exampleRouter.ts: todo procedimiento de catálogo necesita tenant para abrir withTenantTx. */
function requireStaffContext(ctx: RequestContext): TenantTxContext {
  if (ctx.audience === "staff" && ctx.userId && ctx.tenantId) {
    return { userId: ctx.userId, tenantId: ctx.tenantId, audience: ctx.audience };
  }
  throw toTRPCError(
    appError("UNAUTHENTICATED_SESSION_EXPIRED", 401, "Necesitás una sesión de personal."),
  );
}

const READ = { permission: "catalog.product:read" } as const;
const WRITE = { permission: "catalog.product:write" } as const;

export function createCatalogRouter(db: PrismaClient | null) {
  const product = router({
    list: staffProcedure
      .meta(READ)
      .input(listProductsInput)
      .output(listProductsOutput)
      .query(({ ctx, input }) =>
        catalogService.listProducts(requireDb(db), requireStaffContext(ctx), input),
      ),

    byId: staffProcedure
      .meta(READ)
      .input(byProductIdInput)
      .output(adminProductSchema)
      .query(({ ctx, input }) =>
        catalogService.getProductById(requireDb(db), requireStaffContext(ctx), input),
      ),

    create: staffProcedure
      .meta(WRITE)
      .input(createProductInput)
      .output(adminProductSchema)
      .mutation(({ ctx, input }) =>
        catalogService.createProduct(requireDb(db), requireStaffContext(ctx), input),
      ),

    update: staffProcedure
      .meta(WRITE)
      .input(updateProductInput)
      .output(adminProductSchema)
      .mutation(({ ctx, input }) =>
        catalogService.updateProduct(requireDb(db), requireStaffContext(ctx), input),
      ),

    archive: staffProcedure
      .meta(WRITE)
      .input(archiveProductInput)
      .output(adminProductSchema)
      .mutation(({ ctx, input }) =>
        catalogService.archiveProduct(requireDb(db), requireStaffContext(ctx), input),
      ),
  });

  const variant = router({
    list: staffProcedure
      .meta(READ)
      .input(listVariantsInput)
      .output(z.array(adminVariantSchema))
      .query(({ ctx, input }) =>
        catalogService.listVariants(requireDb(db), requireStaffContext(ctx), input),
      ),

    byId: staffProcedure
      .meta(READ)
      .input(byVariantIdInput)
      .output(adminVariantSchema)
      .query(({ ctx, input }) =>
        catalogService.getVariantById(requireDb(db), requireStaffContext(ctx), input),
      ),

    create: staffProcedure
      .meta(WRITE)
      .input(createVariantInput)
      .output(adminVariantSchema)
      .mutation(({ ctx, input }) =>
        catalogService.createVariant(requireDb(db), requireStaffContext(ctx), input),
      ),

    update: staffProcedure
      .meta(WRITE)
      .input(updateVariantInput)
      .output(adminVariantSchema)
      .mutation(({ ctx, input }) =>
        catalogService.updateVariant(requireDb(db), requireStaffContext(ctx), input),
      ),
  });

  const bom = router({
    list: staffProcedure
      .meta(READ)
      .input(listBomComponentsInput)
      .output(z.array(adminBomComponentSchema))
      .query(({ ctx, input }) =>
        catalogService.listBomComponents(requireDb(db), requireStaffContext(ctx), {
          variantId: input.variantId,
        }),
      ),

    create: staffProcedure
      .meta(WRITE)
      .input(createBomComponentInput)
      .output(adminBomComponentSchema)
      .mutation(({ ctx, input }) =>
        catalogService.createBomComponent(requireDb(db), requireStaffContext(ctx), input),
      ),

    update: staffProcedure
      .meta(WRITE)
      .input(updateBomComponentInput)
      .output(adminBomComponentSchema)
      .mutation(({ ctx, input }) =>
        catalogService.updateBomComponent(requireDb(db), requireStaffContext(ctx), input),
      ),

    remove: staffProcedure
      .meta(WRITE)
      .input(removeBomComponentInput)
      .output(removeBomComponentOutput)
      .mutation(async ({ ctx, input }) => {
        await catalogService.removeBomComponent(requireDb(db), requireStaffContext(ctx), input);
        return { ok: true as const };
      }),
  });

  const category = router({
    list: staffProcedure
      .meta(READ)
      .input(paginationInputSchema)
      .output(listCategoriesOutput)
      .query(({ ctx, input }) =>
        catalogService.listCategories(requireDb(db), requireStaffContext(ctx), input),
      ),

    create: staffProcedure
      .meta(WRITE)
      .input(createCategoryInput)
      .output(adminCategorySchema)
      .mutation(({ ctx, input }) =>
        catalogService.createCategory(requireDb(db), requireStaffContext(ctx), input),
      ),

    update: staffProcedure
      .meta(WRITE)
      .input(updateCategoryInput)
      .output(adminCategorySchema)
      .mutation(({ ctx, input }) =>
        catalogService.updateCategory(requireDb(db), requireStaffContext(ctx), input),
      ),
  });

  const tag = router({
    list: staffProcedure
      .meta(READ)
      .input(paginationInputSchema)
      .output(listTagsOutput)
      .query(({ ctx, input }) =>
        catalogService.listTags(requireDb(db), requireStaffContext(ctx), input),
      ),

    create: staffProcedure
      .meta(WRITE)
      .input(createTagInput)
      .output(adminTagSchema)
      .mutation(({ ctx, input }) =>
        catalogService.createTag(requireDb(db), requireStaffContext(ctx), input),
      ),

    update: staffProcedure
      .meta(WRITE)
      .input(updateTagInput)
      .output(adminTagSchema)
      .mutation(({ ctx, input }) =>
        catalogService.updateTag(requireDb(db), requireStaffContext(ctx), input),
      ),
  });

  return router({ product, variant, bom, category, tag });
}

export type CatalogRouter = ReturnType<typeof createCatalogRouter>;
