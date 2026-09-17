// Procedimiento de ejemplo — criterio de aceptación de WP-A11: probar que
// "Zod en packages/contracts + tRPC" compila tipado extremo a extremo. NO
// es el router real de la API: apps/api arma su propia instancia de tRPC
// con contexto (usuario, tenant, transacción) recién en WP-C01, ver
// docs/api-conventions.md §1 y §9. Por eso no se exporta desde
// src/index.ts — es prueba de patrón, no superficie pública del paquete.
import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { idSchema } from "../shared/id.js";
import { moneySchema } from "../shared/money.js";
import { paginatedOutputSchema, paginationInputSchema } from "../shared/pagination.js";

const t = initTRPC.create();

export const pingItemSchema = z
  .object({
    id: idSchema,
    label: z.string(),
    price: moneySchema,
  })
  .strict();

export type PingItem = z.infer<typeof pingItemSchema>;

const PING_ITEM: PingItem = {
  id: "0f3b6b2a-2e0e-4c1d-9c1a-2c9a9a9a9a9a",
  label: "ping",
  price: { minor: "245000", currency: "PYG" },
};

export const exampleRouter = t.router({
  ping: t.router({
    list: t.procedure
      .input(paginationInputSchema)
      .output(paginatedOutputSchema(pingItemSchema))
      .query(({ input }) => ({
        items: input.cursor ? [] : [PING_ITEM],
        nextCursor: null,
      })),
  }),
});

export type ExampleRouter = typeof exampleRouter;

export const createExampleCaller = t.createCallerFactory(exampleRouter);
