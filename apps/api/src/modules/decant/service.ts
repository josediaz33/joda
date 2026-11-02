import type {
  AdminDecantWorkOrder,
  DecantBomLine,
  ExecuteDecantInput,
  ExecuteDecantOutput,
  ListDecantOrdersInput,
  ListDecantOrdersOutput,
  PlanDecantInput,
  PlanDecantOutput,
  StartDecantInput,
} from "@joda/contracts";
import {
  Money,
  Percentage,
  Quantity,
  computeTransferWaste,
  executeDecant,
  planDecant,
  computeDecantHoldExpiresAt,
  selectLotsByPolicy,
  transitionDecantWorkOrder,
  type BomAvailability,
  type BomLotSnapshot,
  type Clock,
  type DecantError,
  type DecantPlan,
  type DecantWoStatus,
  type LotSnapshot,
  type PlanBulkLot,
} from "@joda/domain";
import type { PrismaClient } from "@joda/db";
import { recordAuditEntry } from "../../db/audit.js";
import { lockVariantsThenLots, peekLotVariantId } from "../../db/stockLocks.js";
import { withIdempotentTx } from "../../db/withIdempotentTx.js";
import { withTenantTx, type TenantTx, type TenantTxContext } from "../../db/withTenantTx.js";
import {
  appError,
  isPrismaKnownError,
  toTRPCError,
  type ApiError,
} from "../../middleware/errorMapper.js";
import { buildIdempotencyRequest } from "../../middleware/idempotency.js";
import type { RequestContext } from "../../trpc/context.js";
import * as inventoryRepo from "../inventory/repository.js";
import { toAdminMovement } from "../inventory/mappers.js";
import * as reservationsRepo from "../reservations/repository.js";
import { DECANT_WORK_ORDER_REFERENCE, releaseReservationsOf } from "../reservations/service.js";
import { toAdminDecantWorkOrder, toDecantQueueGroups } from "./mappers.js";
import * as repo from "./repository.js";

// Fraccionamiento — WP-C13, RF-FRA-01…06, RN-FRA-01…07, RN-EST-03, ADR-010.
// El dominio decide (`planDecant`, `executeDecant`, la máquina de estados de
// la orden); acá se lee, se bloquea y se persiste, todo en la misma
// transacción. Planificar RESERVA (WP-C18b, RN-FRA-01/02, RN-RES-06): el
// granel, atado al lote elegido, y los insumos del BOM, por variante; ejecutar
// libera todo lo que la orden reservó, y consume lo de verdad contra el saldo.
// Tampoco abre frascos: abrir es irreversible (ADR-009) y es una decisión de
// una persona, no un efecto de planificar.

/** Lo que el servicio necesita del entorno y no puede leer solo (.claude/rules/domain.md: el reloj entra por puerto). */
export interface DecantServiceDeps {
  readonly clock: Clock;
}

const NOT_FOUND_ERROR = appError("NOT_FOUND", 404, "No encontrado.");

/** Mismo criterio que requireStaffContext de modules/inventory/service.ts. */
function requireStaffContext(ctx: RequestContext): TenantTxContext {
  if (ctx.audience === "staff" && ctx.userId && ctx.tenantId && ctx.sessionId) {
    return {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      audience: ctx.audience,
      sessionId: ctx.sessionId,
    };
  }
  throw toTRPCError(
    appError("UNAUTHENTICATED_SESSION_EXPIRED", 401, "Necesitás una sesión de personal."),
  );
}

// ---------------------------------------------------------------------
// Errores de negocio → ApiError (docs/api-conventions.md §4). Ningún mensaje
// de Postgres llega al usuario: lo que el dominio rechaza se traduce acá.
// ---------------------------------------------------------------------
function decantError(error: DecantError): ApiError {
  switch (error.code) {
    case "SOURCE_LOT_NOT_DECANTABLE":
      return appError(
        "CONFLICT_SOURCE_LOT_NOT_DECANTABLE",
        409,
        "El lote de origen no es granel abierto para fraccionar: solo se fracciona un lote de granel en estado «abierto para fraccionar».",
        { status: error.status },
      );
    case "INSUFFICIENT_BULK":
      return appError(
        "CONFLICT_INSUFFICIENT_BULK",
        409,
        "El granel del lote no alcanza para la orden completa (líquido más merma esperada).",
        { required: error.required.value, available: error.available.value },
      );
    case "INSUFFICIENT_BOM_COMPONENT":
      return appError(
        "CONFLICT_INSUFFICIENT_BOM_COMPONENT",
        409,
        "Falta stock de un insumo del BOM para esta orden.",
        {
          componentVariantId: error.componentId,
          required: error.required.value,
          available: error.available.value,
        },
      );
    case "INSUFFICIENT_BULK_FOR_ACTUAL":
      // Caso borde 2: la merma real superó lo reservado y el granel no alcanza.
      // La ejecución se revierte entera y la orden sigue `in_progress` (se
      // inició antes): queda para resolución manual, no se completa a la fuerza.
      return appError(
        "CONFLICT_INSUFFICIENT_BULK_FOR_ACTUAL",
        409,
        "La merma real no cabe en el granel del lote. No se ejecutó nada y la orden sigue en curso: hace falta resolverlo antes de ejecutarla.",
        { required: error.required.value, available: error.available.value },
      );
    case "MISSING_BOM_COMPONENT":
      // Caso borde 3: falta un insumo obligatorio. No se consume nada y la
      // orden sigue en curso hasta que haya stock; esta respuesta es la alerta.
      return appError(
        "CONFLICT_MISSING_BOM_COMPONENT",
        409,
        "Falta un insumo obligatorio del BOM. No se ejecutó nada y la orden sigue en curso hasta que haya stock.",
        {
          componentVariantId: error.componentId,
          required: error.required.value,
          available: error.available.value,
        },
      );
  }
}

const STATUS_LABEL: Record<DecantWoStatus, string> = {
  pending: "pendiente",
  in_progress: "en curso",
  done: "ejecutada",
  cancelled: "cancelada",
};

function invalidTransitionError(from: DecantWoStatus, to: DecantWoStatus): ApiError {
  if (from === "pending" && to === "done") {
    return appError(
      "CONFLICT_ORDER_NOT_STARTED",
      409,
      "La orden todavía no fue iniciada: iniciala antes de ejecutarla.",
      { status: from },
    );
  }
  return appError(
    "CONFLICT_INVALID_TRANSITION",
    409,
    `La orden está ${STATUS_LABEL[from]} y no admite esta acción.`,
    { from, to },
  );
}

const VARIANT_NOT_DECANT_ERROR = appError(
  "CONFLICT_VARIANT_NOT_DECANT",
  409,
  "La variante no es un decant: solo se planifica el fraccionamiento de una variante fraccionada.",
);

const VARIANT_NOT_MADE_TO_ORDER_ERROR = appError(
  "CONFLICT_VARIANT_NOT_MADE_TO_ORDER",
  409,
  "La variante se produce para stock, no bajo pedido: producir decants por anticipado todavía no está disponible.",
);

const PRODUCT_NOT_PERFUME_ERROR = appError(
  "CONFLICT_PRODUCT_NOT_PERFUME",
  409,
  "El producto no tiene datos de perfume: no se puede calcular la merma esperada.",
);

const SOURCE_LOT_VARIANT_MISMATCH_ERROR = appError(
  "CONFLICT_SOURCE_LOT_VARIANT_MISMATCH",
  409,
  "El lote de origen no es del granel del que se sirve esta variante.",
);

const SALE_ORDER_NOT_PLANNABLE_ERROR = appError(
  "CONFLICT_SALE_ORDER_NOT_PLANNABLE",
  409,
  "Solo se planifica el fraccionamiento de una venta en espera de pago o ya cobrada.",
);

const DECANT_ORDER_ALREADY_PLANNED_ERROR = appError(
  "CONFLICT_DECANT_ORDER_ALREADY_PLANNED",
  409,
  "Esa línea de la venta ya tiene una orden de fraccionamiento activa. Cancelala para planificar otra.",
);

const DECANT_LINE_MISMATCH_ERROR = appError(
  "VALIDATION_DECANT_LINE_MISMATCH",
  400,
  "La variante y la cantidad de la orden tienen que ser las de la línea de la venta.",
);

function noBulkAvailableError(requiredMl: number, largestAvailableMl: number): ApiError {
  return appError(
    "CONFLICT_NO_BULK_AVAILABLE",
    409,
    "Ningún frasco abierto alcanza para la orden completa. Abrí un frasco nuevo desde su lote sellado e intentá de nuevo.",
    { requiredMl, largestAvailableMl },
  );
}

// ---------------------------------------------------------------------
// Armado de las entradas del dominio desde filas de base.
// ---------------------------------------------------------------------
function toQuantity(value: number, uom: "unit" | "ml"): Quantity {
  return uom === "unit" ? Quantity.units(value) : Quantity.ml(value);
}

/**
 * RN-FRA-07: el dominio distingue un granel de un sellado recién abierto por
 * `variantType` y `uom` (WP-A15), y los dos salen de la VARIANTE del lote,
 * nunca de lo que diga el cliente. Un snapshot armado sin ellos eludiría la
 * validación.
 */
function toLotSnapshot(row: repo.LotWithVariantRow, availableOverride?: Quantity): LotSnapshot {
  const uom = row.product_variants.uom;
  return {
    id: row.id,
    receivedAt: row.received_at,
    expiryAt: row.expiry_at,
    available:
      availableOverride ?? toQuantity(row.inventory_balances?.on_hand.toNumber() ?? 0, uom),
    unitCost: Money.pyg(row.unit_landed_cost_pyg),
    status: row.status,
    variantType: row.product_variants.variant_type,
    uom,
  };
}

/** Un insumo del BOM de la variante fraccionada, con lo que hace falta para elegirle lote. */
interface BomLine {
  readonly componentVariantId: string;
  readonly sku: string;
  readonly perUnit: Quantity;
  readonly isOptional: boolean;
  readonly allocationPolicy: repo.VariantLabelRow["allocation_policy"];
  /** `product_variants.uom` del insumo: sus lotes solo cuentan si se miden en la unidad que pide el BOM. */
  readonly variantUom: repo.VariantLabelRow["uom"];
}

interface BomContext {
  readonly lines: readonly BomLine[];
  /** Lotes de insumo consumibles (en `available`, con saldo), de todos los componentes. */
  readonly supplyLots: readonly repo.LotWithVariantRow[];
}

/**
 * Lee el BOM de la variante (componentes y etiquetas: dos consultas). Va ANTES
 * de bloquear —hace falta para saber QUÉ variantes bloquear (RN-RES-07)— y los
 * lotes se leen después, ya con las variantes bloqueadas (`loadSupplyLots`).
 */
async function loadBomLines(tx: TenantTx, variantId: string): Promise<readonly BomLine[]> {
  const components = await repo.listBomComponents(tx, variantId);
  if (components.length === 0) return [];

  const labels = await repo.listVariantLabels(
    tx,
    components.map((component) => component.component_variant_id),
  );
  const labelById = new Map(labels.map((label) => [label.id, label]));

  return components.map((component): BomLine => {
    const label = labelById.get(component.component_variant_id);
    if (!label) {
      throw new Error(`el insumo ${component.component_variant_id} del BOM no se pudo leer`);
    }
    const perUnit = component.qty_per_unit.toNumber();
    // Una cantidad con decimales sobre una unidad entera es un BOM mal cargado:
    // se dice qué insumo es, no se deja que el dominio la trate como un bug.
    if (component.uom === "unit" && !Number.isInteger(perUnit)) {
      throw toTRPCError(
        appError(
          "CONFLICT_BOM_QUANTITY_INVALID",
          409,
          `El insumo ${label.sku} se mide en unidades enteras y el BOM le pide ${perUnit}. Corregí el BOM en el catálogo.`,
          { componentVariantId: component.component_variant_id },
        ),
      );
    }
    return {
      componentVariantId: component.component_variant_id,
      sku: label.sku,
      perUnit: toQuantity(perUnit, component.uom),
      isOptional: component.is_optional,
      allocationPolicy: label.allocation_policy,
      variantUom: label.uom,
    };
  });
}

/** Los lotes de insumo consumibles de los componentes. Se lee con las variantes ya bloqueadas. */
async function loadSupplyLots(
  tx: TenantTx,
  lines: readonly BomLine[],
): Promise<readonly repo.LotWithVariantRow[]> {
  if (lines.length === 0) return [];
  return repo.listSupplyLots(
    tx,
    lines.map((line) => line.componentVariantId),
  );
}

/**
 * Bloquea las variantes que la operación toca y TODOS sus lotes, en el orden de
 * RN-RES-07 (`db/stockLocks.ts`): la del fraccionamiento (la orden guarda su
 * `target_variant_id` y los movimientos y reservas apuntan a las otras), la del
 * granel y las de los insumos del BOM. Después de esto el BOM se relee: si
 * cambió mientras se bloqueaba (un componente nuevo no quedó bloqueado) se
 * rechaza, y quien reintenta lo bloquea completo; tomar ahora la variante que
 * falta rompería el orden ascendente.
 *
 * `reservedVariantIds` son las variantes de lo que la orden ya tiene reservado
 * (la ejecución lo libera entero, también lo de un componente que salió del
 * BOM): entran en el MISMO bloqueo, ascendente y en una sola sentencia. Si se
 * dejaran para `releaseReservationsOf`, esa variante se tomaría al final, con
 * lotes y variantes de id mayor ya en la mano, y se cruzaría con quien la tiene
 * y pide una de esas (40P01).
 */
async function lockDecantVariants(
  tx: TenantTx,
  tenantId: string,
  targetVariantId: string,
  sourceVariantId: string,
  lines: readonly BomLine[],
  reservedVariantIds: readonly string[] = [],
): Promise<void> {
  await lockVariantsThenLots(tx, tenantId, {
    variantIds: [
      targetVariantId,
      sourceVariantId,
      ...lines.map((line) => line.componentVariantId),
      ...reservedVariantIds,
    ],
    allLotsOfVariants: true,
  });
  const relocked = await loadBomLines(tx, targetVariantId);
  const before = new Set(lines.map((line) => line.componentVariantId));
  if (
    relocked.length !== lines.length ||
    relocked.some((line) => !before.has(line.componentVariantId))
  ) {
    throw toTRPCError(
      appError(
        "CONFLICT_BOM_CHANGED",
        409,
        "El BOM del decant cambió mientras se procesaba la operación. Reintentá.",
      ),
    );
  }
}

/** Los lotes de un componente que se miden en la misma unidad que pide el BOM, como snapshot. */
function supplySnapshotsOf(line: BomLine, lots: readonly repo.LotWithVariantRow[]): LotSnapshot[] {
  return lots
    .filter(
      (lot) =>
        lot.variant_id === line.componentVariantId && lot.product_variants.uom === line.perUnit.uom,
    )
    .map((lot) => toLotSnapshot(lot));
}

// ---------------------------------------------------------------------
// Planificación — RF-FRA-01, RN-FRA-02. El compromiso: crea la orden
// `pending` con la merma ESPERADA y no consume nada (RN-FRA-01).
// ---------------------------------------------------------------------
export interface PlannedWorkOrder {
  readonly order: repo.DecantWorkOrderRow;
  readonly plan: DecantPlan;
  readonly bom: readonly DecantBomLine[];
}

/**
 * Un lote candidato para planificar, SIN costo: lo que `planDecant` lee (estado,
 * tipo y unidad de la variante, cuánto hay) y su identidad. Lo arma quien
 * planifica con las tres columnas de `app.list_decant_plan_lots` (el vendedor no
 * lee lotes) o, si un administrador eligió el frasco, desde la fila del lote.
 */
interface PlanLotCandidate {
  readonly id: string;
  readonly variantId: string;
  /**
   * Lo que queda libre del lote: el saldo menos lo que otras órdenes reservaron atado
   * a él. `app.list_decant_plan_lots` ya lo entrega descontado (0041); un lote que se
   * lee de la tabla (`sourceLotId`) se descuenta al armar el candidato.
   */
  readonly free: Quantity;
  readonly status: PlanBulkLot["status"];
  readonly variantType: PlanBulkLot["variantType"];
  readonly uom: PlanBulkLot["uom"];
}

/** El estado que `app.list_decant_plan_lots` da por tipo de variante (0039): el granel abierto, el resto disponible. */
function planLotStatus(variantType: repo.VariantLabelRow["variant_type"]): PlanBulkLot["status"] {
  return variantType === "bulk" ? "open_for_decant" : "available";
}

/**
 * Las variantes que planificar (y ejecutar) el fraccionamiento de una variante
 * decant toca: la propia, la del granel de la que se sirve y las de los insumos
 * del BOM. Quien necesita bloquearlas junto con otras variantes (la confirmación
 * de una venta con líneas de decant) las toma TODAS en una sola llamada a
 * `lockVariantsThenLots`, ascendentes (RN-RES-07): tomarlas después, ya con
 * variantes de id mayor en la mano, rompe el orden y se interbloquea.
 */
export async function listDecantVariantIds(
  tx: TenantTx,
  targetVariantId: string,
): Promise<string[]> {
  const variant = await repo.findTargetVariant(tx, targetVariantId);
  if (!variant) return [targetVariantId];
  const components = await repo.listBomComponents(tx, targetVariantId);
  return [
    targetVariantId,
    ...(variant.source_variant_id === null ? [] : [variant.source_variant_id]),
    ...components.map((component) => component.component_variant_id),
  ];
}

/**
 * La orden NACE de una línea de la venta (WP-C19, RN-FRA-01): la confirmación
 * la llama DENTRO de su transacción, o `inventory.decant.plan` por separado, así
 * que la orden y su venta se confirman o se revierten juntas. Por eso recibe el
 * `tx` en vez de abrir uno, y lanza `TRPCError` ante lo que rechaza (rollback del
 * llamador).
 *
 * **Valida la venta** (decisión de José, 2026-10-07): la línea existe en el tenant
 * (bajo RLS: las FK no evalúan RLS, docs/api-conventions.md §8.4), su pedido está
 * en `awaiting_payment` o `paid` (la «confirmación de la venta» de RN-FRA-01), y la
 * variante y la cantidad de la orden son las de la línea. Toma el bloqueo del
 * pedido antes que el de stock. **Una orden activa por línea** lo impone la base
 * (`decant_wo_one_active_per_line`, 0039): un segundo intento responde 409.
 *
 * **Lee los lotes sin `inventory.stock:read`** (H1 de WP-C13): el granel y cada
 * insumo vienen de `app.list_decant_plan_lots`, que no devuelve costos. Un
 * `sourceLotId` explícito sí se lee del lote, bajo RLS: quien no lee lotes recibe
 * 404, como siempre.
 *
 * **Reserva** (WP-C18b, RN-FRA-01/02, RN-RES-06): en la misma transacción que
 * crea la orden, el granel (`mlToReserve`) atado al lote elegido y cada insumo
 * del BOM por variante, con `reason = decant_hold`. Planifica contra el
 * DISPONIBLE, no contra el saldo: lo que otra orden ya reservó no se vuelve a
 * ofrecer, así que dos órdenes no comprometen el mismo granel. Antes de leer
 * toma el bloqueo de las variantes que toca y de sus lotes, en el orden único
 * (RN-RES-07). Dura hasta ejecutar o cancelar la orden (`computeDecantHoldExpiresAt`).
 */
export async function createPlannedWorkOrder(
  tx: TenantTx,
  session: TenantTxContext,
  input: PlanDecantInput,
  deps: DecantServiceDeps,
): Promise<PlannedWorkOrder> {
  // Primero la fila de la entidad que decide el caso de uso: el pedido (RN-RES-07).
  const saleLine = await repo.lockSaleOrderOfLine(tx, session.tenantId, input.saleOrderLineId);
  if (!saleLine) throw toTRPCError(NOT_FOUND_ERROR);
  if (saleLine.order_status !== "awaiting_payment" && saleLine.order_status !== "paid") {
    throw toTRPCError(SALE_ORDER_NOT_PLANNABLE_ERROR);
  }
  if (saleLine.variant_id !== input.targetVariantId || saleLine.qty.toNumber() !== input.qtyUnits) {
    throw toTRPCError(DECANT_LINE_MISMATCH_ERROR);
  }

  const variant = await repo.findTargetVariant(tx, input.targetVariantId);
  if (!variant) throw toTRPCError(NOT_FOUND_ERROR);
  if (variant.variant_type !== "decant") throw toTRPCError(VARIANT_NOT_DECANT_ERROR);
  const sourceVariantId = variant.source_variant_id;
  if (variant.production_mode !== "made_to_order" || sourceVariantId === null) {
    throw toTRPCError(VARIANT_NOT_MADE_TO_ORDER_ERROR);
  }
  if (variant.size_ml === null) {
    // El CHECK de product_variants lo impide: un decant siempre lleva volumen.
    throw new Error(`la variante decant ${variant.id} no tiene size_ml`);
  }
  const mlPerUnit = variant.size_ml.toNumber();

  const wasteFactor = await repo.findWasteFactor(tx, variant.product_id);
  if (wasteFactor === null) throw toTRPCError(PRODUCT_NOT_PERFUME_ERROR);

  const lines = await loadBomLines(tx, variant.id);
  // RN-RES-07: las variantes (decant, granel e insumos) y sus lotes, ANTES de leer el
  // saldo y las reservas. Desde acá nadie reserva, abre ni consume sobre ellas. Quien
  // no lee lotes (el vendedor) no bloquea ninguno: lo que lo protege es la variante,
  // que todo camino que decide sobre stock toma primero.
  await lockDecantVariants(tx, session.tenantId, variant.id, sourceVariantId, lines);

  // El disponible por variante (saldo − reservas vivas, RN-RES-03): las reservas
  // sin lote (las de un insumo) no se descuentan lote por lote, se descuentan
  // del total de la variante.
  const stock = await reservationsRepo.findVariantsStock(tx, [
    sourceVariantId,
    ...lines.map((line) => line.componentVariantId),
  ]);
  const variantAvailable = (variantId: string, uom: "unit" | "ml"): Quantity =>
    toQuantity(stock.get(variantId)?.available ?? 0, uom);
  const smaller = (a: Quantity, b: Quantity): Quantity => (a.compare(b) <= 0 ? a : b);

  // Los insumos: lo que hay en sus lotes disponibles, sin leer la tabla de lotes (una
  // llamada por componente, como fijó WP-B18), nunca más que el disponible de la variante.
  const bomAvailability: BomAvailability[] = [];
  for (const line of lines) {
    const supplyLots =
      line.variantUom === line.perUnit.uom
        ? await repo.listPlanLots(tx, line.componentVariantId)
        : [];
    bomAvailability.push({
      componentId: line.componentVariantId,
      available: smaller(
        supplyLots.reduce(
          (sum, lot) => sum.plus(toQuantity(lot.available.toNumber(), line.perUnit.uom)),
          Quantity.zero(line.perUnit.uom),
        ),
        variantAvailable(line.componentVariantId, line.perUnit.uom),
      ),
      perUnit: line.perUnit,
    });
  }

  // El granel lo elige el servidor salvo que el admin pida uno: el abierto de
  // apertura más antigua que alcance para la orden COMPLETA. Si ninguno
  // alcanza solo se rechaza; nunca se abre un frasco desde acá (irreversible).
  let candidates: PlanLotCandidate[];
  if (input.sourceLotId !== undefined) {
    const lot = await repo.findLotWithVariant(tx, input.sourceLotId);
    if (!lot) throw toTRPCError(NOT_FOUND_ERROR);
    if (lot.variant_id !== sourceVariantId) throw toTRPCError(SOURCE_LOT_VARIANT_MISMATCH_ERROR);
    const reservedOnLot = await reservationsRepo.sumLiveReservedByLot(tx, session.tenantId, [
      lot.id,
    ]);
    const freeOnLot = toQuantity(lot.inventory_balances?.on_hand.toNumber() ?? 0, "ml").minus(
      Quantity.ml(reservedOnLot.get(lot.id) ?? 0),
    );
    candidates = [
      {
        id: lot.id,
        variantId: lot.variant_id,
        free: freeOnLot.isNegative() ? Quantity.zero("ml") : freeOnLot,
        status: lot.status,
        variantType: lot.product_variants.variant_type,
        uom: lot.product_variants.uom,
      },
    ];
  } else {
    const [sourceKind] = await repo.listVariantLabels(tx, [sourceVariantId]);
    if (!sourceKind) throw toTRPCError(NOT_FOUND_ERROR);
    candidates = (await repo.listPlanLots(tx, sourceVariantId)).map((lot) => ({
      id: lot.lot_id,
      variantId: sourceVariantId,
      free: toQuantity(lot.available.toNumber(), sourceKind.uom),
      status: planLotStatus(sourceKind.variant_type),
      variantType: sourceKind.variant_type,
      uom: sourceKind.uom,
    }));
  }
  // Lo libre de cada lote candidato, y nunca más que el disponible de la variante (que
  // además descuenta las reservas sin lote del granel).
  const bulkVariantAvailable = variantAvailable(sourceVariantId, "ml");
  const freeOf = (lot: PlanLotCandidate): Quantity => smaller(lot.free, bulkVariantAvailable);

  let chosen: { lot: PlanLotCandidate; plan: DecantPlan } | undefined;
  let lastShortage: DecantError | undefined;
  let largestAvailableMl = 0;
  for (const lot of candidates) {
    const planned = planDecant({
      unitsRequested: input.qtyUnits,
      mlPerUnit,
      wasteFactor: Percentage.of(wasteFactor),
      bulkLot: {
        available: freeOf(lot),
        status: lot.status,
        variantType: lot.variantType,
        uom: lot.uom,
      },
      bomAvailability,
    });
    if (planned.ok) {
      chosen = { lot, plan: planned.value };
      break;
    }
    // Un lote que no alcanza no es el fin: el siguiente puede alcanzar. Todo lo
    // demás (insumo sin stock, lote que no es granel) no depende del lote.
    if (planned.error.code !== "INSUFFICIENT_BULK") throw toTRPCError(decantError(planned.error));
    lastShortage = planned.error;
    largestAvailableMl = Math.max(largestAvailableMl, planned.error.available.value);
  }

  if (!chosen) {
    if (input.sourceLotId !== undefined && lastShortage) {
      throw toTRPCError(decantError(lastShortage));
    }
    const mlExpected = Quantity.ml(input.qtyUnits * mlPerUnit);
    const mlToReserve = mlExpected.plus(
      computeTransferWaste(mlExpected, Percentage.of(wasteFactor)),
    );
    throw toTRPCError(noBulkAvailableError(mlToReserve.value, largestAvailableMl));
  }

  const { lot, plan } = chosen;
  let order: repo.DecantWorkOrderRow;
  try {
    order = await repo.insertWorkOrder(tx, {
      tenantId: session.tenantId,
      saleOrderId: saleLine.sale_order_id,
      saleOrderLineId: saleLine.line_id,
      sourceLotId: lot.id,
      targetVariantId: variant.id,
      qtyUnits: input.qtyUnits,
      mlPerUnit,
      mlExpected: plan.mlExpected.value,
      wasteExpected: plan.wasteExpected.value,
      createdBy: session.userId,
    });
  } catch (error) {
    // El índice único parcial de 0039 (una orden activa por línea): dos llamadas, con
    // claves de idempotencia distintas o sin clave, planificaron la misma línea. El
    // bloqueo de las variantes las serializa, así que la segunda lo encuentra acá.
    if (isPrismaKnownError(error) && error.code === "P2002") {
      throw toTRPCError(DECANT_ORDER_ALREADY_PLANNED_ERROR);
    }
    throw error;
  }

  // RN-FRA-01/02: el compromiso. El granel va atado al lote elegido; los insumos,
  // por variante (RN-RES-06). Una cantidad en cero (un insumo opcional que el BOM
  // define en cero) no se reserva: la tabla exige `qty > 0`.
  const holdExpiresAt = new Date(computeDecantHoldExpiresAt(deps.clock.now()));
  await reservationsRepo.insertReservations(tx, [
    {
      tenantId: session.tenantId,
      variantId: lot.variantId,
      lotId: lot.id,
      serialUnitId: null,
      qty: plan.mlToReserve.value,
      reason: "decant_hold",
      referenceType: DECANT_WORK_ORDER_REFERENCE,
      referenceId: order.id,
      expiresAt: holdExpiresAt,
      createdBy: session.userId,
    },
    ...lines.flatMap((line, index) => {
      const qty = plan.bomToReserve[index]!.qty.value;
      return qty > 0
        ? [
            {
              tenantId: session.tenantId,
              variantId: line.componentVariantId,
              lotId: null,
              serialUnitId: null,
              qty,
              reason: "decant_hold" as const,
              referenceType: DECANT_WORK_ORDER_REFERENCE,
              referenceId: order.id,
              expiresAt: holdExpiresAt,
              createdBy: session.userId,
            },
          ]
        : [];
    }),
  ]);

  const bomLines = lines.map((line, index): DecantBomLine => ({
    componentVariantId: line.componentVariantId,
    qty: plan.bomToReserve[index]!.qty.value,
    uom: line.perUnit.uom,
    isOptional: line.isOptional,
  }));
  return { order, plan, bom: bomLines };
}

export async function planWorkOrder(
  db: PrismaClient,
  deps: DecantServiceDeps,
  ctx: RequestContext,
  input: PlanDecantInput,
): Promise<PlanDecantOutput> {
  const session = requireStaffContext(ctx);
  const idempotency = buildIdempotencyRequest(ctx.req, input);

  const { result } = await withIdempotentTx(db, session, idempotency, async (tx) => {
    const planned = await createPlannedWorkOrder(tx, session, input, deps);

    await recordAuditEntry(tx, {
      tenantId: session.tenantId,
      actorId: session.userId,
      audience: session.audience,
      action: "inventory.decant.plan",
      entity: "decant_work_orders",
      entityId: planned.order.id,
      before: null,
      after: {
        saleOrderId: planned.order.sale_order_id,
        saleOrderLineId: input.saleOrderLineId,
        targetVariantId: input.targetVariantId,
        sourceLotId: planned.order.source_lot_id,
        qtyUnits: input.qtyUnits,
        mlExpected: String(planned.plan.mlExpected.value),
        wasteExpected: String(planned.plan.wasteExpected.value),
      },
      ip: ctx.req.ip,
      userAgent: ctx.req.headers["user-agent"] ?? null,
      requestId: ctx.requestId,
    });

    return {
      result: {
        order: toAdminDecantWorkOrder(planned.order),
        mlToReserve: planned.plan.mlToReserve.value,
        bom: [...planned.bom],
      },
      statusCode: 200,
    };
  });

  return result;
}

// ---------------------------------------------------------------------
// Inicio — RN-EST-03, pending → in_progress. Es un paso aparte de la
// ejecución a propósito: evita que dos personas tomen la misma orden y deja
// la orden `in_progress` si la ejecución falla (caso borde 2) sin tener que
// escribir estado en el camino del error.
// ---------------------------------------------------------------------
export async function startWorkOrder(
  db: PrismaClient,
  ctx: RequestContext,
  input: StartDecantInput,
): Promise<AdminDecantWorkOrder> {
  const session = requireStaffContext(ctx);
  const idempotency = buildIdempotencyRequest(ctx.req, input);

  const { result } = await withIdempotentTx(db, session, idempotency, async (tx) => {
    const order = await repo.findWorkOrderForUpdate(tx, input.workOrderId);
    if (!order) throw toTRPCError(NOT_FOUND_ERROR);

    const transition = transitionDecantWorkOrder(order.status, "in_progress");
    if (!transition.ok) throw toTRPCError(invalidTransitionError(order.status, "in_progress"));

    const started = await repo.markWorkOrderInProgress(tx, order.id);

    await recordAuditEntry(tx, {
      tenantId: session.tenantId,
      actorId: session.userId,
      audience: session.audience,
      action: "inventory.decant.start",
      entity: "decant_work_orders",
      entityId: order.id,
      before: { status: order.status },
      after: { status: started.status },
      ip: ctx.req.ip,
      userAgent: ctx.req.headers["user-agent"] ?? null,
      requestId: ctx.requestId,
    });

    return { result: toAdminDecantWorkOrder(started), statusCode: 200 };
  });

  return result;
}

// ---------------------------------------------------------------------
// Ejecución — RF-FRA-02/03/04/05, RN-FRA-03/04. Alguien llena el vial: con la
// merma REAL se consume, en UNA transacción, el líquido del granel, la merma y
// cada insumo del BOM. Todo o nada: ante cualquier rechazo del dominio se
// lanza y la transacción entera se revierte, con la orden aún `in_progress`.
// ---------------------------------------------------------------------

/**
 * Elige el lote del que sale un insumo. Un insumo se consume de UN lote
 * (`BomLotSnapshot`): el primero, según la política de la variante (RN-LOT-05),
 * que cubre toda la cantidad. Partirlo entre lotes no está en el dominio
 * (`BomLotSnapshot` es uno por componente): es WP-C13f, con `allocateFromLots`.
 *
 * Si ningún lote lo cubre solo pero la SUMA de los lotes sí alcanza, no es un
 * faltante: se rechaza con un mensaje que dice que la cantidad está repartida,
 * y se rechaza TAMBIÉN si el insumo es opcional. Omitirlo sería dar por
 * "faltante" un insumo que está en stock y dejar el COGS sin su costo.
 * Solo si el total tampoco alcanza el dominio decide (caso borde 3 o 4).
 */
function chooseSupplyLot(
  line: BomLine,
  required: Quantity,
  lots: readonly repo.LotWithVariantRow[],
): BomLotSnapshot {
  const snapshots = selectLotsByPolicy(supplySnapshotsOf(line, lots), line.allocationPolicy);
  const covering = snapshots.find((lot) => lot.available.compare(required) >= 0);
  if (!covering) {
    const total = snapshots.reduce(
      (sum, lot) => sum.plus(lot.available),
      Quantity.zero(required.uom),
    );
    if (total.compare(required) >= 0) {
      throw toTRPCError(
        appError(
          "CONFLICT_BOM_COMPONENT_SPLIT_ACROSS_LOTS",
          409,
          `El insumo ${line.sku} alcanza en total (${total.value}) pero está repartido entre ${snapshots.length} lotes y ninguno cubre solo los ${required.value} que pide la orden. Por ahora un insumo sale de un solo lote: la orden sigue en curso hasta que un lote lo cubra.`,
          {
            componentVariantId: line.componentVariantId,
            required: required.value,
            available: total.value,
            lots: snapshots.length,
          },
        ),
      );
    }
  }
  const best =
    covering ??
    snapshots.reduce<LotSnapshot | undefined>(
      (max, lot) => (max === undefined || lot.available.value > max.available.value ? lot : max),
      undefined,
    );

  if (best) {
    return {
      componentId: line.componentVariantId,
      lotId: best.id,
      available: best.available,
      unitCost: best.unitCost,
      isOptional: line.isOptional,
    };
  }
  // Sin ningún lote consumible el dominio necesita igual el `isOptional` para
  // distinguir el caso borde 4 (opcional: se ejecuta sin él) del 3 (obligatorio:
  // se rechaza), y `BomLotSnapshot` exige un `lotId`. Va el id de la VARIANTE
  // como relleno: no apunta a ningún lote y no se lee nunca, porque sin saldo el
  // dominio no emite movimiento sobre él (`lotById.get` lo rechazaría si
  // alguna vez lo hiciera).
  return {
    componentId: line.componentVariantId,
    lotId: line.componentVariantId,
    available: Quantity.zero(line.perUnit.uom),
    unitCost: Money.pyg(0n),
    isOptional: line.isOptional,
  };
}

export async function executeWorkOrder(
  db: PrismaClient,
  deps: DecantServiceDeps,
  ctx: RequestContext,
  input: ExecuteDecantInput,
): Promise<ExecuteDecantOutput> {
  const session = requireStaffContext(ctx);
  const idempotency = buildIdempotencyRequest(ctx.req, input);

  const { result } = await withIdempotentTx(db, session, idempotency, async (tx) => {
    // La orden se bloquea primero: dos ejecuciones de la misma orden se
    // serializan acá, y la segunda lee `done` y el dominio la rechaza.
    const order = await repo.findWorkOrderForUpdate(tx, input.workOrderId);
    if (!order) throw toTRPCError(NOT_FOUND_ERROR);

    const transition = transitionDecantWorkOrder(order.status, "done");
    if (!transition.ok) throw toTRPCError(invalidTransitionError(order.status, "done"));

    const variant = await repo.findTargetVariant(tx, order.target_variant_id);
    if (!variant) {
      throw new Error(`la variante ${order.target_variant_id} de la orden ${order.id} no existe`);
    }

    // Se ejecuta con el BOM de HOY: la orden guarda la cantidad de unidades y
    // los ml, no una copia del BOM del momento de planificar. Lo que se reservó al
    // planificar se libera entero más abajo, así que si el BOM cambió la diferencia
    // (un insumo que ya no se consume, uno nuevo que nadie reservó) no queda colgada.
    const lines = await loadBomLines(tx, variant.id);

    // RN-RES-07 · el orden de bloqueo único. Quien solo conoce el lote lee su
    // variante SIN bloquear (el granel de origen), bloquea las variantes —la del
    // fraccionamiento, la del granel y las de los insumos— y todos sus lotes
    // (UNA sentencia por nivel, ascendente de `id`), y recién después lee el saldo.
    // Un lote que RLS oculta (`lots_read` pide `inventory.stock:read`) es la cara de
    // un permiso insuficiente: 404, no un 500.
    const sourceVariantId = await peekLotVariantId(tx, order.source_lot_id);
    if (sourceVariantId === null) throw toTRPCError(NOT_FOUND_ERROR);
    // Las variantes de lo que la orden reservó al planificar se leen ANTES de bloquear y
    // entran en el mismo bloqueo: si el BOM cambió, una puede no estar en `lines`, y
    // `releaseReservationsOf` (más abajo) la tomaría tarde, rompiendo el orden ascendente.
    // La lectura es estable sin bloquear nada: la fila de la orden ya está tomada (nadie
    // más la ejecuta ni la cancela) y las reservas de una orden solo nacen al planificarla;
    // después solo se liberan, así que el conjunto puede achicarse, nunca crecer.
    const reservedVariantIds = await reservationsRepo.listOpenReservationVariantIds(
      tx,
      session.tenantId,
      DECANT_WORK_ORDER_REFERENCE,
      order.id,
    );
    await lockDecantVariants(
      tx,
      session.tenantId,
      variant.id,
      sourceVariantId,
      lines,
      reservedVariantIds,
    );

    // Se bloquean TODOS los lotes de cada insumo, no solo el que se va a consumir,
    // a propósito: cuál se consume se decide con el saldo ya bloqueado, y bloquear
    // solo el elegido obligaría a leer, elegir, bloquear y volver a verificar. El
    // costo es que una ejecución espera a cualquier otra que toque un lote de esos
    // insumos. Los insumos no se venden (solo los consumen fraccionamientos y
    // ajustes), así que la contención es entre ejecuciones, que de todos modos son
    // manuales. Si se mide y importa, se acota; hoy no está medido.
    const bom: BomContext = { lines, supplyLots: await loadSupplyLots(tx, lines) };
    const lotIdsToRead = [...new Set([order.source_lot_id, ...bom.supplyLots.map((l) => l.id)])];
    // Se relee todo con una sentencia nueva —el saldo que cuenta es el de DESPUÉS
    // del bloqueo— y solo de los lotes bloqueados: lo que aparezca después no se toca.
    const lockedLots = await repo.findLotsWithVariant(tx, lotIdsToRead);
    const bulkRow = lockedLots.find((lot) => lot.id === order.source_lot_id);
    if (!bulkRow) {
      // La FK impide que el lote no exista: si no se lee, RLS lo oculta
      // (`lots_read` pide `inventory.stock:read`). Es la cara de un permiso
      // insuficiente, y esa es un 404 (docs/api-conventions.md §4.3), no un 500.
      throw toTRPCError(NOT_FOUND_ERROR);
    }
    const supplyRows = lockedLots.filter((lot) => lot.id !== order.source_lot_id);

    const mlExpected = Quantity.ml(order.ml_expected.toNumber());
    const wasteExpected = Quantity.ml(order.waste_expected.toNumber());
    const plan: DecantPlan = {
      mlExpected,
      wasteExpected,
      mlToReserve: mlExpected.plus(wasteExpected),
      bomToReserve: bom.lines.map((line) => ({
        componentId: line.componentVariantId,
        qty: line.perUnit.times(order.qty_units),
      })),
    };
    const bomLots = bom.lines.map((line, index) =>
      chooseSupplyLot(line, plan.bomToReserve[index]!.qty, supplyRows),
    );

    const executed = executeDecant({
      plan,
      wasteActual: Quantity.ml(input.wasteActual),
      bulkLot: toLotSnapshot(bulkRow),
      bomLots,
    });
    if (!executed.ok) throw toTRPCError(decantError(executed.error));
    const execution = executed.value;

    // Caso borde 4: lo que se ejecutó sin un insumo opcional queda dicho en el
    // movimiento del líquido. La orden no tiene columna de nota; el ledger es
    // lo que se consulta al revisar un fraccionamiento.
    const skippedSkus = bom.lines
      .filter((line) => execution.skippedOptionalComponents.includes(line.componentVariantId))
      .map((line) => line.sku);
    const skippedNote =
      skippedSkus.length > 0
        ? `Ejecutada sin el insumo opcional faltante: ${skippedSkus.join(", ")}.`
        : null;

    const lotById = new Map(lockedLots.map((lot) => [lot.id, lot]));
    const movementIds: bigint[] = [];
    for (const movement of execution.movements) {
      // Una merma real de 0 es válida (RF-FRA-05 exige declararla, no que sea
      // positiva), pero no hay nada que descontar: el ledger no admite
      // `qty = 0` (CHECK de inventory_movements) ni una capa de costo en cero.
      if (movement.qty.value === 0) continue;

      const lot = lotById.get(movement.lotId);
      if (!lot)
        throw new Error(`el dominio devolvió un movimiento sobre el lote ${movement.lotId}`);

      const movementId = await repo.insertDecantMovement(tx, {
        tenantId: session.tenantId,
        lotId: lot.id,
        variantId: lot.variant_id,
        qty: movement.qty.value,
        uom: movement.qty.uom,
        movementType: movement.movementType,
        totalCostPyg: movement.totalCost.minor,
        workOrderId: order.id,
        createdBy: session.userId,
        note: movement.movementType === "decant_consumption" ? skippedNote : null,
      });
      movementIds.push(movementId);

      // RN-COS: toda salida registra su capa de costo, o el COGS no cierra
      // contra contabilidad. El costo por unidad es el del lote de origen
      // (por ml en el granel); el total es el que calculó el dominio.
      await inventoryRepo.insertCostAllocation(tx, {
        tenantId: session.tenantId,
        movementId,
        lotId: lot.id,
        qty: Math.abs(movement.qty.value),
        unitCostPyg: lot.unit_landed_cost_pyg,
        totalCostPyg: movement.totalCost.minor,
      });
    }

    const done = await repo.markWorkOrderDone(tx, order.id, {
      wasteActual: input.wasteActual,
      executedBy: session.userId,
      executedAt: deps.clock.now(),
    });
    // RN-FRA-03: "liberar la reserva". Los movimientos de arriba son el consumo de
    // verdad; la promesa que los respaldaba (granel e insumos) se suelta entera.
    const reservationsReleased = await releaseReservationsOf(
      tx,
      session,
      DECANT_WORK_ORDER_REFERENCE,
      order.id,
      deps,
    );

    await recordAuditEntry(tx, {
      tenantId: session.tenantId,
      actorId: session.userId,
      audience: session.audience,
      action: "inventory.decant.execute",
      entity: "decant_work_orders",
      entityId: order.id,
      before: { status: order.status, wasteExpected: String(order.waste_expected) },
      after: {
        status: done.status,
        wasteActual: String(input.wasteActual),
        cogsPyg: execution.cogs.minor.toString(),
        movementIds: movementIds.map((id) => id.toString()),
        reservationsReleased,
        skippedOptionalComponentIds: [...execution.skippedOptionalComponents],
      },
      ip: ctx.req.ip,
      userAgent: ctx.req.headers["user-agent"] ?? null,
      requestId: ctx.requestId,
    });

    const movementRows = await inventoryRepo.findMovementsByIds(tx, movementIds);
    return {
      result: {
        order: toAdminDecantWorkOrder(done),
        movements: movementRows.map(toAdminMovement),
        cogs: execution.cogs.minor.toString(),
        costBreakdown: {
          liquid: execution.costBreakdown.liquid.minor.toString(),
          waste: execution.costBreakdown.waste.minor.toString(),
          supplies: execution.costBreakdown.supplies.minor.toString(),
        },
        skippedOptionalComponentIds: [...execution.skippedOptionalComponents],
      },
      statusCode: 200,
    };
  });

  return result;
}

// ---------------------------------------------------------------------
// Cola — RF-FRA-06.
// ---------------------------------------------------------------------
export async function listDecantOrders(
  db: PrismaClient,
  ctx: RequestContext,
  input: ListDecantOrdersInput,
): Promise<ListDecantOrdersOutput> {
  const session = requireStaffContext(ctx);
  return withTenantTx(db, session, async (tx) => ({
    groups: toDecantQueueGroups(await repo.listQueueOrders(tx, input.status)),
  }));
}
