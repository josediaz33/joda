// Procedimiento de ejemplo del esqueleto (WP-C01): prueba que un
// procedimiento tipado de punta a punta responde a través de Fastify de
// verdad, usando la instancia de tRPC con contexto de apps/api (trpc.ts) —
// no la de packages/contracts/src/example/ping.ts (WP-A11), que no tiene
// contexto y nunca se montó en un servidor real. Reusa los esquemas de
// packages/contracts porque esos sí son la fuente de verdad de tipos
// (AGENTS.md § Documentación).
import {
  idSchema,
  moneySchema,
  paginatedOutputSchema,
  paginationInputSchema,
} from "@joda/contracts";
import { z } from "zod";
import { router, staffProcedure } from "./trpc.js";

export const pingItemSchema = z
  .object({
    id: idSchema,
    label: z.string(),
    price: moneySchema,
  })
  .strict();

const PING_ITEM = {
  id: "0f3b6b2a-2e0e-4c1d-9c1a-2c9a9a9a9a9a",
  label: "ping",
  price: { minor: "245000", currency: "PYG" as const },
};

export const exampleRouter = router({
  ping: router({
    // `permissionExempt`: scaffolding de transporte (WP-C01), no una acción
    // de negocio real — no hay un permiso del catálogo que tenga sentido
    // exigirle. mfa.integration.test.ts (WP-C04) lo usa como "cualquier
    // procedimiento de negocio" para probar que el gate de MFA es
    // estructural, con una sesión ya autenticada y sin ningún rol asignado
    // — tiene que seguir respondiendo 200 una vez satisfecho el segundo
    // factor, no empezar a devolver 404 por falta de permiso.
    list: staffProcedure
      .meta({ permissionExempt: true })
      .input(paginationInputSchema)
      .output(paginatedOutputSchema(pingItemSchema))
      .query(({ input }) => ({
        items: input.cursor ? [] : [PING_ITEM],
        nextCursor: null,
      })),

    // Solo para el test de integración del mapeador de errores
    // (router.test.ts): tira un error con la forma exacta que produce el
    // ERRCODE de un CHECK de Postgres real (23514) — no lo traduce acá, deja
    // que lo atrape el middleware `catchPgErrors` de trpc.ts, que es lo que
    // hay que probar. Una conexión real a Postgres llega recién con WP-C02;
    // esto prueba el circuito completo Fastify → tRPC → middleware →
    // errorFormatter sin necesitarla. No se monta ninguna lógica de negocio
    // acá.
    failWithCheckViolation: staffProcedure.meta({ permissionExempt: true }).mutation(() => {
      throw Object.assign(new Error('new row for relation "x" violates check constraint'), {
        code: "23514",
      });
    }),

    // Solo para el test de integración del mapeador de errores
    // (router.test.ts): un bug real, no un error de Postgres — prueba que el
    // `errorFormatter` de trpc.ts enmascara CUALQUIER error no traducido con
    // un mensaje genérico en español, no solo los que reconoce PG_ERROR_MAP
    // (docs/api-conventions.md §4.4, "ni siquiera traducido a medias").
    failWithBug: staffProcedure.meta({ permissionExempt: true }).mutation(() => {
      throw new Error("detalle interno que no debe llegar al cliente");
    }),

    // Solo para el test de integración del middleware de permisos (WP-C05,
    // apps/api/src/modules/auth/permission.integration.test.ts): un
    // procedimiento cualquiera con `meta.permission` real, para poder probar
    // granted/403/404 sin depender de que ya exista un módulo de negocio de
    // verdad (bloque C, todavía casi todo pendiente en docs/backlog.md).
    requiresPermission: staffProcedure
      .meta({ permission: "catalog.product:read" })
      .output(z.object({ ok: z.literal(true) }).strict())
      .query(() => ({ ok: true as const })),
  }),
});

export type ExampleRouter = typeof exampleRouter;
