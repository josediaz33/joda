import type { Prisma, PrismaClient } from "@joda/db";
import { decideIdempotencyOutcome } from "@joda/domain";
import { appError, toTRPCError } from "../middleware/errorMapper.js";
import { withTenantTx, type TenantTx, type TenantTxContext } from "./withTenantTx.js";

/**
 * `(tenant_id, scope, key)` identifica la operación (docs/api-conventions.md
 * §5) — `scope` distingue de qué mecanismo viene la clave (`"api"` para
 * mutaciones de tRPC, distinto de `payment_events` de webhooks, §5.1, que ni
 * siquiera usa esta tabla). `requestHash` es lo que detecta el reuso de
 * clave con un cuerpo distinto.
 *
 * El comentario de `packages/db/migrations/0002_identity_rbac.sql` que crea
 * `idempotency_keys` la describe para "webhooks de pago, mutaciones offline
 * del admin" — quedó desactualizado frente a docs/api-conventions.md §5.1
 * (los webhooks usan `payment_events`, no esta tabla) y no se corrige acá
 * porque es una migración ya aplicada (`.claude/rules/database.md`: nunca se
 * edita una, ni siquiera un comentario). Esta tabla es para `scope: "api"`
 * (mutaciones de tRPC) y para el outbox offline del admin cuando exista
 * (docs/engineering-principles.md, "Patrón de bandeja de salida") — nunca
 * para webhooks.
 */
export interface IdempotencyRequest {
  readonly scope: string;
  readonly key: string;
  readonly requestHash: string;
}

/**
 * `result` viaja tal cual a la columna `jsonb` de `idempotency_keys`
 * (`response: result as Prisma.InputJsonValue` más abajo, sin validar en
 * runtime) — tiene que ser ya JSON-seguro cuando `fn` lo devuelve, la MISMA
 * forma que el `.output()` Zod del procedimiento espera. En particular,
 * dinero: `docs/api-conventions.md` §3 exige que los importes viajen como
 * `string` en la frontera, nunca como `number` ni como `bigint` de
 * `packages/domain` — pasar un `Money`/`bigint` sin convertir acá revienta
 * la serialización a `jsonb` (o, peor, la deja pasar y corrompe el replay).
 * Conversión que le toca al `service` que arma `result`, no a esta función.
 */
export interface IdempotentEffectResult<T> {
  readonly result: T;
  readonly statusCode: number;
}

export interface WithIdempotentTxResult<T> {
  readonly result: T;
  readonly statusCode: number;
  /** `true` si la respuesta vino de `idempotency_keys` — `fn` NO se ejecutó. */
  readonly replayed: boolean;
}

const IDEMPOTENCY_KEY_REUSE_ERROR = appError(
  "CONFLICT_IDEMPOTENCY_KEY_REUSE",
  409,
  "Ya se usó esta clave de idempotencia con un contenido distinto.",
);

/**
 * Envoltorio de `withTenantTx` (WP-C02) para mutaciones con efecto
 * irreversible (docs/api-conventions.md §5). No es un middleware global: el
 * llamador decide si pasa `idempotency` o `null` — sin clave, corre `fn` sin
 * más, exactamente como `withTenantTx` solo (trampa explícita de la Sesión
 * 26 del playbook: "no es un middleware global sobre toda mutación").
 *
 * A propósito, y a diferencia de `enforcePermissionGate` (WP-C05,
 * `trpc/trpc.ts`), NO hay ningún gate que obligue a un procedimiento nuevo a
 * llamar esto — nada falla en el arranque si un mutador irreversible se
 * escribe contra `withTenantTx` directo y se olvida de la idempotencia. Cada
 * módulo de negocio que agregue una mutación de este tipo tiene que
 * acordarse solo, con su propio WP como el lugar donde se revisa.
 *
 * El registro en `idempotency_keys` se inserta DENTRO de esta misma
 * transacción, después de que `fn` corrió: si `fn` (o el INSERT) falla, todo
 * el `$transaction` de Prisma hace rollback y la clave no queda quemada — un
 * reintento con la misma clave vuelve a encontrar "no existe" y reprocesa,
 * en vez de quedar en un estado que ni reintenta ni avanza.
 *
 * LÍMITE CONOCIDO, sin resolver acá (alcance del criterio de aceptación de
 * WP-C06: reintento SECUENCIAL, no concurrencia real): el SELECT de abajo no
 * toma ningún lock — dos requests con la misma clave, exactamente
 * simultáneas, pueden pasar las dos el `existingRow === null` antes de que
 * cualquiera confirme, y las dos ejecutar `fn`. La segunda en llegar al
 * INSERT choca contra el `UNIQUE (tenant_id, scope, key)` y recibe un
 * `23505` genérico (`CONFLICT_DUPLICATE`, `middleware/errorMapper.ts`), no
 * el `CONFLICT_IDEMPOTENCY_KEY_REUSE` con la respuesta ya guardada. Cerrarlo
 * de verdad pide serializar con `pg_advisory_xact_lock` (u otro mecanismo de
 * lock) sobre `(tenant_id, scope, key)` antes del SELECT — deliberadamente
 * no incluido acá; si un módulo real necesita esa garantía bajo concurrencia
 * real, es trabajo para ese WP.
 */
export async function withIdempotentTx<T>(
  db: PrismaClient,
  ctx: TenantTxContext,
  idempotency: IdempotencyRequest | null,
  fn: (tx: TenantTx) => Promise<IdempotentEffectResult<T>>,
): Promise<WithIdempotentTxResult<T>> {
  return withTenantTx(db, ctx, async (tx) => {
    if (idempotency === null) {
      const { result, statusCode } = await fn(tx);
      return { result, statusCode, replayed: false };
    }

    const existingRow = await tx.idempotency_keys.findUnique({
      where: {
        tenant_id_scope_key: {
          tenant_id: ctx.tenantId,
          scope: idempotency.scope,
          key: idempotency.key,
        },
      },
      select: { request_hash: true, response: true, status_code: true },
    });

    const outcome = decideIdempotencyOutcome<T>({
      existing: existingRow
        ? {
            requestHash: existingRow.request_hash,
            response: existingRow.response as T,
            statusCode: existingRow.status_code ?? 0,
          }
        : null,
      requestHash: idempotency.requestHash,
    });

    if (outcome.kind === "conflict") throw toTRPCError(IDEMPOTENCY_KEY_REUSE_ERROR);
    if (outcome.kind === "replay") {
      return { result: outcome.response, statusCode: outcome.statusCode, replayed: true };
    }

    const { result, statusCode } = await fn(tx);
    await tx.idempotency_keys.create({
      data: {
        tenant_id: ctx.tenantId,
        scope: idempotency.scope,
        key: idempotency.key,
        request_hash: idempotency.requestHash,
        response: result as Prisma.InputJsonValue,
        status_code: statusCode,
        // `completed_at` es metadata de observabilidad, no algo que
        // `decideIdempotencyOutcome` lea o decida — a diferencia de
        // `expiresAt` en modules/auth (docs/testing-strategy.md), no hace
        // falta inyectar un Clock solo para este valor.
        completed_at: new Date(),
      },
    });
    return { result, statusCode, replayed: false };
  });
}
