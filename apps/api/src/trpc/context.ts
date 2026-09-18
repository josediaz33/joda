import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";

export type Audience = "staff" | "public";

// El contexto de petición (docs/api-conventions.md §1, §8.1, §9): de dónde
// sale cada campo cambia con el bloque C, esta sesión (WP-C01) solo arma la
// forma.
//
// - `requestId` es real desde ahora: lo genera Fastify por petición (`req.id`,
//   `logger: true` en index.ts ya lo agrega a cada línea de log) y sirve para
//   correlacionar un error con su log sin exponer nada del cliente.
// - `userId`/`tenantId`/`audience` todavía no tienen de dónde salir: no hay
//   sesión de personal (WP-C03) ni segundo factor (WP-C04) todavía. Quedan en
//   `null` a propósito — inventar una lectura de header/cookie acá sería
//   confiar en un dato que el cliente puede falsificar, exactamente lo que
//   `set_config` (WP-C02) y la sesión de personal (WP-C03) existen para
//   evitar. `withTenantTx` (WP-C02) es quien primero necesita que estos
//   campos dejen de ser `null`.
export interface RequestContext {
  requestId: string;
  userId: string | null;
  tenantId: string | null;
  audience: Audience | null;
}

export function createContext({ req }: CreateFastifyContextOptions): RequestContext {
  return {
    requestId: req.id,
    userId: null,
    tenantId: null,
    audience: null,
  };
}
