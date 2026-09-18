import type { Prisma, PrismaClient } from "@joda/db";

export type Audience = "staff" | "public";

export interface TenantTxContext {
  userId: string;
  tenantId: string;
  audience: Audience;
}

export type TenantTx = Prisma.TransactionClient;

/**
 * Toda transacción de escritura de apps/api pasa por acá (docs/api-conventions.md
 * §8.1). El contexto de sesión se establece ANTES de cualquier otra consulta,
 * con el tercer parámetro de `set_config` en `true` — eso hace el valor LOCAL
 * a la transacción. Sin él, el valor sobrevive al COMMIT/ROLLBACK y queda
 * pegado a la conexión física: la siguiente petición que el pool le asigne a
 * esa misma conexión heredaría el tenant/usuario de una petición ajena, un
 * error de aislamiento silencioso y grave (AGENTS.md § Seguridad).
 *
 * El bloqueo de lotes en orden ascendente de `lot_id` (docs/api-conventions.md
 * §8.2, para cuando lo use WP-C19) va DENTRO de la función `fn` que cada
 * caso de uso pasa acá, en una sola sentencia `FOR UPDATE ... ORDER BY id` —
 * no es responsabilidad de `withTenantTx` en sí, pero es la transacción que
 * ese bloqueo necesita para ser atómico con el resto de la operación.
 */
export async function withTenantTx<T>(
  db: PrismaClient,
  ctx: TenantTxContext,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT set_config('app.user_id',   ${ctx.userId},   true),
             set_config('app.tenant_id', ${ctx.tenantId}, true),
             set_config('app.audience',  ${ctx.audience},  true)`;
    return fn(tx);
  });
}
