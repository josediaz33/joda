# Principios de Ingeniería

SOLID, Clean Code y patrones **aplicados a este proyecto**, con ejemplos del dominio real. No es una guía genérica: cada regla acá existe porque hay un lugar concreto del sistema donde romperla cuesta caro.

---

## Parte I — SOLID en este código

### S · Responsabilidad única

> Un módulo cambia por una sola razón.

En este proyecto la responsabilidad se corta por **capa**, no por entidad:

| Módulo                                | Cambia cuando…                      |
| ------------------------------------- | ----------------------------------- |
| `domain/inventory/costing.ts`         | Cambia la regla de costeo           |
| `api/modules/inventory/repository.ts` | Cambia el esquema                   |
| `api/modules/inventory/service.ts`    | Cambia el orden de una operación    |
| `contracts/inventory.ts`              | Cambia el contrato con los clientes |

**Violación típica en un ERP:**

```ts
// ❌ una función que valida, calcula, persiste y notifica
async function venderDecant(input) {
  if (!input.qty) throw new Error('falta cantidad');
  const lote = await prisma.inventoryLot.findFirst({ ... });
  const merma = input.qty * 0.02;
  await prisma.inventoryMovement.create({ ... });
  await enviarEmail(input.clienteEmail);
}
```

Cuatro razones de cambio en catorce líneas. Cuando el negocio pase la merma a tres componentes, hay que tocar la misma función que envía correos.

```ts
// ✅ separado
const parsed = confirmSaleInput.parse(input);        // contracts
const plan   = planDecant({ ... });                  // domain — puro, testeable
await repo.insertMovements(tx, plan.movements);      // repository
await queue.enqueue('notify', { orderId });          // fuera de la transacción
```

**Regla operativa:** si al describir una función necesitás la palabra "y", revisala.

### O · Abierto/cerrado

> Extender sin modificar.

Tres lugares donde este proyecto lo aplica de verdad:

**1. Verticales de producto.** Agregar "velas" no toca `products`, ni las consultas existentes, ni el código de perfumes. Agrega una tabla, un esquema Zod y un mapper de facetas (ver `data-model.md` §8).

**2. Reglas de posteo.** Los asientos se generan desde plantillas declarativas en `posting_rules`, no desde un `switch` por tipo de evento. Agregar el asiento de una devolución es una fila, no un despliegue.

```ts
// ❌ cerrado a la extensión
function generarAsiento(evento) {
  switch (evento.tipo) {
    case 'venta':    return [...];
    case 'compra':   return [...];
    case 'devolucion': return [...];   // hay que editar esta función siempre
  }
}

// ✅ abierto
function buildEntry(rule: PostingRuleTemplate, event: BusinessEvent): JournalEntryDraft
```

**3. Proveedores externos.** `FiscalProvider` y `PaymentProvider` son interfaces. Cambiar de proveedor fiscal es escribir un adaptador nuevo, no tocar ventas.

**Cuándo NO aplicarlo:** no construyas puntos de extensión "por si acaso". Un `strategy` con una sola implementación es complejidad sin beneficio. La regla es: al aparecer la **segunda** variante, extraé la abstracción.

### L · Sustitución de Liskov

> Una implementación no puede exigir más ni prometer menos que su contrato.

El lugar donde importa acá son los adaptadores.

```ts
interface PaymentProvider {
  createCheckout(input: CheckoutInput): Promise<Result<CheckoutSession, PaymentError>>;
}
```

Si el adaptador de Bancard lanza una excepción en lugar de devolver `err(...)`, rompe la sustitución: quien lo use tendrá que saber que es Bancard, y la abstracción deja de servir.

**Los mismos tests de contrato corren contra todos los adaptadores.** Un archivo `paymentProvider.contract.test.ts` parametrizado por implementación.

**Corolario para las verticales:** `perfume_details` y `watch_details` **no** son subtipos intercambiables — tienen atributos distintos y reglas distintas. No las trates como polimórficas: el código que fracciona sabe que trabaja con perfumes.

### I · Segregación de interfaces

> Nadie debe depender de métodos que no usa.

```ts
// ❌ una interfaz que hace todo
interface InventoryRepository {
  findLots();
  insertMovement();
  updateBalance();
  findSuppliers();
  createPurchaseOrder();
  listJournalEntries();
}

// ✅ separadas por caso de uso
interface LotReader {
  findAvailableLots(variantId: string): Promise<LotRow[]>;
}
interface LedgerWriter {
  insertMovements(m: MovementDraft[]): Promise<void>;
}
```

Aplicación concreta: **los DTO públicos y administrativos son esquemas distintos**, no el mismo con campos opcionales. El storefront no debe siquiera poder nombrar `costSummary`.

### D · Inversión de dependencias

> Las políticas no dependen de los detalles.

Esta es la que sostiene toda la arquitectura. `packages/domain` **define** las interfaces; la infraestructura las implementa.

```
packages/domain                    apps/api
  ports/fiscal.ts  ◄──implementa── adapters/fiscal/goekua.ts
  ports/payments.ts ◄──implementa── adapters/payments/bancard.ts
  ports/clock.ts    ◄──implementa── adapters/systemClock.ts
```

La flecha de dependencia apunta **hacia adentro**, siempre. Está impuesta mecánicamente por `eslint-plugin-boundaries`: si `packages/domain` importa Prisma, el build falla.

**Incluye el tiempo y la aleatoriedad.** `Date.now()` y `crypto.randomUUID()` son dependencias externas. En el dominio entran por puerto, y los tests inyectan valores fijos. Un test que depende del reloj real falla solo algún martes, y nadie sabe por qué.

---

## Parte II — Clean Code para este proyecto

### 1. Nombres

**Idioma:** identificadores en inglés; documentación, mensajes de usuario y comentarios en español. El `GLOSARIO.md` mapea ambos. **No mezcles dentro de un identificador:** `calcularWaste` no, `calculateWaste` sí.

**Usá el término del glosario, no un sinónimo.** Si el negocio dice "granel", el código dice `bulk` — no `liquid`, no `openBottle`, no `remainingMl`. Tres nombres para lo mismo es cómo un dominio se vuelve inintelegible.

**Nombres que revelan intención:**

```ts
// ❌
const d = ms * 1.02;
const x = lots.filter((l) => l.s === "a");

// ✅
const mlToReserve = mlExpected.plus(wasteExpected);
const availableLots = lots.filter(isAvailable);
```

**Booleanos afirmativos:** `isDecantable`, `hasStock`, `requiresSerial`. Nunca `notDisabled`.

**Unidades en el nombre cuando hay ambigüedad:** `sizeMl`, `warrantyMonths`, `leadTimeDays`, `pricePyg`. Un `size` a secas obliga a leer la definición.

### 2. Funciones

**Cortas y de un nivel de abstracción.** Si una función mezcla "calcular la merma" con "armar el objeto de la fila de base", partila.

**Máximo tres parámetros posicionales.** Más de eso, objeto con nombres:

```ts
// ❌ imposible de leer en el punto de llamada
planDecant(1, 10, 0.02, 114.65, bomList);

// ✅
planDecant({ unitsRequested: 1, mlPerUnit: 10, wasteFactor, bulkAvailable, bom });
```

**Sin parámetros booleanos.** `execute(order, true)` no dice nada. Dos funciones, o un enum.

**Cláusulas de guarda antes que anidamiento:**

```ts
// ✅
if (!lot) return err(new LotNotFoundError(lotId));
if (lot.status === "depleted") return err(new LotDepletedError(lotId));
if (available.compare(required) < 0) return err(new InsufficientStockError());
// ... camino feliz sin indentar
```

**Sin efectos secundarios ocultos.** Una función llamada `calcularCogs` que además escribe en la base es una trampa para quien la lea después.

### 3. Comentarios

**El código dice el qué; el comentario dice el porqué.**

```ts
// ❌ ruido
// incrementa el contador
counter++;

// ✅ imprescindible
// Orden ascendente de lotId obligatorio: sin él, dos pedidos multi-línea
// que tocan los mismos lotes en orden distinto producen interbloqueo.
const sorted = [...lotIds].sort();
```

**Comentarios obligatorios:**

- Cualquier decisión no obvia que alguien podría "limpiar" en un refactor (el ejemplo de arriba es el caso canónico).
- Referencia a la regla de negocio que implementa una función: `/** RN-FRA-04 · Costo del decant */`.
- Advertencias de rendimiento o concurrencia.

**Prohibidos:** código comentado (para eso está git), `TODO` sin issue asociado, comentarios que repiten la firma.

### 4. Números y textos mágicos

Todo valor con significado de negocio va a una constante nombrada o a la base:

```ts
// ❌
const merma = ml * 0.02;
if (dias > 30) { ... }

// ✅
const merma = wasteFactor.applyTo(ml);            // viene de perfume_details
const RESERVATION_TTL = { checkout: minutes(15), card: minutes(30), transfer: hours(48) };
```

`0.02` en el código es un dato de negocio disfrazado de constante técnica. El día que un perfume tenga otra merma, hay que buscarlo con grep.

### 5. Manejo de errores

Ver `domain-contracts.md` §4. En resumen:

- **Fallo esperado del negocio** (stock insuficiente, transición inválida) → `Result`, no excepción.
- **Bug** (sumar monedas distintas, argumento fuera de rango) → excepción, sin capturar.
- **Nunca `catch` vacío.** Si no vas a hacer nada, no captures.
- **Nunca dejes que un mensaje de PostgreSQL llegue al usuario.**

### 6. DRY, con criterio

Duplicar es malo; acoplar por accidente es peor.

**Se unifica sin dudar:** el redondeo de guaraníes, el cálculo de IVA, el prorrateo, la selección de lotes. Una regla de negocio duplicada es una regla que se va a desincronizar.

**No se unifica:** dos formularios que hoy se parecen y pertenecen a módulos distintos. Extraer un componente compartido entre "alta de producto" y "alta de proveedor" porque ambos tienen un campo nombre crea un acoplamiento que los frena a los dos.

**Prueba:** ¿si cambia uno, tiene que cambiar el otro? Si sí, unificá. Si no, es coincidencia.

### 7. YAGNI, con la excepción del esquema

No construyas lo que no pediste. Pero hay una asimetría que este proyecto asume explícitamente:

|             | Regla                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Código**  | YAGNI estricto. Sin abstracciones especulativas, sin puntos de extensión "por si acaso".                                     |
| **Esquema** | Anticipar. `tenant_id`, las tablas de contabilidad, `fiscal_documents` existen desde el día uno aunque el código no las use. |

Retrofitear un libro mayor o multi-tenancy sobre datos reales en producción es carísimo; crear tablas vacías es gratis.

### 8. Inmutabilidad

`readonly` por defecto en tipos del dominio. Sin mutación de parámetros. Los objetos de valor (`Money`, `Quantity`) devuelven instancias nuevas.

Esto no es preferencia estética: `inventory_movements` es inmutable en la base, y el código que lo maneja debe reflejar esa semántica.

### 9. Formato

Prettier decide. No se discute en revisiones de código.

Nombres de archivo: `camelCase.ts` para módulos, `PascalCase.tsx` para componentes React, `kebab-case.sql` para migraciones con prefijo numérico.

---

## Parte III — Patrones del proyecto

Catálogo de los patrones efectivamente usados. **Usá estos; no introduzcas otros sin un ADR.**

### Ledger y proyección

`inventory_movements` (inmutable, autoritativo) + `inventory_balances` (derivado, verificable). El invariante vive en la proyección; la verdad, en el libro.
**Dónde:** inventario, contabilidad.

### Objeto de valor

`Money`, `Quantity`, `Percentage`. Encapsulan una regla (no sumar monedas distintas) que un tipo primitivo no puede expresar.
**Dónde:** `packages/domain/src/shared/`.

### `Result<T, E>` para fallos de negocio

`{ ok: true; value } | { ok: false; error }` (`shared/result.ts`, `domain-contracts.md` §4.1) para lo que el negocio contempla — nunca para un bug del llamador, que se lanza sin capturar (§4.2). El `E` de cada módulo es una unión de objetos planos con `code` (no una jerarquía de clases como `DomainError`): nadie hace `throw` de un valor de `Result`, así que no necesita la maquinaria de `Error`, y un objeto plano se compara con `toEqual` en los tests sin depender de un mensaje de texto.
**Dónde:** primer ejemplo real, `procurement/freight.ts::allocateFreight` (`FreightError`, WP-A05) — usalo como precedente antes de inventar una forma distinta para el próximo módulo.

### Puerto y adaptador

El dominio define la interfaz; la infraestructura la implementa. Permite arrancar con un adaptador manual y cambiarlo sin tocar el núcleo.
**Dónde:** fiscal, pagos, almacenamiento, reloj.

### Repositorio

Encapsula el acceso a datos detrás de métodos con nombre de negocio. `findAvailableLots(variantId)`, no `prisma.inventoryLot.findMany({...})` esparcido por servicios.
**Dónde:** `apps/api/src/modules/*/repository.ts`.

### Capa anticorrupción

Las filas de la base no son tipos del dominio. Un mapper explícito traduce en ambas direcciones, así el esquema y el dominio pueden evolucionar por separado.
**Dónde:** `apps/api/src/modules/*/mappers.ts`.

### Máquina de estados como dato

Las transiciones son una tabla en TypeScript, no `switch` esparcidos. Se testean exhaustivamente y se documentan solas.
**Dónde:** órdenes de compra, pedidos de venta, órdenes de fraccionamiento, documentos fiscales.

### Clave de idempotencia

Deduplicación por clave única en base, dentro de la misma transacción del efecto. Convierte "el proveedor reintentó" en un no-evento.
**Dónde:** webhooks de pago, mutaciones offline del admin.

### Bandeja de eventos sin procesar

Cuando algo no se puede procesar todavía (regla de posteo apagada, proveedor caído), se registra en una tabla visible en vez de descartarse. Reprocesable y auditable.
**Dónde:** `unposted_events`, cola fiscal.

### Patrón de bandeja de salida (outbox)

Para el modo offline del admin: mutaciones encoladas localmente con clave de idempotencia, enviadas en orden al recuperar conexión. **El stock nunca se resuelve en el cliente.**
**Dónde:** fase 4 de la migración.

### Reserva con vencimiento

Compromiso temporal separado del consumo definitivo, con TTL según el nivel de compromiso del cliente.
**Dónde:** `stock_reservations`.

### Vencimiento futuro como epoch-ms, nunca como `Date`

`packages/domain` no puede construir un `Date` nuevo (`no-restricted-globals` sobre el identificador `Date`, `.claude/rules/domain.md`): una función pura que calcula "esto vence dentro de N minutos/días" no puede devolver ese resultado como `Date`, porque hacerlo requeriría `new Date(...)`. La salida es un `number` (epoch en milisegundos): `startedAt.getTime() + duraciónMs`. Leer con `.getTime()` un `Date` que YA entró por parámetro está permitido (es un método, no una construcción); construir uno nuevo, no. Quien orquesta (con I/O, fuera de `packages/domain`) arma el `Date`/`timestamptz` final a partir de ese número.
**Dónde:** `sales/reservation.ts` (`computeReservationExpiresAt`, `computeManualHoldExpiresAt`, WP-A09). Usalo como precedente antes de que otro módulo necesite devolver un vencimiento calculado.

### Mapeador de errores de Postgres en middleware de tRPC

`docs/api-conventions.md` §4.4 ya definía la forma (`PgError`, `ApiError`, `appError`, `PG_ERROR_MAP` por ERRCODE); lo que este patrón agrega es cómo engancharla a tRPC sin que cada `service`/`repository` tenga que acordarse de llamar al traductor. Tres piezas fijas, no reinventar para el próximo módulo:

1. Un middleware global (`t.procedure.use(...)`, no un middleware por router) atrapa cualquier error de Postgres crudo que se escape sin traducir y lo convierte una sola vez.
2. **Trampa de tRPC v11 — `next()` de un middleware NO relanza el error del resolver como excepción de JS.** Internamente (`callRecursive`, `@trpc/server`) cada nivel de middleware atrapa el throw y lo devuelve como `{ ok: false, error }`, no como una excepción que suba por un `try/catch` alrededor de `await next()`. El middleware tiene que inspeccionar `result.ok`, no envolver `next()` en `try/catch` — eso último compila, no tira ningún error de tipos, y simplemente no hace nada (el error pasa de largo intacto). El error original crudo sobrevive en `result.error.cause` sin envolver, porque `getTRPCErrorFromUnknown` no reenvuelve algo que ya es instancia de `Error`.
3. El `ApiError` ya traducido viaja como `cause` del `TRPCError` que se relanza; el `errorFormatter` de la instancia de tRPC lo reconoce por _duck typing_ (`isApiError`), no por referencia — tRPC envuelve cualquier `cause` que no sea instancia de `Error` en su propio `UnknownCauseError`, que copia las propiedades pero no conserva la identidad del objeto original.

**Dónde:** `apps/api/src/middleware/errorMapper.ts` (`mapPgError`, `appError`, `toTRPCError`, `isApiError`) + `apps/api/src/trpc/trpc.ts` (`catchPgErrors`, `errorFormatter`), WP-C01. El mismo `errorFormatter` también enmascara cualquier error no traducido (`INTERNAL_SERVER_ERROR`) con un mensaje genérico en español — no solo los ERRCODE reconocidos — para que "ningún mensaje de Postgres llega al usuario" se cumpla incluso ante un bug no previsto.

---

## Parte IV — Antipatrones prohibidos

| Antipatrón                                                                                         | Por qué acá es grave                                                                                                       |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Modelo anémico** — entidades que son bolsas de datos y toda la lógica en servicios de 500 líneas | El costeo y el fraccionamiento son el valor del sistema. Si viven repartidos en servicios, no se pueden testear ni reusar. |
| **Lógica de negocio en triggers**                                                                  | Opaca, intestable, y acopla el dominio a PostgreSQL. Ver ADR-017.                                                          |
| **Repositorio genérico** — `findAll`, `findBy(where)`                                              | Traslada las consultas al servicio y hace imposible optimizar o auditar el acceso.                                         |
| **Números de punto flotante para dinero**                                                          | Descuadres que aparecen meses después y nadie puede explicar.                                                              |
| **Estado del pedido como campo editable**                                                          | Permite transiciones inválidas. Se usa una máquina de estados.                                                             |
| **`SELECT *` en producción**                                                                       | Una columna nueva rompe el consumidor de forma sorpresiva.                                                                 |
| **Consultas dentro de un bucle**                                                                   | El clásico N+1. En listados de inventario mata el rendimiento.                                                             |
| **Capturar y registrar sin actuar**                                                                | Convierte un error en un mensaje que nadie lee y un estado inconsistente que nadie detecta.                                |
| **`any` en TypeScript**                                                                            | Prohibido salvo en fronteras con bibliotecas sin tipos, y con comentario que lo justifique.                                |
| **Comentar código en vez de borrarlo**                                                             | Para eso está el control de versiones.                                                                                     |
| **Optimizar sin medir**                                                                            | Sin un perfil que lo respalde, es complejidad gratis.                                                                      |

---

## Parte V — Lista de verificación antes de abrir un PR

- [ ] ¿Alguna función hace más de una cosa?
- [ ] ¿Algún número o texto mágico con significado de negocio?
- [ ] ¿Algún nombre que no está en el glosario o que contradice uno que sí está?
- [ ] ¿`packages/domain` sigue sin importar nada con I/O?
- [ ] ¿Los fallos esperados devuelven `Result` y los bugs lanzan?
- [ ] ¿Los importes usan `Money` y no `number`?
- [ ] ¿Las decisiones no obvias tienen comentario de porqué?
- [ ] ¿Hay tests para el camino feliz **y** para los casos borde de `domain-rules.md`?
- [ ] ¿El código nuevo se apoya en un patrón del catálogo, o introduce uno nuevo sin ADR?
