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
 */
export interface IdempotencyRequest {
  readonly scope: string;
  readonly key: string;
  readonly requestHash: string;
}

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
 * El registro en `idempotency_keys` se inserta DENTRO de esta misma
 * transacción, después de que `fn` corrió: si `fn` (o el INSERT) falla, todo
 * el `$transaction` de Prisma hace rollback y la clave no queda quemada — un
 * reintento con la misma clave vuelve a encontrar "no existe" y reprocesa,
 * en vez de quedar en un estado que ni reintenta ni avanza.
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
