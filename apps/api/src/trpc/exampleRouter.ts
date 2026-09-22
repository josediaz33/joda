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
import type { PrismaClient } from "@joda/db";
import { z } from "zod";
import { withIdempotentTx } from "../db/withIdempotentTx.js";
import { appError, toTRPCError } from "../middleware/errorMapper.js";
import { buildIdempotencyRequest } from "../middleware/idempotency.js";
import type { RequestContext } from "./context.js";
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

/**
 * `db === null` solo pasa en apps/api/src/trpc/router.test.ts (WP-C01), que
 * levanta `buildServer()` sin Postgres — mismo criterio que `requireDeps` de
 * modules/auth/router.ts.
 */
function requireDb(db: PrismaClient | null): PrismaClient {
  if (db === null) {
    throw toTRPCError(
      appError("INTERNAL", 500, "El servidor no tiene la base de datos configurada."),
    );
  }
  return db;
}

/** Mismo criterio que `requireActiveSession` de modules/auth/router.ts: `permissionExempt` no exige sesión, pero este procedimiento sí la necesita para tener un tenant sobre el que abrir `withIdempotentTx`. */
function requireStaffContext(ctx: RequestContext): {
  readonly userId: string;
  readonly tenantId: string;
  readonly audience: "staff";
} {
  if (ctx.audience === "staff" && ctx.userId && ctx.tenantId) {
    return { userId: ctx.userId, tenantId: ctx.tenantId, audience: ctx.audience };
  }
  throw toTRPCError(
    appError("UNAUTHENTICATED_SESSION_EXPIRED", 401, "Necesitás una sesión de personal."),
  );
}

export function createExampleRouter(db: PrismaClient | null) {
  // Contador en memoria, uno por instancia de router — solo para que
  // idempotency.integration.test.ts (WP-C06) pueda observar, vía
  // example.ping.effectCount, cuántas veces corrió de verdad el efecto de
  // example.ping.irreversibleEffect. No es un patrón para módulos de
  // negocio reales: ahí el efecto verificable es la fila que quedó en la
  // base, no un contador de proceso.
  let effectCount = 0;

  return router({
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

      // Solo para idempotency.integration.test.ts (WP-C06): un procedimiento
      // con un efecto real y verificable (effectCount) que envuelve su
      // escritura en withIdempotentTx, para probar el middleware de
      // idempotencia de punta a punta (HTTP → tRPC → withIdempotentTx →
      // idempotency_keys) sin depender de que exista un módulo de negocio de
      // verdad — mismo criterio que requiresPermission usó para WP-C05.
      irreversibleEffect: staffProcedure
        .meta({ permissionExempt: true })
        .input(z.object({ label: z.string() }).strict())
        .output(z.object({ id: z.string(), label: z.string() }).strict())
        .mutation(async ({ ctx, input }) => {
          const session = requireStaffContext(ctx);
          const idempotency = buildIdempotencyRequest(ctx.req, input);

          const { result } = await withIdempotentTx(
            requireDb(db),
            session,
            idempotency,
            async () => {
              effectCount += 1;
              return { result: { id: String(effectCount), label: input.label }, statusCode: 200 };
            },
          );

          return result;
        }),

      // Lectura del contador de arriba — el único canal por el que el test
      // HTTP (que no tiene acceso directo al closure de createExampleRouter)
      // puede confirmar cuántas veces corrió de verdad el efecto.
      effectCount: staffProcedure
        .meta({ permissionExempt: true })
        .output(z.object({ count: z.number() }).strict())
        .query(() => ({ count: effectCount })),
    }),
  });
}

export type ExampleRouter = ReturnType<typeof createExampleRouter>;
