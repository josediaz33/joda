import type { Clock } from "@joda/domain";
import type { PrismaClient } from "@joda/db";
import { recordAuditEntry } from "../db/audit.js";
import { withTenantTx } from "../db/withTenantTx.js";
import * as reservations from "../modules/reservations/repository.js";

// Job de liberación de reservas vencidas (WP-C18b; RN-RES-04, ADR-019;
// decisión de José del 2026-10-29). Una reserva vencida deja de contar en el
// disponible apenas pasa su `expires_at` (`v_stock_available` mira la fecha), así
// que este trabajo es contabilidad: marca `released_at` para que la fila deje de
// figurar como pendiente, libere la unidad serializada que ocupaba (el índice
// único de 0041 cuenta las SIN LIBERAR) y quede dicho cuándo se soltó.
//
// **Con qué credencial corre.** Como `joda_api`, NUNCA con `service_role`: con
// una credencial que elude RLS el aislamiento por tenant deja de existir. Un
// `joda_api` ve un solo tenant por transacción, así que el trabajo:
//
//   1. pide los tenants a descubrir con una función `SECURITY DEFINER` que
//      devuelve SOLO ids (`app.tenants_with_expired_reservations`, 0041):
//      los que tienen al menos una reserva vencida sin liberar. Se llama SIN
//      tenant en el contexto: la función rechaza dentro del de uno;
//   2. por cada id abre una transacción con el contexto de ESE tenant y audiencia
//      `system` (`withTenantTx`, con el `true` final de `set_config`: el valor es
//      local a la transacción y no se filtra por el pool) y libera BAJO RLS.
//      La política de UPDATE le permite a `system` una sola cosa: un UPDATE de
//      una reserva sin liberar que queda liberada (no limita qué otras columnas
//      cambia: este job solo escribe `released_at`; WP-B21).
//
// Una corrida que falla en un tenant no frena a los demás: se anota y sigue. El
// error de un tenant no es una razón para que otro conserve reservas vencidas.

export interface ReleaseExpiredReservationsDeps {
  readonly db: PrismaClient;
  readonly clock: Clock;
  readonly logger?: {
    error(details: Record<string, unknown>, message: string): void;
  };
}

export interface ReleaseExpiredReservationsResult {
  /** Los tenants con reservas vencidas que la función devolvió. */
  readonly tenants: number;
  /** Cuántas reservas se liberaron en total. */
  readonly released: number;
  /** Los tenants cuya transacción falló: se reintentan en la corrida siguiente. */
  readonly failedTenantIds: readonly string[];
}

/** Los tenants con reservas vencidas, vía la función `SECURITY DEFINER`. Sin tenant en el contexto: la función lo exige. */
async function listTenantsWithExpiredReservations(db: PrismaClient, asOf: Date): Promise<string[]> {
  const rows = await db.$queryRaw<{ tenant_id: string }[]>`
    SELECT f::text AS tenant_id
      FROM app.tenants_with_expired_reservations(${asOf.toISOString()}::timestamptz) AS f`;
  return rows.map((row) => row.tenant_id);
}

export async function releaseExpiredReservations(
  deps: ReleaseExpiredReservationsDeps,
): Promise<ReleaseExpiredReservationsResult> {
  const { db, clock, logger } = deps;
  const now = clock.now();
  const tenantIds = await listTenantsWithExpiredReservations(db, now);

  let released = 0;
  const failedTenantIds: string[] = [];
  for (const tenantId of tenantIds) {
    try {
      released += await withTenantTx(
        db,
        // Sin usuario ni sesión: es el sistema, no una persona. `withTenantTx` es
        // quien fija el contexto, y lo hace con `set_config(..., true)`.
        { userId: "", tenantId, audience: "system", sessionId: null },
        async (tx) => {
          const releasedRows = await reservations.releaseAllExpired(tx, tenantId, now);
          if (releasedRows.length > 0) {
            await recordAuditEntry(tx, {
              tenantId,
              actorId: null,
              audience: "system",
              action: "sales.reservation.release_expired",
              entity: "stock_reservations",
              entityId: null,
              before: null,
              after: {
                released: releasedRows.length,
                asOf: now.toISOString(),
                reservationIds: releasedRows.map((row) => row.id),
              },
              ip: null,
              userAgent: null,
              requestId: null,
            });
          }
          return releasedRows.length;
        },
      );
    } catch (error) {
      failedTenantIds.push(tenantId);
      logger?.error({ tenantId, error }, "no se pudieron liberar las reservas vencidas del tenant");
    }
  }

  return { tenants: tenantIds.length, released, failedTenantIds };
}
