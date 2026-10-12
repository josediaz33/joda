import {
  createSaleOrderInput,
  listSaleOrdersInput,
  listSaleOrdersOutput,
  removeSaleOrderOutput,
  saleOrderByIdInput,
  saleOrderSchema,
  transitionSaleOrderInput,
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

/** Igual que `requireDb`: las dependencias son `null` solo cuando no hay `authDeps` (router.test.ts). */
function requireDeps(deps: service.SalesServiceDeps | null): service.SalesServiceDeps {
  if (deps === null) {
    throw toTRPCError(appError("INTERNAL", 500, "El servidor no tiene el reloj configurado."));
  }
  return deps;
}

function staff(ctx: RequestContext): service.SalesContext {
  if (ctx.audience === "staff" && ctx.userId && ctx.tenantId && ctx.sessionId)
    return {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      audience: "staff",
      sessionId: ctx.sessionId,
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

// El permiso de escritura es el que la política de DELETE de `sale_orders`
// (0034) y el mapeo de WP-B11 piden: si alguien lo cambia acá sin cambiar la
// política, el endpoint y la base dejan de coincidir.
const READ = { permission: "sales.order:read" } as const;
const WRITE = { permission: "sales.order:write" } as const;

export function createSalesRouter(db: PrismaClient | null, deps: service.SalesServiceDeps | null) {
  return router({
    order: router({
      list: staffProcedure
        .meta(READ)
        .input(listSaleOrdersInput)
        .output(listSaleOrdersOutput)
        .query(({ ctx, input }) => service.listOrders(requireDb(db), staff(ctx), input)),
      byId: staffProcedure
        .meta(READ)
        .input(saleOrderByIdInput)
        .output(saleOrderSchema)
        .query(({ ctx, input }) => service.getOrder(requireDb(db), staff(ctx), input.id)),
      create: staffProcedure
        .meta(WRITE)
        .input(createSaleOrderInput)
        .output(saleOrderSchema)
        .mutation(({ ctx, input }) =>
          service.createOrder(requireDb(db), staff(ctx), input, requireDeps(deps)),
        ),
      remove: staffProcedure
        .meta(WRITE)
        .input(saleOrderByIdInput)
        .output(removeSaleOrderOutput)
        .mutation(async ({ ctx, input }) => {
          await service.removeOrder(requireDb(db), staff(ctx), input.id);
          return { ok: true as const };
        }),
      transition: staffProcedure
        .meta(WRITE)
        .input(transitionSaleOrderInput)
        .output(saleOrderSchema)
        .mutation(({ ctx, input }) =>
          service.transitionOrder(requireDb(db), staff(ctx), input, requireDeps(deps)),
        ),
    }),
  });
}
