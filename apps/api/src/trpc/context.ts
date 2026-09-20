import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { readStaffSessionCookie } from "../modules/auth/cookie.js";
import { resolveRequestSession, type AuthServiceDeps } from "../modules/auth/service.js";

// GLOSARIO.md "Audiencia (audience)" y el enum real de Postgres
// (packages/db/migrations/0001_foundation.sql, `actor_audience`) — no
// "public": ese nombre es el de `publicProcedure` (docs/api-conventions.md
// §9, un tipo de procedimiento tRPC), un concepto distinto de qué actor
// corre la transacción. `app.current_audience()` hace `::actor_audience`
// sobre este valor (vía `withTenantTx`, WP-C02) — un valor fuera del enum
// no falla al compilar, falla en Postgres en tiempo de ejecución.
export type Audience = "staff" | "customer" | "system";

// El contexto de petición (docs/api-conventions.md §1, §8.1, §9).
//
// - `requestId` lo genera Fastify por petición (`req.id`, WP-C01).
// - `userId`/`tenantId`/`audience`/`sessionId` salen de la cookie de
//   personal `__Host-joda_a` (WP-C03, docs/security-spec.md §4) — nunca de
//   un header sin verificar: `resolveRequestSession`
//   (modules/auth/service.ts) es quien valida la firma de la cookie y, si
//   hace falta, el token de refresco contra Postgres. Sin cookie válida,
//   los cuatro quedan en `null`: la audiencia "customer" (clientes,
//   ADR-015) todavía no tiene sesión propia — llega con otro WP, fuera del
//   bloque C de personal.
// - `req`/`res` son la petición/respuesta cruda de Fastify: auth.session.*
//   (modules/auth/router.ts) los necesita para leer y escribir la cookie.
//   Ningún caso de uso de negocio debería necesitar tocarlos — reciben
//   userId/tenantId/audience ya resueltos.
export interface RequestContext {
  requestId: string;
  userId: string | null;
  tenantId: string | null;
  audience: Audience | null;
  sessionId: string | null;
  req: FastifyRequest;
  res: FastifyReply;
}

/**
 * Factory en vez de una función suelta: `createContext` necesita el cliente
 * de Postgres, el de Redis y el reloj para resolver la sesión, y
 * `fastifyTRPCPlugin` solo acepta `(opts) => context`, no un cuarto
 * parámetro. `deps: null` (usado por apps/api/src/trpc/router.test.ts, que
 * no levanta Postgres ni Redis) resuelve todo request como no autenticado,
 * sin tocar ninguno de los dos — ningún procedimiento que no sea de
 * auth.session.* lo necesita para existir.
 */
export function buildCreateContext(deps: AuthServiceDeps | null) {
  return async function createContext({
    req,
    res,
  }: CreateFastifyContextOptions): Promise<RequestContext> {
    const base: RequestContext = {
      requestId: req.id,
      userId: null,
      tenantId: null,
      audience: null,
      sessionId: null,
      req,
      res,
    };

    if (deps === null) return base;

    const cookie = readStaffSessionCookie(req);
    if (!cookie) return base;

    const session = await resolveRequestSession(deps, cookie);
    if (!session) return base;

    return {
      ...base,
      userId: session.userId,
      tenantId: session.tenantId,
      audience: session.audience,
      sessionId: session.sessionId,
    };
  };
}
