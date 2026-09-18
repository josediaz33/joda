// Punto de entrada público de @joda/db (WP-C02): "el SQL es la fuente de
// verdad, Prisma es el cliente tipado" (packages/db/README.md). Este es el
// único archivo de packages/db pensado para importarse desde otro paquete —
// apps/api lo consume así en vez de generar su propio cliente Prisma, para
// que la generación (pnpm db:pull) siga teniendo un solo dueño.
import { PrismaClient } from "@prisma/client";

export { PrismaClient } from "@prisma/client";
export type { Prisma } from "@prisma/client";

/**
 * Crea el PrismaClient de runtime. `databaseUrl` es la única fuente de la
 * cadena de conexión — nunca lee `process.env` acá adentro, para que quien
 * llame (apps/api) sea explícito sobre qué credencial está usando y con qué
 * validación previa (docs/security-spec.md §3.1: nunca `service_role` ni el
 * owner de las tablas en runtime).
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: databaseUrl });
}
