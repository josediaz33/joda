# Contratos y Fronteras — `packages/domain`

El núcleo del negocio. **Todo lo que este paquete contiene es lógica pura: funciones que reciben datos y devuelven datos.** Es el activo más valioso del proyecto y la parte que sobrevive a cualquier cambio de framework, base de datos o proveedor.

Este documento define qué entra, qué no, y con qué forma.

---

## 1. La regla de pureza

`packages/domain` **no puede importar**:

- Prisma, `pg`, ningún cliente de base de datos
- React, Next.js, Fastify, ningún framework
- `fetch`, `axios`, ningún cliente HTTP
- `fs`, `path`, ningún módulo de sistema
- `process.env`, ninguna configuración de entorno
- `Date.now()`, `new Date()`, `Math.random()`, `crypto.randomUUID()` — no determinismo

**Sí puede importar:** `zod`, `decimal.js` si hiciera falta, y otros paquetes del monorepo que también sean puros.

Esto se impone con `eslint-plugin-boundaries` y falla el build. No es una convención: es una restricción mecánica.

### 1.1 Cómo se resuelve la falta de I/O

**Los datos entran por parámetro.** Si una función necesita los lotes disponibles, los recibe; no los busca.

```ts
// ❌ mal — la función va a buscar datos
async function calcularCogs(variantId: string) {
  const lots = await prisma.inventoryLot.findMany({ ... });
  // ...
}

// ✅ bien — los datos llegan
function calcularCogs(input: { lots: readonly LotSnapshot[]; qty: Quantity }): CostAllocation[] {
  // ...
}
```

**El tiempo y la aleatoriedad entran por puerto.**

```ts
export interface Clock {
  now(): Date;
}
export interface IdGenerator {
  next(): string;
}
```

El servicio de la API los inyecta; los tests inyectan implementaciones fijas. Un test que depende de la hora del reloj real es un test que va a fallar solo algún martes.

---

## 2. Mapa de módulos

```
packages/domain/src/
├── shared/
│   ├── money.ts             Money, Currency, redondeo
│   ├── quantity.ts          Quantity, Uom, aritmética de ml y unidades
│   ├── result.ts            Result<T, E> para fallos esperados
│   ├── errors.ts            jerarquía de errores de dominio
│   ├── stateMachine.ts      motor genérico de máquina de estados
│   └── ports.ts             Clock, IdGenerator
├── catalog/
│   ├── variant.ts           reglas de coherencia de variantes
│   └── facets.ts            proyección de facetas desde detalles tipados
├── inventory/
│   ├── allocation.ts        selección de lotes por política
│   ├── costing.ts           capas de costo, FIFO, promedio ponderado
│   ├── balance.ts           disponible = saldo − reservas
│   └── lotOpening.ts        conversión sellado → granel
├── decant/
│   ├── planning.ts          cálculo de reserva y orden de fraccionamiento
│   ├── execution.ts         movimientos de la ejecución
│   ├── waste.ts             los tres componentes de merma
│   ├── availability.ts      disponibilidad de variante bajo pedido
│   └── workOrder.ts         máquina de estados de la orden de fraccionamiento
├── procurement/
│   ├── landedCost.ts        costo puesto
│   ├── freight.ts           prorrateo de flete
│   └── purchaseOrder.ts     máquina de estados
├── sales/
│   ├── order.ts             máquina de estados, totales
│   ├── pricing.ts           precio por canal, descuentos
│   ├── reservation.ts       TTL por medio de pago
│   └── deposit.ts           señas: aplicación, límites
├── tax/
│   └── vat.ts               IVA sobre precio incluido, diferencias de redondeo
├── accounting/
│   ├── posting.ts           motor de reglas de posteo
│   └── entry.ts             construcción y cuadre de asientos
└── ports/
    ├── fiscal.ts            FiscalProvider
    ├── payments.ts          PaymentProvider
    └── storage.ts           ObjectStorage
```

---

## 3. Objetos de valor

Los tipos primitivos no alcanzan para representar dinero ni cantidades. Un `number` puede sumarse con cualquier otro `number`, y ahí es donde nacen los descuadres.

### 3.1 `Money`

```ts
export type Currency = "PYG" | "USD" | "BRL" | "ARS";

export class Money {
  private constructor(
    readonly minor: bigint,
    readonly currency: Currency,
  ) {}

  static pyg(units: bigint): Money;
  static of(minor: bigint, currency: Currency): Money;
  static zero(currency: Currency): Money;

  plus(other: Money): Money; // lanza CurrencyMismatchError
  minus(other: Money): Money;
  times(factor: number): Money; // redondea con roundPyg
  allocate(weights: number[]): Money[]; // reparto sin perder unidades

  isZero(): boolean;
  isNegative(): boolean;
  compare(other: Money): -1 | 0 | 1;

  toJSON(): { minor: string; currency: Currency };
}
```

**`allocate` es clave para el prorrateo:** reparte un importe entre pesos garantizando que la suma de las partes es exactamente el total. Sin él, el flete prorrateado pierde o gana unidades por redondeo.

### 3.2 `Quantity`

```ts
export type Uom = "unit" | "ml";

export class Quantity {
  private constructor(
    readonly value: number,
    readonly uom: Uom,
  ) {}

  static units(n: number): Quantity; // entero, lanza si tiene decimales
  static ml(n: number): Quantity; // hasta 3 decimales

  plus(other: Quantity): Quantity; // lanza UomMismatchError
  minus(other: Quantity): Quantity;
  times(factor: number): Quantity;

  isNegative(): boolean;
  compare(other: Quantity): -1 | 0 | 1;
}
```

`Quantity.units(1.5)` lanza. Media unidad de reloj no existe.

### 3.3 `Percentage`

```ts
export class Percentage {
  static of(value: number): Percentage; // 0.02 = 2%, rango [0, 1]
  applyTo(q: Quantity): Quantity;
}
```

---

## 4. Manejo de errores

Dos categorías, tratadas distinto.

### 4.1 Fallos esperados del dominio → `Result`

Situaciones que el negocio contempla: stock insuficiente, seña sobre-aplicada, transición de estado inválida. **No son excepciones: son respuestas.**

```ts
export type Result<T, E = DomainError> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
```

```ts
export function planDecant(input: DecantPlanInput): Result<DecantPlan, DecantError> {
  if (input.bulkAvailable.compare(required) < 0) {
    return err(new InsufficientBulkError(required, input.bulkAvailable));
  }
  // ...
  return ok(plan);
}
```

La capa de API traduce el error a un código HTTP y un mensaje para el usuario.

### 4.2 Errores de programación → excepción

Invariantes violados que indican un bug: sumar monedas distintas, cantidad con unidad incompatible, argumento fuera de rango. Lanzan y no se capturan.

```ts
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export class CurrencyMismatchError extends DomainError {
  /* ... */
}
export class UomMismatchError extends DomainError {
  /* ... */
}
```

**Regla:** si el usuario puede provocarlo con una acción legítima, es `Result`. Si solo lo provoca un bug, es excepción.

---

## 5. Puertos

Un puerto es una interfaz que el dominio define y que la infraestructura implementa. Permite cambiar de proveedor sin tocar el núcleo.

```ts
// ports/fiscal.ts
export interface FiscalProvider {
  issue(doc: FiscalDocumentDraft): Promise<Result<FiscalIssueResult, FiscalError>>;
  cancel(cdc: string, reason: string): Promise<Result<void, FiscalError>>;
  status(cdc: string): Promise<Result<FiscalStatus, FiscalError>>;
}

// ports/payments.ts
export interface PaymentProvider {
  readonly name: string;
  createCheckout(input: CheckoutInput): Promise<Result<CheckoutSession, PaymentError>>;
  verify(externalRef: string): Promise<Result<PaymentVerification, PaymentError>>;
  refund(externalRef: string, amount: Money): Promise<Result<void, PaymentError>>;
}

// ports/storage.ts
export interface ObjectStorage {
  put(key: string, body: Uint8Array, opts: PutOptions): Promise<string>;
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
}
```

Los adaptadores viven en `apps/api/src/adapters/`. El dominio nunca los conoce.

**Nota sobre asincronía:** los puertos son `async` porque la implementación lo será. Las funciones de cálculo del dominio **no lo son**: si escribiste `async function` en `domain/inventory/costing.ts`, algo está mal.

---

## 6. Contratos por módulo

Firmas de referencia. Los tipos exactos viven en el código; esto define la forma y la responsabilidad.

### 6.1 Costeo

```ts
export interface LotSnapshot {
  id: string;
  receivedAt: Date;
  expiryAt: Date | null;
  available: Quantity;
  unitCost: Money;
  status: "available" | "open_for_decant" | "quarantine" | "damaged" | "depleted";
}

/** Selecciona lotes según política y devuelve las capas a consumir. */
export function allocateFromLots(input: {
  lots: readonly LotSnapshot[];
  required: Quantity;
  policy: AllocationPolicy;
}): Result<CostLayer[], AllocationError>;

export interface CostLayer {
  lotId: string;
  qty: Quantity;
  unitCost: Money;
  totalCost: Money;
}

/** Suma las capas. Invariante: igual al costo declarado del movimiento. */
export function totalCost(layers: readonly CostLayer[]): Money;
```

**Costo puesto de una recepción** (RN-COS-01, RN-COS-03; `procurement/landedCost.ts`, WP-A05):

```ts
export interface LandedCostComponents {
  /** Precio del proveedor, en la moneda extranjera de la recepción. */
  supplierPrice: Money;
  freight?: Money;
  customsClearance?: Money;
  /** Incluye impuestos/aranceles y comisiones — GLOSARIO.md "Costo puesto / landed cost" — hasta que el motor de posteo (Bloque H) necesite cuentas contables separadas. */
  other?: Money;
}

/** RN-COS-01 · (precio + flete + despacho + otros) × fx REAL de la recepción, sumado en la moneda extranjera y convertido una sola vez. */
export function computeLandedCost(input: {
  components: LandedCostComponents;
  fxRateToPyg: number;
}): Money;

/** RN-COS-03 · costo puesto / cantidad inicial del lote. */
export function computeUnitLandedCost(landedCostPyg: Money, qtyInitial: Quantity): Money;
```

Todos los componentes de `LandedCostComponents` deben compartir moneda con `supplierPrice`; mezclar monedas lanza `CurrencyMismatchError` (RN-DIN-03). `fxRateToPyg` no positivo/finito o `qtyInitial` no positivo lanzan `InvalidLandedCostInputError` — son argumentos fuera de rango (§4.2), no un fallo que el negocio contemple.

### 6.2 Fraccionamiento

```ts
export function planDecant(input: {
  unitsRequested: number;
  mlPerUnit: number;
  wasteFactor: Percentage;
  bulkAvailable: Quantity;
  bomAvailability: readonly { componentId: string; available: Quantity; perUnit: Quantity }[];
}): Result<DecantPlan, DecantError>;

export interface DecantPlan {
  mlExpected: Quantity;
  wasteExpected: Quantity;
  mlToReserve: Quantity;
  bomToReserve: readonly { componentId: string; qty: Quantity }[];
}

export function executeDecant(input: {
  plan: DecantPlan;
  wasteActual: Quantity;
  bulkLot: LotSnapshot;
  bomLots: readonly BomLotSnapshot[];
}): Result<DecantExecution, DecantError>;

export interface DecantExecution {
  movements: readonly MovementDraft[]; // consumo, merma, BOM
  cogs: Money;
  costBreakdown: { liquid: Money; waste: Money; supplies: Money };
}

export function decantAvailability(input: {
  bulkAvailable: Quantity;
  mlPerUnit: number;
  wasteFactor: Percentage;
  bom: readonly { available: Quantity; perUnit: Quantity }[];
}): number;
```

### 6.3 IVA

```ts
export type VatRate = "iva_10" | "iva_5" | "exenta";

/** IVA contenido en un precio con impuesto incluido. */
export function vatFromGross(gross: Money, rate: VatRate): Money;

/** Base gravada = total − IVA. Garantiza base + iva = total. */
export function taxBase(gross: Money, rate: VatRate): Money;

/**
 * Desglosa un documento completo, imputando la diferencia de redondeo
 * a la última línea de cada tasa. Ver RN-IVA-03.
 */
export function breakdownDocument(
  lines: readonly { gross: Money; rate: VatRate }[],
): DocumentVatBreakdown;

export interface DocumentVatLine {
  gross: Money;
  rate: VatRate;
  vat: Money;
  base: Money;
  /** RN-IVA-03: lo que esta línea recibió por ser la última de su tasa, ya incluido en `vat`. Cero si no hubo ajuste. */
  roundingAdjustment: Money;
}

export interface DocumentVatBreakdown {
  lines: readonly DocumentVatLine[];
  totalGross: Money;
  totalVat: Money;
  totalBase: Money;
}
```

### 6.4 Prorrateo de flete

```ts
export function allocateFreight(input: {
  freight: Money;
  method: FreightMethod;
  lines: readonly {
    id: string;
    value: Money;
    qty: Quantity;
    volume?: number;
    /** Requerido si `method` es `"manual"`; ignorado en los demás. */
    manualAmount?: Money;
  }[];
}): Result<ReadonlyMap<string, Money>, FreightError>;
```

`by_value`, `by_unit` y `by_volume` reparten con **el mismo algoritmo — `Money.allocate`** (§3.1): la suma de las partes es exactamente el flete total, siempre, sin caso especial por método. Lo único que cambia es el peso que cada uno le pasa a `allocate` — `value.minor`, `qty.value` o `volume`, respectivamente —, y ese peso es la **magnitud cruda de la línea**, nunca una proporción ya calculada: `Money.allocate` admite hasta 6 decimales por peso (ver su JSDoc en `shared/money.ts`), así que una proporción periódica (`1/3`) lo haría fallar donde la magnitud cruda no.

Cada método proporcional valida solo lo que su propio peso necesita antes de repartir: `by_value` exige que todas las líneas compartan `value.currency` (`LINE_CURRENCY_MISMATCH` si no — RN-DIN-03, la magnitud no es comparable entre monedas distintas); `by_unit` exige que todas compartan `qty.uom` (`LINE_UOM_MISMATCH` si no — ADR-009); `by_volume` exige que todas traigan `volume` (`MISSING_VOLUME` si no). Un total de pesos en cero (todas las líneas en cero) es `ZERO_TOTAL_WEIGHT`, no una excepción de `Money.allocate`: es un dato de negocio posible, no un bug.

`manual` no prorratea: el llamador ya decidió `manualAmount` para cada línea; `allocateFreight` solo valida que la suma de esos montos sea igual a `freight` y devuelve `FreightError` si no coincide — no ajusta nada por detrás. Ver RN-COS-02.

### 6.5 Máquinas de estado (WP-A08)

Tres entidades, tres máquinas — orden de compra (`procurement/purchaseOrder.ts`), pedido de venta (`sales/order.ts`), orden de fraccionamiento (`decant/workOrder.ts`) — construidas sobre el mismo motor genérico, `shared/stateMachine.ts::defineStateMachine`. Las transiciones son **datos** (un `Record<Status, readonly Status[]>`), no `switch` esparcidos: así se testean exhaustivamente y se documentan solas. El criterio que gobierna las tres salidas laterales está en `docs/domain-rules.md` RN-EST-01…03: **se cancela mientras no haya efectos irreversibles; una vez que hay movimientos de inventario o cobro, se revierte, no se cancela.**

```ts
export const PURCHASE_ORDER_TRANSITIONS: Readonly<Record<PoStatus, readonly PoStatus[]>> = {
  draft: ["pending_approval", "cancelled"],
  pending_approval: ["approved", "draft", "cancelled"],
  approved: ["sent", "cancelled"],
  sent: ["partially_received", "received", "cancelled"],
  partially_received: ["partially_received", "received"],
  received: [],
  cancelled: [],
};

export const SALE_ORDER_TRANSITIONS: Readonly<Record<SaleOrderStatus, readonly SaleOrderStatus[]>> =
  {
    draft: ["awaiting_payment", "cancelled"],
    awaiting_payment: ["paid", "cancelled"],
    paid: ["preparing", "cancelled", "refunded"],
    preparing: ["ready", "refunded"],
    ready: ["shipped", "refunded"],
    shipped: ["delivered", "refunded"],
    delivered: ["refunded"],
    cancelled: [],
    refunded: [],
  };

export const DECANT_WORK_ORDER_TRANSITIONS: Readonly<
  Record<DecantWoStatus, readonly DecantWoStatus[]>
> = {
  pending: ["in_progress", "cancelled"],
  in_progress: ["done", "cancelled"],
  done: [],
  cancelled: [],
};
```

**`partially_received` NO admite `cancelled`** (RN-EST-01) — a diferencia de una versión anterior de este contrato, que sí lo permitía: ya entró mercadería y hay lotes creados a partir de la recepción; revertir eso es una devolución a proveedor, no una cancelación de la OC. Corregido en el mismo PR que implementó WP-A08.

Cada máquina expone `canTransition` / `transition` con la firma genérica de `StateMachine<S>` (`shared/stateMachine.ts`):

```ts
export function canTransition(from: S, to: S): boolean;
export function transition(from: S, to: S): Result<S, TransitionError<S>>;
```

En el código, estas dos funciones llevan el sufijo de la entidad (`canTransitionPurchaseOrder`, `canTransitionSaleOrder`, `canTransitionDecantWorkOrder`, e igual con `transition*`) — no el nombre a secas que muestra el ejemplo de arriba. `packages/domain/src/index.ts` junta `procurement/`, `sales/` y `decant/` en un solo barrel con `export *`, y las tres máquinas colisionarían en el mismo nombre.

### 6.6 Motor de posteo

```ts
export function buildEntry(input: {
  rule: PostingRuleTemplate;
  event: BusinessEvent;
  accounts: ReadonlyMap<string, AccountRef>;
}): Result<JournalEntryDraft, PostingError>;

/** Verifica el cuadre antes de que lo haga la base. Falla rápido. */
export function assertBalanced(entry: JournalEntryDraft): Result<void, UnbalancedEntryError>;
```

---

## 7. Cómo la API consume el dominio

Patrón de tres pasos en todo servicio:

```ts
// apps/api/src/modules/sales/service.ts
export async function confirmSale(ctx: Ctx, orderId: string) {
  return ctx.db.$transaction(async (tx) => {
    // 1. LEER — la infraestructura obtiene los datos
    const order = await repo.findOrderForUpdate(tx, orderId);
    const lots = await repo.findAvailableLots(tx, order.variantIds);

    // 2. DECIDIR — el dominio calcula, sin tocar nada
    const layers = allocateFromLots({
      lots: lots.map(toLotSnapshot),
      required: Quantity.units(order.qty),
      policy: order.allocationPolicy,
    });
    if (!layers.ok) throw toHttpError(layers.error);

    // 3. ESCRIBIR — la infraestructura persiste la decisión
    await repo.insertMovements(tx, layers.value);
    await repo.insertCostAllocations(tx, layers.value);
    await repo.updateOrderStatus(tx, orderId, "paid");
  });
}
```

**Leer, decidir, escribir.** Si un servicio mezcla los tres pasos, la lógica se vuelve intestable y termina consultando la base dentro de un bucle.

### 7.1 Capa anticorrupción

Las filas de la base **no son** tipos del dominio. Se mapean explícitamente:

```ts
// apps/api/src/modules/inventory/mappers.ts
export function toLotSnapshot(row: InventoryLot & { balance: InventoryBalance }): LotSnapshot {
  return {
    id: row.id,
    receivedAt: row.receivedAt,
    expiryAt: row.expiryAt,
    available: Quantity.ml(Number(row.balance.onHand)), // conversión explícita
    unitCost: Money.pyg(row.unitLandedCostPyg),
    status: row.status,
  };
}
```

Esto permite refactorizar el esquema sin tocar el dominio, y viceversa.

---

## 8. Obligaciones de prueba

| Módulo                            | Cobertura mínima | Por qué                                  |
| --------------------------------- | ---------------- | ---------------------------------------- |
| `shared/money`, `shared/quantity` | 100%             | Todo lo demás depende de esto            |
| `tax/vat`                         | 100%             | Un error acá rechaza documentos fiscales |
| `inventory/costing`               | 100%             | Un error acá descuadra la contabilidad   |
| `decant/*`                        | 100%             | Es la ventaja competitiva del negocio    |
| `procurement/freight`             | 100%             | Determina el margen de todo              |
| Resto del paquete                 | ≥ 90%            |                                          |

Cada test referencia la regla que verifica:

```ts
describe("RN-IVA-03 · diferencia de redondeo", () => {
  it("imputa la diferencia a la última línea de la tasa", () => {
    const lines = [
      { gross: Money.pyg(33_333n), rate: "iva_10" as const },
      { gross: Money.pyg(33_333n), rate: "iva_10" as const },
      { gross: Money.pyg(33_333n), rate: "iva_10" as const },
    ];
    const r = breakdownDocument(lines);
    expect(r.lines.map((l) => l.vat.minor)).toEqual([3030n, 3030n, 3031n]);
    expect(r.totalVat.minor).toBe(9091n);
  });
});
```

### 8.1 Dataset dorado

`packages/domain/test/golden/` contiene ~20 operaciones reales del negocio con resultados calculados a mano y verificados contra la operación histórica: una compra completa con flete, una apertura de frasco, un fraccionamiento, una venta mixta, una devolución.

Corre en cada PR. **Es lo que permite refactorizar el costeo sin miedo.**

---

## 9. Qué NO va en `packages/domain`

| No va                                 | Dónde va                               |
| ------------------------------------- | -------------------------------------- |
| Consultas a la base                   | `apps/api/src/modules/*/repository.ts` |
| Orquestación de transacciones         | `apps/api/src/modules/*/service.ts`    |
| Validación de entrada HTTP            | `packages/contracts` (esquemas Zod)    |
| Formateo para mostrar (`Gs. 245.000`) | `packages/ui`                          |
| Llamadas a proveedores externos       | `apps/api/src/adapters/`               |
| Configuración y secretos              | `apps/api/src/config.ts`               |
| Textos de interfaz                    | `apps/*/locales`                       |

**Prueba rápida:** si una función de `packages/domain` no puede ejecutarse en un test sin levantar nada, está mal ubicada.
