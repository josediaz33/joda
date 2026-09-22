import type { Prisma } from "@joda/db";
import type { Audience } from "../trpc/context.js";
import type { TenantTx } from "./withTenantTx.js";

/**
 * Campos fijos (docs/api-conventions.md §10, docs/security-spec.md §7) —
 * ningún módulo agrega ni quita uno por conveniencia propia. `action` usa el
 * MISMO nombre que el procedimiento tRPC que la originó ("sales.order.confirm",
 * nunca una descripción libre): es lo que permite cruzar `audit_log` con
 * métricas de uso más adelante. `before`/`after` tienen que llegar ya
 * JSON-seguros — igual que `result` en withIdempotentTx.ts, sin ningún
 * `Money`/`bigint` de packages/domain sin convertir a `string` antes de acá.
 */
export interface AuditEntry {
  readonly tenantId: string;
  readonly actorId: string | null;
  readonly audience: Audience;
  readonly action: string;
  readonly entity: string;
  readonly entityId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

/**
 * Escribe en `audit_log` (docs/security-spec.md §7: append-only e inmutable
 * — `joda_api` no tiene UPDATE/DELETE sobre ella desde
 * packages/db/migrations/0010_security_rls.sql, ni siquiera para corregir un
 * error propio). SIEMPRE con el `tx` de la transacción que produce el efecto
 * auditado — nunca en un paso aparte que pueda quedar desincronizado si el
 * resto de la transacción hace rollback: cada módulo (inventario,
 * contabilidad, compras, precios, permisos, configuración fiscal) la llama
 * desde dentro de su propio `withTenantTx`.
 *
 * `before`/`after` son `Json?` en el esquema: pasarles un `null` de JS tal
 * cual no compila (Prisma exige el centinela `Prisma.DbNull`/`Prisma.JsonNull`
 * para un campo Json, porque ahí un `null` es ambiguo entre "sin valor" y el
 * literal JSON `null` — y `@joda/db` no reexporta esos centinelas en tiempo
 * de ejecución). Acá "sin estado antes/después" siempre quiere decir SQL
 * NULL (docs/api-conventions.md §10, el `before: null` del ejemplo), así que
 * directamente se omite la clave cuando el valor es `null`: la columna no
 * tiene DEFAULT, así que Postgres la deja NULL igual.
 */
export async function recordAuditEntry(tx: TenantTx, entry: AuditEntry): Promise<void> {
  await tx.audit_log.create({
    data: {
      tenant_id: entry.tenantId,
      actor_id: entry.actorId,
      audience: entry.audience,
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entityId,
      ...(entry.before !== null && { before: entry.before as Prisma.InputJsonValue }),
      ...(entry.after !== null && { after: entry.after as Prisma.InputJsonValue }),
      ip: entry.ip,
      user_agent: entry.userAgent,
      request_id: entry.requestId,
    },
  });
}
