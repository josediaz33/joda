import {
  approvePurchaseOrderInput,
  createPurchaseOrderInput,
  createSupplierInput,
  listPurchaseOrdersInput,
  listPurchaseOrdersOutput,
  listSuppliersInput,
  listSuppliersOutput,
  purchaseOrderByIdInput,
  purchaseOrderSchema,
  supplierByIdInput,
  supplierSchema,
  transitionPurchaseOrderInput,
  updateSupplierInput,
} from "@joda/contracts";
import type { PrismaClient } from "@joda/db";
import { appError, toTRPCError } from "../../middleware/errorMapper.js";
import { router, staffProcedure } from "../../trpc/trpc.js";
import type { RequestContext } from "../../trpc/context.js";
import * as service from "./service.js";

function requireDb(db: PrismaClient | null): PrismaClient {
  if (!db)
    throw toTRPCError(
      appError("INTERNAL", 500, "El servidor no tiene la base de datos configurada."),
    );
  return db;
}
function staff(ctx: RequestContext): service.MarketContext {
  if (ctx.audience === "staff" && ctx.userId && ctx.tenantId)
    return {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      audience: "staff",
      auditMeta: {
        ip: ctx.req.ip,
        userAgent: ctx.req.headers["user-agent"] ?? null,
        requestId: ctx.requestId,
      },
    };
  throw toTRPCError(
    appError("UNAUTHENTICATED_SESSION_EXPIRED", 401, "Necesitás una sesión de personal."),
  );
}

export function createMarketRouter(db: PrismaClient | null) {
  return router({
    supplier: router({
      list: staffProcedure
        .meta({ permission: "market.supplier:read" })
        .input(listSuppliersInput)
        .output(listSuppliersOutput)
        .query(({ ctx, input }) => service.listSuppliers(requireDb(db), staff(ctx), input)),
      byId: staffProcedure
        .meta({ permission: "market.supplier:read" })
        .input(supplierByIdInput)
        .output(supplierSchema)
        .query(({ ctx, input }) => service.getSupplier(requireDb(db), staff(ctx), input.id)),
      create: staffProcedure
        .meta({ permission: "market.supplier:write" })
        .input(createSupplierInput)
        .output(supplierSchema)
        .mutation(({ ctx, input }) => service.createSupplier(requireDb(db), staff(ctx), input)),
      update: staffProcedure
        .meta({ permission: "market.supplier:write" })
        .input(updateSupplierInput)
        .output(supplierSchema)
        .mutation(({ ctx, input }) => service.updateSupplier(requireDb(db), staff(ctx), input)),
    }),
    purchaseOrder: router({
      list: staffProcedure
        .meta({ permission: "market.purchase_order:read" })
        .input(listPurchaseOrdersInput)
        .output(listPurchaseOrdersOutput)
        .query(({ ctx, input }) => service.listOrders(requireDb(db), staff(ctx), input)),
      byId: staffProcedure
        .meta({ permission: "market.purchase_order:read" })
        .input(purchaseOrderByIdInput)
        .output(purchaseOrderSchema)
        .query(({ ctx, input }) => service.getOrder(requireDb(db), staff(ctx), input.id)),
      create: staffProcedure
        .meta({ permission: "market.purchase_order:write" })
        .input(createPurchaseOrderInput)
        .output(purchaseOrderSchema)
        .mutation(({ ctx, input }) => service.createOrder(requireDb(db), staff(ctx), input)),
      transition: staffProcedure
        .meta({ permission: "market.purchase_order:write" })
        .input(transitionPurchaseOrderInput)
        .output(purchaseOrderSchema)
        .mutation(({ ctx, input }) => service.transitionOrder(requireDb(db), staff(ctx), input)),
      approve: staffProcedure
        .meta({ permission: "market.purchase_order:approve" })
        .input(approvePurchaseOrderInput)
        .output(purchaseOrderSchema)
        .mutation(({ ctx, input }) =>
          service.transitionOrder(
            requireDb(db),
            staff(ctx),
            { ...input, toStatus: "approved" },
            "market.purchaseOrder.approve",
          ),
        ),
    }),
  });
}
