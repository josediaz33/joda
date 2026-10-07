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
  selectLotsByPolicy,
  transitionDecantWorkOrder,
  type BomAvailability,
  type BomLotSnapshot,
  type Clock,
  type DecantError,
  type DecantPlan,
  type DecantWoStatus,
  type LotSnapshot,
} from "@joda/domain";
import type { PrismaClient } from "@joda/db";
import { recordAuditEntry } from "../../db/audit.js";
import { withIdempotentTx } from "../../db/withIdempotentTx.js";
import { withTenantTx, type TenantTx, type TenantTxContext } from "../../db/withTenantTx.js";
import { appError, toTRPCError, type ApiError } from "../../middleware/errorMapper.js";
import { buildIdempotencyRequest } from "../../middleware/idempotency.js";
import type { RequestContext } from "../../trpc/context.js";
import * as inventoryRepo from "../inventory/repository.js";
import { toAdminMovement } from "../inventory/mappers.js";
import { toAdminDecantWorkOrder, toDecantQueueGroups } from "./mappers.js";
import * as repo from "./repository.js";

// Fraccionamiento — WP-C13, RF-FRA-01…06, RN-FRA-01…07, RN-EST-03, ADR-010.
// El dominio decide (`planDecant`, `executeDecant`, la máquina de estados de
// la orden); acá se lee, se bloquea y se persiste, todo en la misma
// transacción. Este módulo NO reserva granel ni insumos: la reserva es de
// WP-C18 (`stock_reservations`) y, hasta entonces, dos órdenes pueden
// comprometer el mismo granel. Tampoco abre frascos: abrir es irreversible
// (ADR-009) y es una decisión de una persona, no un efecto de planificar.

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
function toLotSnapshot(row: repo.LotWithVariantRow): LotSnapshot {
  const uom = row.product_variants.uom;
  return {
    id: row.id,
    receivedAt: row.received_at,
    expiryAt: row.expiry_at,
    available: toQuantity(row.inventory_balances?.on_hand.toNumber() ?? 0, uom),
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
}

interface BomContext {
  readonly lines: readonly BomLine[];
  /** Lotes de insumo consumibles (en `available`, con saldo), de todos los componentes. */
  readonly supplyLots: readonly repo.LotWithVariantRow[];
}

/** Lee el BOM de la variante y los lotes de sus insumos: tres consultas, no una por componente. */
async function loadBom(tx: TenantTx, variantId: string): Promise<BomContext> {
  const components = await repo.listBomComponents(tx, variantId);
  if (components.length === 0) return { lines: [], supplyLots: [] };

  const componentIds = components.map((component) => component.component_variant_id);
  const [labels, supplyLots] = await Promise.all([
    repo.listVariantLabels(tx, componentIds),
    repo.listSupplyLots(tx, componentIds),
  ]);
  const labelById = new Map(labels.map((label) => [label.id, label]));

  const lines = components.map((component): BomLine => {
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
    };
  });

  return { lines, supplyLots };
}

/** Los lotes de un componente que se miden en la misma unidad que pide el BOM, como snapshot. */
function supplySnapshotsOf(line: BomLine, lots: readonly repo.LotWithVariantRow[]): LotSnapshot[] {
  return lots
    .filter(
      (lot) =>
        lot.variant_id === line.componentVariantId && lot.product_variants.uom === line.perUnit.uom,
    )
    .map(toLotSnapshot);
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
 * La orden NACE al confirmar una venta (WP-C19, RN-FRA-01): C19 llama a esta
 * función DENTRO de su transacción de confirmación, así que la orden y la
 * venta se confirman o se revierten juntas. Por eso recibe el `tx` en vez de
 * abrir uno, y lanza `TRPCError` ante lo que rechaza (rollback del llamador).
 *
 * Verifica bajo RLS que la venta, la variante y el lote son del tenant antes
 * de escribir (docs/api-conventions.md §8.4): las FK de Postgres no evalúan
 * RLS. NO valida el estado de la venta ni que tenga una línea de esa variante:
 * es coherencia del flujo de confirmación, que es de C19.
 *
 * No bloquea el granel: planificar no consume ni reserva, solo valida contra
 * el saldo que ve; quien bloquea y decide con el saldo real es la ejecución.
 */
export async function createPlannedWorkOrder(
  tx: TenantTx,
  session: TenantTxContext,
  input: PlanDecantInput,
): Promise<PlannedWorkOrder> {
  if (!(await repo.saleOrderExists(tx, input.saleOrderId))) throw toTRPCError(NOT_FOUND_ERROR);

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

  const bom = await loadBom(tx, variant.id);
  const bomAvailability: BomAvailability[] = bom.lines.map((line) => ({
    componentId: line.componentVariantId,
    available: supplySnapshotsOf(line, bom.supplyLots).reduce(
      (sum, lot) => sum.plus(lot.available),
      Quantity.zero(line.perUnit.uom),
    ),
    perUnit: line.perUnit,
  }));

  // El granel lo elige el servidor salvo que el admin pida uno: el abierto de
  // apertura más antigua que alcance para la orden COMPLETA. Si ninguno
  // alcanza solo se rechaza; nunca se abre un frasco desde acá (irreversible).
  let candidates: repo.LotWithVariantRow[];
  if (input.sourceLotId !== undefined) {
    const lot = await repo.findLotWithVariant(tx, input.sourceLotId);
    if (!lot) throw toTRPCError(NOT_FOUND_ERROR);
    if (lot.variant_id !== sourceVariantId) throw toTRPCError(SOURCE_LOT_VARIANT_MISMATCH_ERROR);
    candidates = [lot];
  } else {
    candidates = await repo.listOpenBulkLots(tx, sourceVariantId);
  }

  let chosen: { lot: repo.LotWithVariantRow; plan: DecantPlan } | undefined;
  let lastShortage: DecantError | undefined;
  let largestAvailableMl = 0;
  for (const lot of candidates) {
    const planned = planDecant({
      unitsRequested: input.qtyUnits,
      mlPerUnit,
      wasteFactor: Percentage.of(wasteFactor),
      bulkLot: toLotSnapshot(lot),
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
  const order = await repo.insertWorkOrder(tx, {
    tenantId: session.tenantId,
    saleOrderId: input.saleOrderId,
    sourceLotId: lot.id,
    targetVariantId: variant.id,
    qtyUnits: input.qtyUnits,
    mlPerUnit,
    mlExpected: plan.mlExpected.value,
    wasteExpected: plan.wasteExpected.value,
    createdBy: session.userId,
  });

  const bomLines = bom.lines.map((line, index): DecantBomLine => ({
    componentVariantId: line.componentVariantId,
    qty: plan.bomToReserve[index]!.qty.value,
    uom: line.perUnit.uom,
    isOptional: line.isOptional,
  }));
  return { order, plan, bom: bomLines };
}

export async function planWorkOrder(
  db: PrismaClient,
  ctx: RequestContext,
  input: PlanDecantInput,
): Promise<PlanDecantOutput> {
  const session = requireStaffContext(ctx);
  const idempotency = buildIdempotencyRequest(ctx.req, input);

  const { result } = await withIdempotentTx(db, session, idempotency, async (tx) => {
    const planned = await createPlannedWorkOrder(tx, session, input);

    await recordAuditEntry(tx, {
      tenantId: session.tenantId,
      actorId: session.userId,
      audience: session.audience,
      action: "inventory.decant.plan",
      entity: "decant_work_orders",
      entityId: planned.order.id,
      before: null,
      after: {
        saleOrderId: input.saleOrderId,
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
    // los ml, no una copia del BOM del momento de planificar.
    const bom = await loadBom(tx, variant.id);

    // Granel y lotes de insumo, bloqueados juntos: UNA sentencia, en orden
    // ascendente de `lot_id` (ver `lockLotsAscending`). Después se relee todo
    // con una sentencia nueva —el saldo que cuenta es el de DESPUÉS del
    // bloqueo— y solo de los lotes bloqueados: lo que aparezca después no se toca.
    //
    // Se bloquean TODOS los lotes con saldo de cada insumo, no solo el que se va
    // a consumir, a propósito: cuál se consume se decide con el saldo ya
    // bloqueado, y bloquear solo el elegido obligaría a leer, elegir, bloquear
    // y volver a verificar. El costo es que una ejecución espera a cualquier
    // otra que toque un lote de esos insumos. Los insumos no se venden (solo los
    // consumen fraccionamientos y ajustes), así que la contención es entre
    // ejecuciones, que de todos modos son manuales. Si se mide y importa, se
    // acota; hoy no está medido.
    const lotIdsToLock = [...new Set([order.source_lot_id, ...bom.supplyLots.map((l) => l.id)])];
    await repo.lockLotsAscending(tx, lotIdsToLock);
    const lockedLots = await repo.findLotsWithVariant(tx, lotIdsToLock);
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
