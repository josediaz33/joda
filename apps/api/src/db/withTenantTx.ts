import type { Prisma, PrismaClient } from "@joda/db";
import type { Audience } from "../trpc/context.js";

export interface TenantTxContext {
  userId: string;
  tenantId: string;
  audience: Audience;
  /**
   * La fila de `staff_sessions` que respalda este contexto (WP-B13). Sin
   * ella, `app.has_permission()` responde `false` aunque `userId` tenga el
   * rol: un error que fije el `userId` equivocado ya no alcanza, también
   * tendría que nombrar una sesión viva de ese usuario en este tenant. `null`
   * solo donde todavía no hay sesión que nombrar (login, que la crea dentro
   * de la misma transacción): ahí no se concede ningún permiso por RLS.
   */
  sessionId: string | null;
}

export type TenantTx = Prisma.TransactionClient;

/**
 * Toda transacción de ESCRITURA de apps/api pasa por acá (docs/api-conventions.md
 * §8.1). El contexto de sesión se establece ANTES de cualquier otra consulta,
 * con el tercer parámetro de `set_config` en `true` — eso hace el valor LOCAL
 * a la transacción. Sin él, el valor sobrevive al COMMIT/ROLLBACK y queda
 * pegado a la conexión física: la siguiente petición que el pool le asigne a
 * esa misma conexión heredaría el tenant/usuario de una petición ajena, un
 * error de aislamiento silencioso y grave (AGENTS.md § Seguridad).
 *
 * **También la usan lecturas** que necesitan que RLS evalúe con el tenant
 * correcto (`modules/auth/repository.ts::getGrantedPermissionCodes`, WP-C05;
 * todo `list`/`byId` de `modules/catalog/service.ts`, WP-C08) — no es una
 * desviación de §8.3 ("no abras una transacción para leer"): esa regla habla
 * de no abrir una transacción SEPARADA solo para leer antes de una escritura
 * de la misma operación de negocio, no de que una consulta no pueda ir
 * envuelta en transacción. `set_config(..., true)` exige una transacción para
 * que el valor sea local a ella (ver el párrafo de arriba) — hoy no existe en
 * este código un mecanismo de "contexto de sesión sin transacción completa"
 * más liviano, así que toda consulta que dependa de RLS pasa por acá aunque
 * no escriba nada. Si ese costo alguna vez importa, la alternativa es una
 * sesión de Postgres dedicada por request en vez de un pool compartido — un
 * cambio de arquitectura que ningún WP pidió todavía.
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
             set_config('app.audience',  ${ctx.audience},  true),
             set_config('app.session_id', ${ctx.sessionId ?? ""}, true)`;
    return fn(tx);
  });
}
