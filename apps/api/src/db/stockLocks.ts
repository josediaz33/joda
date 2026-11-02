import type { TenantTx } from "./withTenantTx.js";

// Orden de bloqueo ÚNICO de todo el sistema (docs/domain-rules.md RN-RES-07,
// decisión de José del 2026-10-29; complementa a RN-LOT-05 y ADR-019):
//
//   1. la fila de `product_variants` de cada variante involucrada, por `id`
//      ascendente, en UNA sentencia;
//   2. después los lotes involucrados, por `id` ascendente, en UNA sentencia.
//
// Antes de las filas de stock van las de la entidad que el caso de uso decide
// (el pedido, la orden de fraccionamiento): `lockOrder` y
// `findWorkOrderForUpdate` toman la suya primero y nunca después de una
// variante. Todo camino que decide sobre stock —reservar, cancelar un pedido
// con reservas, abrir un frasco, ajustar, dar de alta una unidad, planificar o
// ejecutar un decant, confirmar una venta (WP-C19), apagar `is_serialized`— pasa
// por acá. Quien no lee lotes (el vendedor que confirma una venta) no puede
// bloquearlos desde la API —un `FOR UPDATE` bajo RLS solo toma las filas que la
// política deja ver—: los lotes que consume los bloquea
// `app.list_sale_allocation_lots` (0042), después de las variantes. Un camino que
// bloquee lotes sin tomar antes la variante se interbloquea contra uno que sí
// lo hizo; por eso no se migra uno solo ni se agrega uno con otro orden.
//
// TODAS LAS VARIANTES EN LA PRIMERA LLAMADA. Una variante pedida en una segunda
// llamada, con otras ya tomadas, rompe el orden ascendente: puede tener un `id`
// menor que una que ya se tiene. Si el camino después suelta reservas
// (`releaseReservationsOf`, que vuelve a pedir las suyas: inocuo si ya las
// tiene), las variantes de esas reservas entran en la primera llamada, no en la
// de la liberación: la ejecución de un decant suma a las del BOM de hoy las de
// lo que la orden reservó al planificar.
//
// POR QUÉ LA VARIANTE. El disponible (RN-RES-03) se lee por variante. Sin
// bloquearla, dos operaciones sobre lotes distintos de la misma variante leen
// el mismo disponible y comprometen el último frasco las dos.
//
// LA TRAMPA DEL `FOR UPDATE` SOBRE LA VARIANTE. La comprobación de una FK toma
// `FOR KEY SHARE` sobre la fila que referencia, y `FOR UPDATE` choca con él:
// un `INSERT` de un movimiento, un lote, una unidad, una línea de venta o una
// reserva ESPERA a quien tiene la variante. Dos consecuencias:
//   · todo camino que inserte un movimiento tiene que haber tomado la variante
//     antes (lo hace, por este helper);
//   · un camino que inserte filas de varias variantes en una sentencia toma los
//     `KEY SHARE` en el orden de sus filas, y contra un `FOR UPDATE` ascendente
//     puede interbloquearse. `shareLockVariantsAscending` los toma antes, en el
//     mismo orden; `sales.order.create` lo usa. Quedan otros inserts
//     multi-variante sin protección (líneas de órdenes de compra, escenarios de
//     sourcing, BOM): WP-C18c.
// Con `FOR NO KEY UPDATE` la exclusión entre quienes deciden sobre stock es la
// misma y nada de esto ocurre: la decisión de José es `FOR UPDATE`; el cambio
// a la otra es esta constante (y se propone en el PR de WP-C18b).

export type RowLockMode = "FOR UPDATE" | "FOR NO KEY UPDATE";

/** El modo con el que se bloquea la fila de la variante (RN-RES-07). Un solo lugar. */
export const VARIANT_LOCK_MODE: RowLockMode = "FOR UPDATE";
/** El modo con el que se bloquean los lotes (RN-LOT-05, ADR-019). Un solo lugar. */
export const LOT_LOCK_MODE: RowLockMode = "FOR UPDATE";

type IdRow = { id: string };

// Prisma no expone `FOR UPDATE` y `Prisma.raw` no se exporta desde @joda/db, así
// que el modo se elige entre dos sentencias literales. `::uuid[]` explícito
// porque Prisma manda el arreglo como `text[]`. El `ORDER BY` y la sentencia
// única son el contrato: no los "limpies".
const LOCK_VARIANTS: Record<
  RowLockMode,
  (tx: TenantTx, tenantId: string, ids: string[]) => Promise<IdRow[]>
> = {
  "FOR UPDATE": (tx, tenantId, ids) => tx.$queryRaw<IdRow[]>`
    SELECT v.id FROM app.product_variants v
     WHERE v.id = ANY(${ids}::uuid[]) AND v.tenant_id = ${tenantId}::uuid
     ORDER BY v.id
       FOR UPDATE OF v`,
  "FOR NO KEY UPDATE": (tx, tenantId, ids) => tx.$queryRaw<IdRow[]>`
    SELECT v.id FROM app.product_variants v
     WHERE v.id = ANY(${ids}::uuid[]) AND v.tenant_id = ${tenantId}::uuid
     ORDER BY v.id
       FOR NO KEY UPDATE OF v`,
};

const LOCK_LOTS: Record<
  RowLockMode,
  (
    tx: TenantTx,
    tenantId: string,
    lotIds: string[],
    variantIdsOfAllLots: string[],
  ) => Promise<IdRow[]>
> = {
  "FOR UPDATE": (tx, tenantId, lotIds, variantIdsOfAllLots) => tx.$queryRaw<IdRow[]>`
    SELECT l.id FROM app.inventory_lots l
     WHERE l.tenant_id = ${tenantId}::uuid
       AND (l.id = ANY(${lotIds}::uuid[]) OR l.variant_id = ANY(${variantIdsOfAllLots}::uuid[]))
     ORDER BY l.id
       FOR UPDATE OF l`,
  "FOR NO KEY UPDATE": (tx, tenantId, lotIds, variantIdsOfAllLots) => tx.$queryRaw<IdRow[]>`
    SELECT l.id FROM app.inventory_lots l
     WHERE l.tenant_id = ${tenantId}::uuid
       AND (l.id = ANY(${lotIds}::uuid[]) OR l.variant_id = ANY(${variantIdsOfAllLots}::uuid[]))
     ORDER BY l.id
       FOR NO KEY UPDATE OF l`,
};

export interface StockLockTargets {
  /** Las variantes involucradas. Se bloquean primero, por `id` ascendente. */
  readonly variantIds: readonly string[];
  /** Lotes concretos involucrados. Se bloquean después de las variantes, por `id` ascendente. */
  readonly lotIds?: readonly string[];
  /** Además, TODOS los lotes de `variantIds`. Para quien decide sobre una variante entera. */
  readonly allLotsOfVariants?: boolean;
}

export interface StockLocks {
  readonly variantIds: readonly string[];
  readonly lotIds: readonly string[];
}

function distinct(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Bloquea las variantes y después los lotes, en el orden de RN-RES-07, y
 * devuelve lo que de verdad quedó bloqueado. **Corre con la visibilidad de
 * quien llama**: bajo RLS, un `FOR UPDATE` solo toma las filas que pasan la
 * política de lectura Y la de UPDATE, y a quien le falta cualquiera de las
 * dos no le bloquea nada, sin error (los lotes exigen `inventory.stock:read`
 * para leer y un permiso de movimiento para escribir; la variante, solo
 * tenant). Por eso devuelve los ids: quien necesita que un lote concreto esté
 * bloqueado compara.
 */
export async function lockVariantsThenLots(
  tx: TenantTx,
  tenantId: string,
  targets: StockLockTargets,
): Promise<StockLocks> {
  const variantIds = distinct(targets.variantIds);
  const lotIds = distinct(targets.lotIds ?? []);

  const lockedVariants =
    variantIds.length > 0 ? await LOCK_VARIANTS[VARIANT_LOCK_MODE](tx, tenantId, variantIds) : [];

  const lockedLots =
    lotIds.length > 0 || targets.allLotsOfVariants
      ? await LOCK_LOTS[LOT_LOCK_MODE](
          tx,
          tenantId,
          lotIds,
          targets.allLotsOfVariants ? variantIds : [],
        )
      : [];

  return {
    variantIds: lockedVariants.map((row) => row.id),
    lotIds: lockedLots.map((row) => row.id),
  };
}

/**
 * `variant_id` de un lote, leído SIN bloquear: es lo primero que necesita quien
 * solo conoce el lote (la apertura, un ajuste, el alta de una unidad, la
 * ejecución de una orden) para poder bloquear la variante ANTES que el lote.
 * `null` si el lote no existe o RLS lo oculta (la cara de un permiso
 * insuficiente: 404).
 */
export async function peekLotVariantId(tx: TenantTx, lotId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<{ variant_id: string }[]>`
    SELECT l.variant_id FROM app.inventory_lots l WHERE l.id = ${lotId}::uuid`;
  return rows[0]?.variant_id ?? null;
}

/**
 * Bloquea la variante y después el lote de quien solo conoce el lote, y
 * REVALIDA ya con ambos bloqueados que el lote sigue siendo de esa variante
 * (RN-RES-07: "lee su `variant_id` sin bloquear, bloquea la variante y después
 * el lote, y revalida"). Devuelve `null` si el lote no existe o RLS lo oculta.
 *
 * Que un lote cambie de variante entre la lectura y el bloqueo no puede pasar
 * por la API: un lote con movimientos, unidades o reservas no cambia de
 * variante (FK compuestas de 0023, 0029 y 0040), y ningún procedimiento lo
 * edita. Solo un lote recién creado y sin nada colgado, tocado por SQL directo,
 * podría: se relee hasta tres veces y, si sigue cambiando, se lanza (un bug,
 * no un fallo del negocio).
 */
export async function lockLotWithItsVariant(
  tx: TenantTx,
  tenantId: string,
  lotId: string,
  extraVariantIds: readonly string[] = [],
): Promise<{ readonly variantId: string } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const variantId = await peekLotVariantId(tx, lotId);
    if (variantId === null) return null;
    const locks = await lockVariantsThenLots(tx, tenantId, {
      variantIds: [variantId, ...extraVariantIds],
      lotIds: [lotId],
    });
    if (!locks.lotIds.includes(lotId)) {
      // El lote existe y se lee, pero no se pudo bloquear: la política de UPDATE
      // de `inventory_lots` se lo oculta a quien llama (le falta el permiso de
      // escritura). La operación que sigue lo rechazaría igual.
      return { variantId };
    }
    if ((await peekLotVariantId(tx, lotId)) === variantId) return { variantId };
  }
  throw new Error(`el lote ${lotId} siguió cambiando de variante mientras se bloqueaba`);
}

/**
 * `FOR KEY SHARE` sobre las variantes, en UNA sentencia y por `id` ascendente.
 * Para quien inserta filas que referencian VARIAS variantes (las líneas de un
 * pedido): la FK toma ese mismo bloqueo, pero en el orden de las filas, y
 * contra un `FOR UPDATE` ascendente de `lockVariantsThenLots` eso puede
 * interbloquearse. Tomarlos antes, ascendentes, deja un solo orden. No choca
 * con otro `KEY SHARE` ni con un `FOR NO KEY UPDATE`.
 */
export async function shareLockVariantsAscending(
  tx: TenantTx,
  tenantId: string,
  variantIds: readonly string[],
): Promise<void> {
  const ids = distinct(variantIds);
  if (ids.length === 0) return;
  await tx.$queryRaw`
    SELECT v.id FROM app.product_variants v
     WHERE v.id = ANY(${ids}::uuid[]) AND v.tenant_id = ${tenantId}::uuid
     ORDER BY v.id
       FOR KEY SHARE OF v`;
}
