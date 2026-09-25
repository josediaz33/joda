# Playbook de Prompts

Cómo avanzar el proyecto sesión por sesión después del prompt maestro. Cada prompt está listo para copiar.

**Regla de oro: una sesión, un paquete de trabajo.** El backlog está dimensionado para eso. Sesiones que abarcan tres paquetes producen PRs que nadie puede revisar y decisiones que nadie tomó conscientemente.

---

## 1. Anatomía de un buen prompt de tarea

El punto 0 va primero, y va aparte de los otros cinco, porque es lo único de toda la lista que hay que hacer ANTES de leer siquiera la documentación: no depende de qué WP es, no depende de qué dice `CLAUDE.md`, no depende de nada — se hace primero o se termina trabajando sobre `main` (ver CONTRIBUTING.md §2 sobre por qué eso sale caro).

`CLAUDE.md` se carga solo en cada sesión y ya lleva las reglas permanentes. El prompt de la tarea solo tiene que aportar seis cosas:

```
0. RAMA          crearla antes de tocar cualquier archivo
1. QUÉ LEER      los documentos específicos del área (CLAUDE.md no los carga)
2. QUÉ HACER     el identificador del paquete, no una descripción libre
3. CUÁNDO ESTÁ   el criterio de aceptación, repetido explícitamente
4. TRAMPAS       lo que este agente probablemente va a hacer mal en esta área
5. LÍMITE        el alcance, y qué hacer si crece
```

El punto 4 es el que más rinde. Cada área tiene un error predecible: en dinero es usar `number`, en la API es olvidar el tercer parámetro de `set_config`, en el esquema es correr `prisma migrate`. Anticiparlo cuesta dos líneas y ahorra una sesión.

**No repitas lo que ya está en `CLAUDE.md`.** Si el prompt empieza a parecerse a la documentación, la documentación no se está leyendo.

---

## 2. Secuencia de arranque

**La numeración es orientativa, no un contrato.** Marca un orden de trabajo razonable, no una promesa de que cada paquete ocupa exactamente una sesión. Si uno termina llevando dos, anotalo como tal (`Sesión 11 y 11b`, por ejemplo) en vez de correr la numeración de todo lo que sigue — renumerar entero por cada ajuste es más trabajo que valor.

### Sesión 1 — Andamiaje

El `PROMPT_MAESTRO.md`. Solo estructura, colocación de documentos y commit inicial. Sin código.

---

### Sesión 2 — WP-A01 · Monorepo base

```
Antes de tocar nada: git checkout -b feat/a01-monorepo-base

Tomá WP-A01 del backlog.

Leé primero: CLAUDE.md, CONTRIBUTING.md, docs/engineering-principles.md,
docs/backlog.md (solo el bloque A).

Objetivo: monorepo funcional con pnpm workspaces, Turborepo, tsconfig
compartido, ESLint con eslint-plugin-boundaries y Prettier. Los scripts
pnpm de CLAUDE.md tienen que existir, aunque algunos todavía no hagan nada.

Criterio de aceptación: `pnpm install && pnpm typecheck && pnpm lint`
en verde.

TRAMPA DE ESTA TAREA: la regla de fronteras no es una convención, es una
restricción mecánica. Configurá eslint-plugin-boundaries de modo que el
BUILD FALLE si packages/domain importa Prisma, React, cualquier framework,
fetch, fs, process.env, Date o crypto. Agregá un archivo de prueba que
viole la regla, verificá que el lint falla, y después borralo. Si no lo
demostraste, no está hecho.

Alcance: solo WP-A01. Sin código de dominio, sin apps funcionando más allá
del esqueleto. Si el alcance crece, pará y consultá.
```

---

### Sesión 3 — WP-A03 · Objetos de valor

```
Antes de tocar nada: git checkout -b feat/a03-domain-value-objects

Tomá WP-A03 del backlog.

Leé primero: docs/domain-contracts.md (secciones 1, 3 y 4),
docs/domain-rules.md (RN-DIN completo), docs/testing-strategy.md.

Objetivo: Money, Quantity, Percentage, Result y la jerarquía de errores
en packages/domain/src/shared/.

Criterio de aceptación: 100% de cobertura de líneas y ramas. Sumar monedas
distintas falla. Quantity.units(1.5) falla. Y una prueba basada en
propiedades con fast-check que demuestre que Money.allocate reparte sin
perder ni ganar unidades, para cualquier total y cualquier conjunto de pesos.

TRAMPAS DE ESTA TAREA:
· allocate es el método que sostiene todo el prorrateo. Si la suma de las
  partes no da exactamente el total, el flete y el IVA van a descuadrar
  meses después sin que nadie sepa por qué.
· El guaraní es bigint. No number, no numeric, no decimal.js para PYG.
· Result es para fallos que el negocio contempla; las excepciones son para
  bugs. Si dudás, releé domain-contracts.md sección 4.

Alcance: solo shared/. Nada de costeo ni de IVA todavía.
```

---

### Sesión 4 — WP-A04 · IVA

```
Antes de tocar nada: git checkout -b feat/a04-tax-vat

Tomá WP-A04 del backlog.

Leé primero: docs/domain-rules.md (RN-IVA completo), docs/domain-contracts.md
(sección 6.3).

Objetivo: packages/domain/src/tax/vat.ts — IVA sobre precio con impuesto
incluido, base gravada, y desglose de documento con imputación de la
diferencia de redondeo.

Criterio de aceptación: RN-IVA-01 a RN-IVA-04 con un test cada uno,
referenciando la regla en el describe. El caso de tres líneas de Gs. 33.333
al 10% tiene que dar [3030, 3030, 3031] por línea y 9091 de total.

TRAMPAS DE ESTA TAREA:
· En Paraguay el IVA se EXTRAE del precio, no se agrega. 10% es total/11,
  no total*0.10. Si escribiste una multiplicación por 0.10, está mal.
· El redondeo se resuelve a nivel de DOCUMENTO, no de línea.
· La base gravada es total − IVA, nunca un cálculo independiente. Así
  base + IVA = total siempre, exacto.

Alcance: solo tax/. Un PR.
```

---

### Sesión 5 — WP-A05 · Costo puesto y flete

```
Antes de tocar nada: git checkout -b feat/a05-procurement-landed-cost

Tomá WP-A05 del backlog.

Leé primero: docs/domain-rules.md (RN-COS-01 a RN-COS-03),
docs/domain-contracts.md (sección 6.4), ADR-008.

Objetivo: packages/domain/src/procurement/ — landedCost.ts y freight.ts
con los cuatro métodos de prorrateo.

Criterio de aceptación: el ejemplo del frasco (USD 190 + 15 de flete,
dólar a 7300) da 1.496.500 Gs. El prorrateo de Gs. 300.000 sobre líneas
de 1.000.000 / 500.000 / 200.000 da 176.471 / 88.235 / 35.294 y suma
exactamente 300.000.

TRAMPA DE ESTA TAREA: usá Money.allocate de WP-A03 para el reparto. Si
implementás el prorrateo con multiplicaciones y round() sueltos, vas a
perder unidades y el test de propiedades que ya escribiste te lo va a
decir. El tipo de cambio es el REAL de la recepción, no el estimado de
la orden.

Alcance: solo procurement/. No toques inventario todavía.
```

---

### Sesión 6 — WP-A06 · Selección de lotes y capas de costo

```
Antes de tocar nada: git checkout -b feat/a06-inventory-allocation

Tomá WP-A06 del backlog.

Leé primero: docs/domain-rules.md (RN-COS-04, RN-COS-05, RN-LOT-05),
docs/domain-contracts.md (sección 6.1), ADR-007 y ADR-008.

Objetivo: packages/domain/src/inventory/ — allocation.ts (selección por
política) y costing.ts (capas de costo).

Criterio de aceptación: el caso FIFO de dos capas del documento de reglas
da 4.350.000 con dos filas de asignación, no un promedio. Las cuatro
políticas (fifo, fefo, serial, manual) con test cada una. Empate desempatado
por id ascendente.

TRAMPAS DE ESTA TAREA:
· Una salida puede consumir varios lotes con costos distintos. Devolvé las
  capas, no un costo promedio.
· FEFO: los lotes sin fecha de vencimiento van al final, no al principio.
· El orden de retorno importa: es el orden en que la API va a bloquear,
  y tiene que ser determinístico.

Alcance: solo inventory/. El fraccionamiento es WP-A07.
```

---

### Sesión 7 — WP-A07 · Fraccionamiento

```
Tomá WP-A07 del backlog.

Leé primero: docs/domain-rules.md (RN-FRA completo y RN-LOT-02),
docs/domain-contracts.md (sección 6.2), ADR-009 y ADR-010, GLOSARIO.md
(entradas de fraccionamiento).

Objetivo: packages/domain/src/decant/ — planning, execution, waste,
availability.

Criterio de aceptación: el caso Layton completo da COGS 131.210, desglosado
en 119.720 de líquido, 4.190 de merma y 7.300 de insumos. La disponibilidad
con 114,65 ml de granel y decant de 10 ml al 2% da 11 unidades.
Los casos borde 1 a 4 del catálogo de domain-rules.md con test cada uno.

TRAMPAS DE ESTA TAREA — es la parte más delicada del sistema:
· El decant tiene DOS momentos. planDecant calcula la reserva;
  executeDecant recibe la merma REAL y produce los movimientos. No los
  colapses en una función.
· La merma tiene TRES componentes, no uno. El porcentaje sirve para
  reservar; el fondo no recuperable se aplica al agotar el frasco.
· El BOM no es opcional: un decant consume líquido más vial más atomizador
  más etiqueta. Si el COGS no incluye insumos, el margen está mal.
· La disponibilidad es el mínimo entre lo que da el líquido y lo que dan
  los insumos.
· El caso borde 5 (abrir un frasco ya abierto) NO es de decant/: es la
  conversión de apertura de lote, RN-LOT-02 y ADR-009, y vive en
  inventory/lotOpening.ts. Lo cubre WP-A13. Abrir un frasco no es
  fraccionarlo.

Alcance: solo decant/. Un PR.
```

---

### Sesión 8 — WP-A02 · CI

```
Antes de tocar nada: git checkout -b feat/a02-ci-pipeline

Tomá WP-A02 del backlog.

Leé primero: CONTRIBUTING.md (§1 Hooks de Git, §10 Despliegue),
docs/backlog.md ("Riesgo conocido para A02", debajo de la tabla del bloque A).

Objetivo: esqueleto de los tres apps (`storefront`, `admin`, `api`) con un
"hola mundo" cada uno, y el pipeline de CI corriendo sobre eso.

Criterio de aceptación: `pnpm build` produce los tres artefactos; el CI
corre en un PR; con el pipeline ya existente, queda evaluado con José si
conviene GitHub Pro y activar `required_status_checks` del lado del
servidor con los nombres de los jobs (hoy `main` solo tiene el hook local
`pre-push`, ver CONTRIBUTING.md §10).

TRAMPAS DE ESTA TAREA:
· Esto está vencido, no es una tarea más: sin pipeline, siete PR ya se
  verificaron a mano, y así `format:check` quedó roto sin que nadie lo
  viera y la verificación salió por fuera de `turbo` dos veces.
· El pipeline corre por `turbo run`, no por binarios sueltos a mano.
  Si `turbo` no encuentra `pnpm` como ejecutable real en el `PATH` del
  runner, cualquier job falla con "Unable to find package manager binary"
  aunque `corepack pnpm <comando>` funcione bien — la nota de riesgo del
  backlog ya trae el workaround verificado, no lo redescubras de cero.
· No incluye Lighthouse CI: eso es WP-G02, posterior al storefront. Acá
  solo typecheck, lint, `format:check`, test y build.
· GitHub Pro es una decisión de cuenta y de costo, no del agente: dejala
  evaluada y propuesta, no activada por tu cuenta.

Alcance: los tres jobs de CI (typecheck+lint+format:check, test, build)
sobre el esqueleto de los tres apps, más la evaluación de GitHub Pro —
activar `required_status_checks` en sí queda para después de que José lo
confirme, no es parte de esta sesión. Si el alcance crece, pará y consultá.
```

---

### Sesión 9 — WP-A13 · Apertura de frasco (`lotOpening`)

```
Antes de tocar nada: git checkout -b feat/a13-lot-opening

Tomá WP-A13 del backlog.

Leé primero: .claude/rules/domain.md, docs/domain-rules.md (RN-LOT-02,
RN-LOT-03), ADR-009, GLOSARIO.md (entrada "Apertura de frasco").

Objetivo: packages/domain/src/inventory/lotOpening.ts — la conversión
sellado → granel al abrir un frasco.

Criterio de aceptación: RN-LOT-02 y RN-LOT-03 con test cada una. El caso
borde 5 del catálogo de docs/domain-rules.md (abrir un lote ya abierto se
rechaza) con su propio test.

TRAMPAS DE ESTA TAREA:
· No es un cambio de estado, es una CONVERSIÓN entre dos lotes (ADR-009):
  cuatro pasos en una sola transacción — `transfer_out` del sellado,
  `status → open_for_decant`, alta del lote de granel hijo con
  `parent_lot_id`, `transfer_in` del granel. No lo colapses en un simple
  `UPDATE` de estado.
· El lote sellado padre TAMBIÉN queda en `open_for_decant`, igual que el
  granel hijo recién nacido — no es un error tuyo, es el resultado
  correcto de este mismo WP. Los dos lotes van a compartir `status`, y eso
  es exactamente lo que `LotSnapshot` (`inventory/allocation.ts`) todavía
  no puede distinguir. No lo arregles acá: es WP-A15, la sesión siguiente.
· El costo se hereda ÍNTEGRO al granel
  (`unit_landed_cost_pyg = round_pyg(landed_cost_pyg / nominal_volume_ml)`),
  no se recalcula desde ningún otro dato.

Alcance: solo lotOpening.ts. La distinción sellado-recién-abierto vs.
granel en LotSnapshot es WP-A15, no de esta sesión.
```

---

### Sesión 10 — WP-A15 · Completar la validación de origen del granel

```
Antes de tocar nada: git checkout -b feat/a15-bulk-lot-origin-validation

Tomá WP-A15 del backlog.

Leé primero: .claude/rules/domain.md, docs/backlog.md (las notas de A07 y
A15 debajo de la tabla del bloque A — son la especificación real de esta
tarea), packages/domain/src/decant/planning.ts (`assertBulkLotIsDecantable`
tal como quedó), packages/db/tests/smoke_business_flow.sql,
packages/db/migrations/0009_invariants.sql (trigger
`assert_sealed_lot_not_open`, para ver qué campos usa la base para
distinguir el caso).

Objetivo: completar `assertBulkLotIsDecantable` (`planning.ts`, compartida
por `planDecant` y `executeDecant`) para que rechace un `LotSnapshot` de un
lote SELLADO recién abierto, no solo valide su `status`.

Criterio de aceptación: `LotSnapshot` expone `variantType` y `uom`. Un
`LotSnapshot` de lote SELLADO en `open_for_decant` es rechazado por
`planDecant` (y por `executeDecant`). Test con fixtures que cubran: sellado
en `open_for_decant` (rechazado), granel en `open_for_decant` (aceptado),
sellado en otro estado (rechazado por status, como ya validaba).

TRAMPAS DE ESTA TAREA:
· No es un criterio nuevo, es COMPLETAR el que ya existe. No reescribas
  `assertBulkLotIsDecantable` desde cero ni le cambies el nombre — hoy
  valida `status`, tiene que seguir validándolo y sumar `variantType`+`uom`.
· `LotSnapshot` necesita los dos campos nuevos sin romper los call sites
  que ya la usan desde A06 y A07.
· El criterio "contra un lote real" no se puede dar por cumplido hoy: no
  existe ningún lugar que construya un `LotSnapshot` desde una fila real
  de `inventory_lots` (eso es WP-C11/WP-C13). Con fixtures alcanza para
  cerrar esta sesión, pero decilo explícitamente en el PR — no se cierra
  en silencio como si estuviera verificado contra datos reales.

Alcance: solo la validación de origen (`variantType` + `uom`) en
`assertBulkLotIsDecantable` y el tipo `LotSnapshot`. Nada de C11/C13.
```

---

### Sesión 11 — WP-A08 · Máquinas de estado

```
Antes de tocar nada: git checkout -b feat/a08-state-machines

Tomá WP-A08 del backlog.

Leé primero: .claude/rules/domain.md, docs/domain-contracts.md (sección
6.5, con el ejemplo de orden de compra), docs/domain-rules.md (RN-VTA-02,
RN-FRA-01), packages/db/migrations/0001_foundation.sql (los enums
`po_status`, `sale_order_status`, `decant_wo_status`),
packages/db/migrations/0006_sales.sql (`sale_order_status_history`, pista
de qué transiciones ya contempla el esquema).

Objetivo: las tres máquinas de estado —orden de compra, pedido de venta,
orden de fraccionamiento— en packages/domain, como tabla de transición de
datos.

Criterio de aceptación: transiciones como dato (igual al ejemplo de
`PURCHASE_ORDER_TRANSITIONS` en docs/domain-contracts.md §6.5). Test
exhaustivo de la matriz completa: cada transición inválida tiene su propio
caso, no solo el camino feliz.

TRAMPAS DE ESTA TAREA:
· docs/domain-contracts.md §6.5 solo da la tabla de orden de compra como
  ejemplo. Las de `sale_order_status` y `decant_wo_status` NO están
  escritas en ningún documento como lista de aristas — hay que derivarlas
  de domain-rules.md y de los enums+historial de las migraciones. Si al
  armar una transición dudás si es válida (¿un pedido `paid` puede volver
  a `awaiting_payment`? ¿una orden de fraccionamiento `cancelled` se
  reactiva?), esa es una regla de negocio que ningún documento cubre —
  preguntá, no la inventes porque suena razonable.
· `sales/order.ts` es el mismo archivo que WP-A09 (la sesión siguiente) va
  a extender con totales. Dejalo en condiciones de que A09 solo agregue
  funciones, no reescriba la máquina de estados que dejaste acá.
· Transiciones como DATOS: un `Record<Status, Status[]>` o equivalente, no
  un `switch` esparcido por el código.

Alcance: las tres máquinas de estado, sin la lógica de qué hacer al entrar
a cada estado — eso es de otros WP. Un PR.
```

---

### Sesión 12 — WP-A09 · Ventas

```
Antes de tocar nada: git checkout -b feat/a09-sales-domain

Tomá WP-A09 del backlog.

Leé primero: .claude/rules/domain.md, docs/domain-rules.md (RN-VTA
completo, RN-RES completo, RN-SEN completo), docs/domain-contracts.md
(sección 2, mapa de módulos — `sales/order.ts`, `pricing.ts`,
`reservation.ts`, `deposit.ts`).

Objetivo: packages/domain/src/sales/ — totales, descuentos, TTL de
reserva, señas.

Criterio de aceptación: RN-VTA-01, RN-RES-02, RN-SEN-01…04, con test cada
una.

TRAMPAS DE ESTA TAREA:
· RN-VTA-01: el total es `subtotal − descuento + envío`, y la base lo
  impone. No lo recalcules de otra forma aunque el resultado numérico
  coincida.
· La seña es pasivo: `applied_pyg + refunded_pyg ≤ amount_pyg` es un
  INVARIANTE (RN-SEN-02), no una validación opcional que se salta si el
  caller ya confía en el dato.
· Los TTL de reserva son la tabla de RN-RES-02 (15 min checkout, 30 min
  tarjeta, 48 h transferencia, hasta el vencimiento de la seña, hasta 30
  días la retención manual), no números inventados ni un único TTL genérico.
· `sales/order.ts` ya trae la máquina de estados de WP-A08 (sesión
  anterior). No la dupliques ni la reescribas: agregá los totales al
  mismo archivo.
· RN-SEN-04: una seña vencida con saldo sin aplicar NO se cancela
  automáticamente. No agregues esa lógica "para prolijidad" — es una
  decisión humana, y el dominio solo la deja en condiciones de reportarse.

Alcance: solo sales/. La máquina de estados es WP-A08.
```

---

### Sesión 13 — WP-A11 · Contracts

```
Antes de tocar nada: git checkout -b feat/a11-contracts-base

Tomá WP-A11 del backlog.

Leé primero: .claude/rules/contracts.md, docs/api-conventions.md (§3
Validación, §7 DTOs por audiencia), docs/domain-contracts.md (sección 2,
mapa de módulos).

Objetivo: packages/contracts — esquemas Zod base (dinero como string, ids,
paginación) y un procedimiento de ejemplo tipado extremo a extremo.

Criterio de aceptación: un procedimiento de ejemplo tipado extremo a
extremo compila.

TRAMPAS DE ESTA TAREA:
· Todo esquema con `.strict()`. Sin eso un campo no declarado
  (`{ role: 'owner' }`) puede colarse hasta un `update` mal escrito.
· El dinero viaja como STRING, nunca como número: `"245000"`, no `245000`.
  Un `bigint` no sobrevive `JSON.stringify` y un `number` grande pierde
  precisión.
· DTO público y administrativo son esquemas DISTINTOS, no el mismo con
  campos opcionales — y el público necesita su propio test que verifique
  que NO aparece ninguna de las claves prohibidas (`cost`, `landed`,
  `supplier`, `margin`, `fx_rate`). No declararlas no alcanza si alguien
  extiende el objeto por descuido más adelante.

Alcance: la base y un ejemplo extremo a extremo. Los DTO de cada módulo se
arman junto con el WP de ese módulo en el bloque C.
```

---

### Sesión 14 — WP-A10 · Dataset dorado

```
Antes de tocar nada: git checkout -b feat/a10-golden-dataset

Tomá WP-A10 del backlog.

Leé primero: docs/domain-contracts.md (sección 8.1), GLOSARIO.md (entrada
"Dataset dorado"), docs/backlog.md (nota sobre A10, debajo de la tabla del
bloque A).

Objetivo: packages/domain/test/golden/ con veinte operaciones reales del
v2 (compras con flete, aperturas de frasco, fraccionamientos, ventas
mixtas), corriendo en CI.

Criterio de aceptación: corre en CI; cada caso cita su origen (qué
operación real del v2 lo generó).

TRAMPAS DE ESTA TAREA — esta es la sesión que se frena, no se completa sola:
· Los valores esperados salen de la operación real del v2 —planillas de
  costos, ventas históricas—, NO del código nuevo de A04-A09. Si el
  dataset lo genera el mismo código que va a probar, los tests miden
  contra sí mismos y no protegen nada.
· Los veinte números los pone José, no el agente. Armá la estructura (el
  formato del caso, el runner que lo corre en CI, la cita de origen), pero
  no completes los valores esperados por tu cuenta aunque el cálculo te
  cierre.
· Si un valor esperado no coincide con lo que da el código nuevo, la
  primera pregunta es cuál de los dos está mal — a veces es el sistema
  viejo el que tenía el error (ver la nota sobre A10 en docs/backlog.md).

Alcance: estructura + runner + los casos que José vaya confirmando. No
cierres la sesión completando números por tu cuenta para avanzar: pará y
pedilos. Ver también §7 más abajo.
```

---

### Sesión 15 — WP-A12 · Endurecer el lint de pureza en tests

```
Antes de tocar nada: git checkout -b feat/a12-domain-test-lint-hardening

Tomá WP-A12 del backlog.

Leé primero: .claude/rules/domain.md, .claude/rules/testing.md,
docs/backlog.md (nota sobre A12, con las tres vías, y la nota sobre
`Quantity.zero(uom)` para evaluar de paso), packages/config/eslint/index.js.

Objetivo: la excepción de la regla de pureza de packages/domain para
archivos de test hoy se activa por sufijo de nombre (`*.test.ts`), no por
contenido ni ubicación. Evaluar y aplicar una de las tres vías del
backlog, o justificar por escrito por qué ninguna corresponde.

Criterio de aceptación: evaluada y aplicada una de las tres opciones de la
nota del backlog (acotar a un directorio `test/`, acotar a los globals que
realmente hacen falta, o documentar cada ampliación con fecha/motivo/WP en
el propio archivo de config) — o justificado por escrito por qué ninguna
corresponde.

TRAMPAS DE ESTA TAREA:
· No es lint por lint: la excepción ya se ensanchó dos veces
  (`checkInternals` en A03, `Date` en A06) sin registro centralizado de
  por qué. El riesgo no es un test malicioso — es la erosión acumulada de
  una regla que existe para ser MECÁNICA, no discrecional.
· Las tres vías no son excluyentes entre sí. Podés aplicar más de una si
  tiene sentido, pero decidilo explícitamente, no por default.
· De paso, evaluá `Quantity.zero(uom)` en `shared/quantity.ts` (nota del
  backlog): es la solución real al truco de `execution.ts`
  (`required.qty.minus(required.qty)`) para conseguir una `Quantity` en
  cero sin arriesgar `UomMismatchError`. Es un método de una línea — no
  abras un WP nuevo para eso.

Alcance: la config de lint, más `Quantity.zero(uom)` si corresponde. No es
urgente si el argumento para postergar es sólido, pero sí antes del bloque
C, cuando se multiplique la cantidad de paquetes que dependen de esta regla.
```

---

### Sesión 16 — WP-B01 a WP-B03 · Esquema

Excepción a la regla de un paquete por sesión: estos tres son incorporación, no diseño.

```
Tomá WP-B01, WP-B02 y WP-B03 del backlog.

Leé primero: packages/db/README.md, docs/data-model.md, ADR-018,
docs/security-spec.md (§2.1 Matriz de roles).

Objetivo: incorporar las migraciones ya validadas al flujo del repositorio,
con los scripts db:migrate, db:seed, db:reset, db:test y db:pull.

Criterio de aceptación: `pnpm db:reset` desde cero sin errores. `pnpm
db:seed` idempotente, con la matriz de roles del seed (`owner`, `manager`,
`vendedor`, `deposito`) coincidiendo exactamente con la de
docs/security-spec.md §2.1. `pnpm db:test` con 18/18 invariantes en verde,
corriendo en CI.

TRAMPAS DE ESTA TAREA:
· NUNCA corras `prisma migrate dev`. El esquema es SQL escrito a mano;
  Prisma se regenera por introspección con db:pull. Ver ADR-018.
· NO edites las migraciones existentes. Están validadas contra PostgreSQL 16
  y sus 18 invariantes probados. Si algo te parece mejorable, decilo, no
  lo cambies.
· El orden de las migraciones importa y está en el nombre del archivo.
· `db:seed` tiene que poder correrse más de una vez sin duplicar filas ni
  fallar por choque de clave — "idempotente" es parte del criterio de
  aceptación, no un detalle de implementación.

Alcance: incorporación e integración con CI. Sin cambios al esquema.
```

---

### Sesión 17 — WP-B04 · Prisma por introspección

```
Antes de tocar nada: git checkout -b feat/b04-prisma-introspection

Tomá WP-B04 del backlog.

Leé primero: .claude/rules/database.md, packages/db/README.md (sección
"Por qué SQL-first y no prisma migrate"), ADR-018.

Objetivo: packages/db/prisma/schema.prisma generado por introspección
(`npx prisma db pull` + `npx prisma generate`) y commiteado, con el script
`db:pull` encadenado a `db:migrate`.

Criterio de aceptación: el cliente tipado compila y expone los 61 modelos.

TRAMPAS DE ESTA TAREA:
· NUNCA `prisma migrate dev`. El esquema es SQL escrito a mano;
  `schema.prisma` se regenera por introspección con `db:pull` y se
  commitea — nunca se edita a mano. Ver ADR-018.
· Si el cliente generado no expone los 61 modelos, el problema está en la
  introspección o en el `search_path` de la conexión (el esquema vive en
  `app`, no en `public`), no en el esquema SQL: no "arregles" schema.prisma
  a mano para que compile, arreglá la conexión con la que corre `db pull`.
· `db:pull` va encadenado a `db:migrate` en el script, no como paso manual
  aparte — para que regenerar el cliente no dependa de que alguien se
  acuerde de correrlo después de cada migración.

Alcance: solo la introspección y el script db:pull. Sin cambios al esquema.
```

---

### Sesión 18 — WP-B05 · Testcontainers

```
Antes de tocar nada: git checkout -b feat/b05-testcontainers

Tomá WP-B05 del backlog.

Leé primero: .claude/rules/database.md, .claude/rules/testing.md,
docs/testing-strategy.md (sección 3, Nivel 2 — Integración).

Objetivo: base Postgres efímera vía Testcontainers, una por corrida de
tests de integración.

Criterio de aceptación: un test de integración de ejemplo corre en CI en
menos de 60 s.

TRAMPAS DE ESTA TAREA:
· Postgres real vía Testcontainers, NUNCA base en memoria ni un simulacro
  de Prisma — los invariantes (los 18 de packages/db/tests/invariants.sql)
  viven en PostgreSQL, y un simulacro no los tiene.
· La base efímera corre migraciones Y seed antes de cada corrida
  (`runMigrations` + `runSeed`, ver el ejemplo de docs/testing-strategy.md
  §3), o los tests de permisos y RLS no tienen contra qué correr: necesitan
  los roles y el plan de cuentas del seed, no una base vacía recién
  migrada.
· El objetivo de tiempo es por CORRIDA, no por test: si el ejemplo tarda
  más de 60 s, sospechá que el contenedor se está recreando por cada test
  en vez de una vez por corrida completa.

Alcance: la infraestructura de test (el contenedor + un test de ejemplo).
Los tests de integración de cada módulo se escriben junto con ese módulo.
```

---

### Sesión 19 — WP-B07 · docker-compose

```
Antes de tocar nada: git checkout -b feat/b07-docker-compose

Tomá WP-B07 del backlog.

Leé primero: .claude/rules/database.md, CONTRIBUTING.md (§1 Entorno
local — ya describe el flujo `docker compose up -d` → `pnpm db:reset` →
`pnpm dev` que este WP tiene que hacer real), packages/db/README.md.

Objetivo: infra/docker/docker-compose.yml con Postgres y Redis para
desarrollo local.

Criterio de aceptación: arranque completo desde cero (`git clone` →
`docker compose up -d` → `pnpm db:reset` → `pnpm dev`) en menos de 15
minutos.

TRAMPAS DE ESTA TAREA:
· Postgres y Redis, nada más. Versión de Postgres fijada a 16 — la misma
  contra la que se validó el esquema (packages/db/README.md), no `latest`.
· El criterio es real, no estimado: cronometrá el arranque completo desde
  cero (`docker compose down -v` y de nuevo desde el paso 1 de CONTRIBUTING.md
  §1) y poné el número real en el PR, no una estimación de cuánto "debería"
  tardar.
· Volúmenes con NOMBRE, no anónimos. Un `db:reset` corre migraciones sobre
  la base existente: no debería obligar a recrear el contenedor, y un
  reinicio de docker-compose no debería perder los datos de Redis entre medio.

Alcance: solo docker-compose.yml y su documentación de uso en
CONTRIBUTING.md si hace falta ajustarla. Sin scripts de aplicación nuevos
más allá de lo que ya existe.
```

---

### Sesión 20 — WP-B06 · Prueba de aislamiento

Merece su propia sesión aunque sea chica, porque es el test que protege toda la capa de seguridad.

```
Tomá WP-B06 del backlog.

Leé primero: docs/security-spec.md (sección 3.1), ADR-016,
docs/testing-strategy.md (sección 3.2).

Objetivo: prueba de integración que verifica el aislamiento RLS conectándose
con el rol real de la aplicación.

Criterio de aceptación: conectado como joda_api — sin tenant_id en contexto
devuelve 0 filas; con otro tenant devuelve 0 filas; UPDATE sobre
inventory_movements devuelve permission denied.

TRAMPA DE ESTA TAREA: el test tiene que conectarse como joda_api, NO como
postgres ni con service_role. Un superusuario elude RLS siempre, así que
un test que corre como superusuario pasa aunque el aislamiento esté roto.
Este test existe justamente para detectar si alguien cambió la conexión a
una credencial elevada.

Alcance: solo este test.
```

---

## Bloque C — API (25 sesiones, dos fases)

**Fase 1, secuencial (Sesiones 21 a 27): C01 → C02 → C03 → C04 → C05 → C06 → C07.** Cada sesión se apoya en la anterior: C02 (`withTenantTx`) necesita el esqueleto tRPC de C01; C04 (segundo factor) necesita la sesión de personal de C03; C05 (permisos) necesita esa misma sesión para saber a quién autorizar; C06 (idempotencia) y C07 (auditoría) necesitan la transacción con contexto de C02 para escribir dentro de ella. No arranques dos sesiones de esta fase en paralelo — el resultado más común es dos versiones distintas de `withTenantTx` en el mismo repo, una de las cuales termina perdiendo.

**Fase 2, paralelizable (Sesiones 28 a 45): el resto.** Una vez cerrada la Fase 1, los módulos de catálogo, inventario, fraccionamiento, compras, sourcing, ventas, contabilidad, fiscal, seguridad y observabilidad dependen todos de la cimentación, pero no todos entre sí. La columna "Depende de" del backlog marca el orden real dentro de cada módulo (C11 antes que C13, C18 antes que C19); entre módulos, varias sesiones pueden abrirse a la vez en ramas separadas. Ver "Reparto entre agentes" al final de esta sección para el criterio de quién toma cada una.

---

### Sesión 21 — WP-C01 · Esqueleto Fastify + tRPC

```
Antes de tocar nada: git checkout -b feat/c01-api-skeleton

Tomá WP-C01 del backlog.

Leé primero: .claude/rules/api.md, docs/api-conventions.md (secciones 1 y
4 completas), apps/api/src/index.ts (el "hola mundo" de WP-A02, es lo que
esta sesión reemplaza), packages/contracts/src/example/ping.ts (el patrón
de tRPC que WP-A11 dejó armado, todavía sin montar en ningún servidor real).

Objetivo: montar tRPC sobre el Fastify de apps/api, el contexto de
petición (userId, tenantId, audience, requestId) y el mapeador de errores
de PostgreSQL a errores en español con código estable.

Criterio de aceptación: un procedimiento de ejemplo responde tipado de
punta a punta. Un CHECK de PostgreSQL violado (ERRCODE 23514) le llega al
cliente como { code, message en español, httpStatus, requestId } — nunca
el texto crudo de Postgres.

TRAMPAS DE ESTA TAREA:
· apps/api existe desde WP-A02, pero como Fastify puro sin tRPC. Esta
  sesión AGREGA tRPC, el contexto de petición y el mapeador — no reescribe
  el esqueleto de A02 desde cero.
· Ningún mensaje de PostgreSQL llega al usuario, ni siquiera "traducido a
  medias". El mapeador traduce por ERRCODE (docs/api-conventions.md §4.4):
  23514 → CHECK, 23505 → UNIQUE, 23503 → FOREIGN KEY, 2F004 → ledger
  inmutable. Un ERRCODE sin mapeo explícito es INTERNAL, 500 — no un
  intento de adivinar el mensaje.
· El DATABASE_URL local apunta a localhost:55432, no al 5432 por defecto
  (WP-B07): un Postgres nativo de Windows puede estar escuchando ahí y el
  error de conexión no va a mencionar Docker para nada.
· Sin contexto de petición todavía no hay `set_config` real — eso es
  WP-C02. Esta sesión arma el contexto (de dónde salen userId/tenantId),
  no todavía cómo se lo pasa a la transacción de Postgres.

Alcance: solo el esqueleto — tRPC montado, contexto, mapeador de errores.
Sin autenticación real (C03) ni transacciones con set_config (C02).
```

---

### Sesión 22 — WP-C02 · withTenantTx

```
Antes de tocar nada: git checkout -b feat/c02-tenant-tx

Tomá WP-C02 del backlog.

Leé primero: .claude/rules/api.md, docs/api-conventions.md (sección 8
completa: 8.1, 8.2, 8.3), docs/security-spec.md (sección 3.1, la tabla de
roles — joda_api es NOBYPASSRLS), packages/db/test/integration/
rls_isolation.test.ts (WP-B06, el mismo mecanismo de conexión con
joda_api que esta sesión usa en runtime, no solo en tests).

Objetivo: withTenantTx — toda transacción abre con set_config('app.user_id'
| 'app.tenant_id' | 'app.audience', ..., true), antes de cualquier consulta.

Criterio de aceptación: test que demuestre que el contexto NO se filtra
entre dos peticiones que reutilizan la misma conexión del pool — abrí una
transacción con un tenant, cerrala, abrí otra con un tenant distinto sobre
la conexión que el pool recicló, y verificá que la segunda no ve nada del
primero.

TRAMPAS DE ESTA TAREA:
· El tercer parámetro de set_config va en `true`, SIEMPRE. Es la regla que
  ya corregimos una vez en un ejemplo de documentación (PR #34, docs/
  testing-strategy.md) — acá no es un ejemplo, es el código real que corre
  en cada petición. Sin ese `true`, el valor se filtra a la siguiente
  petición que reutilice la conexión: un error de aislamiento entre
  usuarios, silencioso y grave (docs/api-conventions.md §8.1).
· La conexión de runtime usa el rol joda_api, NOBYPASSRLS. Nunca
  service_role ni el dueño de las tablas — con una credencial privilegiada
  RLS no se evalúa y la Capa 1 de docs/security-spec.md queda decorativa.
· El bloqueo de lotes (§8.2, para cuando llegue C19) va en orden
  ascendente de lot_id, en una sola sentencia FOR UPDATE — no es de esta
  sesión implementarlo, pero withTenantTx tiene que dejar el patrón listo
  para que C19 lo use sin reinventar la transacción.
· Una operación de negocio, una transacción (§8.3): no abras una
  transacción solo para leer, y no llames a un proveedor externo dentro de
  una — una transacción no debe esperar por la red.

Alcance: solo withTenantTx y su test de no-filtración. Sin auditoría (C07)
ni idempotencia (C06) todavía, aunque ambas van a usar esta misma función.
```

---

### Sesión 23 — WP-C03 · Autenticación de personal

```
Antes de tocar nada: git checkout -b feat/c03-staff-auth

Tomá WP-C03 del backlog.

Leé primero: .claude/rules/api.md, docs/security-spec.md (sección 1
completa y sección 4 completa: 4.1, 4.2, 4.3), ADR-015.

Objetivo: sesión de personal — cookie __Host-joda_a, token de acceso de
15 min en memoria del servidor, token de refresco de 8 h rotativo con
detección de reúso.

Criterio de aceptación: reusar un token de refresco ya consumido invalida
TODA la familia de tokens de esa sesión y fuerza reautenticación — no solo
el token reusado.

TRAMPAS DE ESTA TAREA:
· "Rotativo" no alcanza solo, hace falta la DETECCIÓN DE REÚSO: cada uso
  del refresco emite uno nuevo e invalida el anterior; si el anterior
  reaparece (alguien lo copió), se invalida la familia entera, no un token
  suelto.
· La cookie de personal (__Host-joda_a) es una identidad completamente
  separada de la de cliente (__Host-joda_c, ADR-015) — dos tablas
  (staff_users / customers), dos dominios, dos audiencias. No hay fila
  donde ponerle un rol de personal a un cliente: es un invariante de
  esquema, no una validación a mantener en código.
· Sin `localStorage` para ningún token (CLAUDE.md, no negociable). El
  token de acceso vive en memoria del servidor de sesión, nunca en el
  cliente más allá de la cookie httpOnly.
· El segundo factor es la sesión SIGUIENTE (C04): esta sesión deja al
  usuario autenticado con contraseña, no inscribe TOTP todavía.

Alcance: solo la autenticación de personal (sesión, cookies, refresco).
Clientes (audiencia customer) y segundo factor quedan para después.
```

---

### Sesión 24 — WP-C04 · Segundo factor obligatorio

```
Antes de tocar nada: git checkout -b feat/c04-staff-mfa

Tomá WP-C04 del backlog.

Leé primero: .claude/rules/api.md, docs/security-spec.md (sección 4.3 y
la fila "Segundo factor" de la tabla en sección 1), ADR-015.

Objetivo: segundo factor TOTP obligatorio para personal, sobre la sesión
de WP-C03.

Criterio de aceptación: un usuario de personal sin segundo factor
inscripto puede autenticarse con contraseña, pero solo puede acceder a la
pantalla de inscripción de TOTP — ninguna otra ruta del backoffice.

TRAMPAS DE ESTA TAREA:
· Es obligatorio para PERSONAL, opcional para clientes (docs/
  security-spec.md §1) — no generalices la obligatoriedad a audiencia
  customer, que todavía ni siquiera está en alcance de este bloque.
· "Solo accede a la pantalla de inscripción" es un estado de sesión
  intermedio, no un error 401: el usuario está autenticado (tiene sesión
  válida), pero esa sesión no autoriza nada hasta que complete la
  inscripción. Modelalo como un estado explícito, no como una excepción
  atrapada en cada ruta.
· El secreto TOTP no es un dato más: tratalo con el mismo cuidado que un
  password (lista negra del registrador de bitácoras, docs/security-spec.md
  §6) — nunca en un log, nunca en audit_log en texto plano.

Alcance: inscripción y verificación TOTP sobre la sesión existente. Sin
recuperación de segundo factor perdido (si hace falta, es un WP nuevo — no
lo inventes acá).
```

---

### Sesión 25 — WP-C05 · Middleware de permisos

```
Antes de tocar nada: git checkout -b feat/c05-permissions

Tomá WP-C05 del backlog.

Leé primero: .claude/rules/api.md, docs/security-spec.md (sección 2
completa —catálogo y matriz 2.1—, sección 3.2), docs/api-conventions.md
(sección 4.3 "La regla del 404", sección 9), ADR-016.

Objetivo: requirePermission() como middleware de tRPC, con caché de
permisos en Redis (TTL 60 s), sobre la sesión de personal de WP-C03.

Criterio de aceptación: test que recorre TODO el router de la API y falla
si algún procedimiento no declara meta.permission — un procedimiento sin
permiso declarado tiene que fallar en el ARRANQUE, no en producción.

TRAMPAS DE ESTA TAREA:
· 404, no 403, en rutas administrativas sin permiso. Un 403 confirma que
  el endpoint existe y que hay algo que proteger; un 404 no distingue
  "no existe" de "no es tuyo". La excepción (docs/api-conventions.md §4.3):
  dentro de una sesión de staff válida, si el usuario tiene acceso al
  MÓDULO pero no a la ACCIÓN concreta, ahí sí corresponde 403 — ya sabe que
  el módulo existe.
· Los permisos NO van en el JWT/token. El token lleva userId, tenantId,
  sessionId, audience — nada más. Los permisos se resuelven server-side
  con caché en Redis, TTL 60 s: revocar un rol tiene efecto en un minuto,
  no cuando expire el token (que podría durar horas).
· Esta es la Capa 2 de las tres de docs/security-spec.md §3 —"defensa
  principal"—, pero no la única: RLS (Capa 1) ya existe desde WP-B06 y
  sigue activa debajo. No la trates como si fuera la única barrera.
· El middleware necesita el catálogo de permisos y la matriz de roles de
  docs/security-spec.md §2.1 EXACTOS — no inventes un permiso nuevo que
  "parece que falta" sin confirmarlo primero.

Alcance: el middleware y su test exhaustivo del router. Los permisos
concretos de cada módulo (sales.order:read, etc.) se declaran junto con
el WP de ese módulo, no todos acá.
```

---

### Sesión 26 — WP-C06 · Middleware de idempotencia

```
Antes de tocar nada: git checkout -b feat/c06-idempotency

Tomá WP-C06 del backlog.

Leé primero: .claude/rules/api.md, docs/api-conventions.md (sección 5
completa: 5 y 5.1).

Objetivo: middleware de idempotencia con idempotency_keys, sobre
withTenantTx de WP-C02.

Criterio de aceptación: reintentar una mutación con el mismo
Idempotency-Key y el mismo cuerpo devuelve la respuesta guardada, sin
reprocesar. Con el mismo key y un cuerpo distinto: 409
CONFLICT_IDEMPOTENCY_KEY_REUSE.

TRAMPAS DE ESTA TAREA:
· El registro en idempotency_keys se inserta DENTRO de la misma
  transacción que el efecto (withTenantTx de C02) — si la transacción
  falla, la clave no queda quemada. Si lo hacés en dos transacciones
  separadas, una falla a mitad de camino deja el sistema en un estado que
  ni reintenta ni avanza.
· Es distinto del mecanismo de webhooks (idempotency_keys por
  (tenant_id, scope, key) vs. payment_events por
  (provider, external_event_id), docs/api-conventions.md §5.1) — no
  reuses una tabla para la otra, tienen forma y ciclo de vida distintos y
  webhooks es bloque G, no de esta sesión.
· Solo mutaciones con efecto irreversible necesitan esto (confirmar venta,
  contabilizar recepción, ejecutar fraccionamiento, aplicar seña) — no es
  un middleware global sobre toda mutación.

Alcance: el middleware y la tabla idempotency_keys. Los webhooks de pago
son otro mecanismo, bloque G.
```

---

### Sesión 27 — WP-C07 · Auditoría

```
Antes de tocar nada: git checkout -b feat/c07-audit-log

Tomá WP-C07 del backlog.

Leé primero: .claude/rules/api.md, docs/api-conventions.md (sección 10),
docs/security-spec.md (sección 7).

Objetivo: escritura en audit_log dentro de la misma transacción de
withTenantTx (WP-C02), para toda mutación de inventario, contabilidad,
compras, precios, permisos y configuración fiscal.

Criterio de aceptación: toda mutación de inventario y contabilidad queda
registrada en audit_log, en la misma transacción que el efecto — no en un
paso aparte que pueda quedar desincronizado.

TRAMPAS DE ESTA TAREA:
· audit_log es append-only e inmutable — ni siquiera la API puede
  borrarla ni editarla (docs/security-spec.md §7, y joda_api ya no tiene
  UPDATE ni DELETE sobre ella desde el esquema de WP-B01).
· `action` usa el MISMO nombre que el procedimiento tRPC
  ("sales.order.confirm", no una descripción libre) — es lo que permite
  cruzar bitácora con métricas de uso más adelante.
· Los campos son fijos: actor_id, audience, action, entity, entity_id,
  before, after, ip, user_agent, request_id, occurred_at. No agregues ni
  quites campos por conveniencia de un módulo puntual.
· No es solo inventario y contabilidad: precios, permisos y configuración
  fiscal también auditan, aunque el criterio de aceptación de este WP solo
  pida verificar los dos primeros con test.

Alcance: el mecanismo de auditoría (la función que escribe, invocada desde
withTenantTx o desde cada servicio). Cada módulo llama a esta función
cuando llegue su turno, no hace falta instrumentar módulos que todavía no
existen.
```

---

### Sesión 28 — WP-C08 · Catálogo: productos y BOM

```
Antes de tocar nada: git checkout -b feat/c08-catalog-core

Tomá WP-C08 del backlog.

Leé primero: .claude/rules/api.md, .claude/rules/contracts.md,
docs/api-conventions.md (sección 7, DTOs por audiencia),
docs/data-model.md (secciones 3.1 y 3.2), docs/especificacion-software.md
(sección 2.1, RF-CAT completo).

Objetivo: módulo catálogo — productos de las tres verticales (perfume,
reloj, accesorio), categorías, tags, variantes y BOM.

Criterio de aceptación: RF-CAT-01 a RF-CAT-07. El DTO público NO expone
costos — test que verifica que la respuesta no contiene ninguna de las
claves prohibidas (cost, landed, supplier, margin, fx_rate).

TRAMPAS DE ESTA TAREA:
· DTO público y administrativo son esquemas Zod DISTINTOS
  (packages/contracts, .strict() en ambos), no el mismo con campos
  opcionales — docs/api-conventions.md §7 lo muestra con costSummary y
  supplierRefs como ejemplo de lo que JAMÁS sale en el público.
· `publicVariant` expone `inStock: boolean`, nunca la cantidad — esto no
  es una decisión de frontend (WP-E05/G05), es del contrato mismo: si el
  DTO ya trae la cantidad, cualquier consumidor puede mostrarla.
· Las verticales son CTI + facetas JSONB (ADR-005): no le agregues una
  tabla nueva a cada vertical por reflejo, el patrón ya está resuelto en
  el esquema.
· El BOM (RF-CAT-07) es de una variante FRACCIONADA — no confundir con
  las variantes `sellado`/`granel` sin BOM.

Alcance: productos, categorías, tags, variantes, BOM. Medios (imágenes)
es WP-C09, la siguiente sesión.
```

---

### Sesión 29 — WP-C09 · Catálogo: medios

```
Antes de tocar nada: git checkout -b feat/c09-catalog-media

Tomá WP-C09 del backlog.

Leé primero: .claude/rules/api.md, docs/security-spec.md (fila "Carga de
archivos" en la tabla de sección 5), docs/especificacion-software.md
(RF-CAT-08).

Objetivo: subida de imágenes de producto con validación por bytes mágicos
y generación de derivados AVIF/WebP en múltiples anchos.

Criterio de aceptación: RF-CAT-08. Un archivo con extensión falsa (un
.exe renombrado a .jpg) se rechaza — la validación es por los bytes
reales del archivo, no por el Content-Type ni la extensión declarada.

TRAMPAS DE ESTA TAREA:
· Validación por BYTES MÁGICOS, nunca por Content-Type ni extensión —
  ambos los controla quien sube el archivo.
· Reprocesamiento con sharp: elimina metadatos y cualquier carga útil
  embebida, no solo redimensiona. Nombre por hash, no por el nombre
  original del archivo subido.
· Los archivos se sirven desde un dominio DISTINTO al del admin (docs/
  security-spec.md §5) — no los sirvas desde el mismo origen que la
  sesión de personal.
· Límite de tamaño y dimensiones ANTES de procesar, no después: un
  archivo de 800 MB no debería llegar a sharp para enterarse recién ahí
  de que es demasiado grande.

Alcance: subida, validación y derivados. Sin CDN ni políticas de caché
avanzadas — eso es infraestructura, no de este WP.
```

---

### Sesión 30 — WP-C10 · Inventario: saldos, ajustes, historial

```
Antes de tocar nada: git checkout -b feat/c10-inventory-balances

Tomá WP-C10 del backlog.

Leé primero: .claude/rules/api.md, .claude/rules/domain.md,
docs/data-model.md (sección 3.3), docs/domain-rules.md (RN-LOT-01),
ADR-007, docs/especificacion-software.md (RF-INV-01 a RF-INV-05).

Objetivo: módulo inventario — consulta de saldos por variante, ajustes
con motivo obligatorio, historial de movimientos de un lote.

Criterio de aceptación: RF-INV-03 a RF-INV-05. Un ajuste que dejaría el
saldo negativo se rechaza.

TRAMPAS DE ESTA TAREA:
· El ledger (inventory_movements) es append-only. La API NO tiene UPDATE
  ni DELETE sobre él (ya lo impone el esquema desde WP-B01, pero no lo
  intentes rodear desde el código de aplicación tampoco). Corregir un
  error es INSERTAR un movimiento de ajuste nuevo, nunca editar uno
  existente — el saldo es una PROYECCIÓN derivada del libro, no una
  columna que se actualiza.
· Toda salida del ledger registra sus capas de costo en
  movement_cost_allocations (WP-A06, allocateFromLots) — un ajuste
  negativo también es una salida y también necesita sus capas, o el COGS
  deja de cerrar.
· "Saldo disponible" no es lo mismo que "saldo proyectado" (RN-RES-03,
  para cuando llegue C18): esta sesión expone el saldo del libro, sin
  descontar reservas todavía porque las reservas ni existen hasta C18.

Alcance: consulta de saldos, ajustes, historial. Apertura de frasco (C11),
serializados (C12) y fraccionamiento (C13) son sesiones propias.
```

---

### Sesión 31 — WP-C11 · Inventario: apertura de frasco

```
Antes de tocar nada: git checkout -b feat/c11-lot-opening-api

Tomá WP-C11 del backlog.

Leé primero: .claude/rules/api.md, .claude/rules/domain.md,
docs/domain-rules.md (RN-LOT-02, RN-LOT-03), ADR-009,
packages/domain/src/inventory/lotOpening.ts (WP-A13, la función de
dominio que esta sesión expone por API).

Objetivo: endpoint de apertura de frasco, sobre lotOpening.ts de WP-A13.

Criterio de aceptación: RF-INV-08. Abrir dos veces el mismo lote se
rechaza (RN-LOT-02, el caso borde 5 del catálogo de domain-rules.md, ya
cubierto por dominio en WP-A13 — esta sesión verifica que el rechazo
llega igual a través de la API).

TRAMPAS DE ESTA TAREA:
· La apertura de frasco es una CONVERSIÓN entre dos lotes (ADR-009), no
  un cambio de estado — cuatro pasos en una sola transacción: transfer_out
  del sellado, status → open_for_decant, alta del lote de granel hijo con
  parent_lot_id, transfer_in del granel. lotOpening.ts (WP-A13) ya calcula
  esto; esta sesión lo envuelve en withTenantTx (WP-C02) y lo persiste,
  no lo reimplementa.
· El lote sellado padre TAMBIÉN queda en open_for_decant, igual que el
  granel hijo — no es un bug de esta sesión, es el resultado correcto
  (ver la nota de WP-A13 en el propio backlog). RF-INV-09 ("impedir la
  venta como sellado de un lote abierto") depende de que este estado
  compartido esté bien persistido.
· Precondición de estado: solo se abre un lote sellado en `available`.
  Uno en `quarantine` o `damaged` se rechaza (RN-LOT-02).
· El costo se hereda ÍNTEGRO al granel, no se recalcula desde ningún otro
  dato — si el endpoint recalcula el costo puesto en vez de copiarlo, algo
  está mal.

Alcance: el endpoint y su transacción. La lógica de conversión ya existe
en packages/domain, no se reescribe acá.
```

---

### Sesión 32 — WP-C12 · Inventario: unidades serializadas

```
Antes de tocar nada: git checkout -b feat/c12-serialized-units

Tomá WP-C12 del backlog.

Leé primero: .claude/rules/api.md, .claude/rules/domain.md,
docs/domain-rules.md (RN-LOT-05, política `serial`; RN-VTA-04),
docs/especificacion-software.md (RF-INV-10).

Objetivo: administración de unidades serializadas (relojes) — número de
serie único, garantía, trazabilidad de venta.

Criterio de aceptación: RF-INV-10. El número de serie es único por
TENANT, no global — dos tenants pueden tener el mismo número de serie sin
chocar entre sí.

TRAMPAS DE ESTA TAREA:
· `serial` es una política de selección de lote (RN-LOT-05): "se elige
  explícitamente", no FIFO/FEFO. El endpoint tiene que dejar elegir la
  unidad concreta, no aplicar una política automática por encima.
· RN-VTA-04: una línea de venta con serial_unit_id mueve EXACTAMENTE 1
  unidad. Al confirmarse, la unidad pasa a `sold` y queda vinculada a esa
  línea — esto es de la sesión de confirmación de venta (C19), pero el
  modelo de esta sesión tiene que dejar el campo listo para esa
  vinculación.
· La unicidad del serial es un invariante de esquema (constraint), no una
  validación que la API tenga que reimplementar — si la migración de
  WP-B01 ya la tiene, no la dupliques en el servicio.

Alcance: alta, consulta y trazabilidad de unidades serializadas. El
consumo al vender es WP-C19.
```

---

### Sesión 33 — WP-C13 · Fraccionamiento: planificación y ejecución

```
Antes de tocar nada: git checkout -b feat/c13-decant-orders

Tomá WP-C13 del backlog.

Leé primero: .claude/rules/api.md, .claude/rules/domain.md,
docs/domain-rules.md (RN-FRA completo), ADR-010,
packages/domain/src/decant/ (planning.ts, execution.ts, waste.ts de
WP-A07/A15 — esta sesión los expone, no los reimplementa).

Objetivo: módulo fraccionamiento — planificación, órdenes, ejecución,
sobre planDecant/executeDecant de packages/domain.

Criterio de aceptación: RF-FRA-01 a RF-FRA-06. Ejecutar una orden sin
declarar merma real se rechaza (RN-FRA-03: waste_actual es obligatorio,
sin él la orden no pasa a `done`).

TRAMPAS DE ESTA TAREA:
· El decant tiene DOS momentos y son dos endpoints, no uno: planDecant
  (al confirmar la venta) reserva granel e insumos y crea la orden
  `pending`; executeDecant (cuando alguien llena el vial) recibe la merma
  REAL y produce los movimientos definitivos. Entre ambos no hay consumo
  de inventario, solo reserva (RN-FRA-01) — no colapses los dos momentos
  en un único endpoint "crear y ejecutar".
· La ejecución consume TODO en una sola transacción: el líquido del
  granel, la merma real, y cada componente del BOM (RN-FRA-03) — no tres
  operaciones separadas que puedan quedar a mitad de camino.
· El origen del granel se valida con variantType + uom, no solo status
  (RN-FRA-07, WP-A15): un sellado recién abierto comparte status con el
  granel hijo, pero no es decantable. La función de dominio ya lo rechaza;
  esta sesión no puede pasarle un LotSnapshot mal armado que lo eluda.
· El caso borde 2 (merma real > reservada): se permite y se consume lo
  real; si el granel no alcanza, la orden falla y queda `in_progress` para
  resolución manual, no se completa a la fuerza.

Alcance: planificación y ejecución de órdenes de fraccionamiento. La orden
NACE al confirmar una venta (WP-C19) — esta sesión construye el módulo,
C19 es quien lo dispara en el flujo real.
```

---

### Sesión 34 — WP-C14 · Compras: proveedores y máquina de estados

```
Antes de tocar nada: git checkout -b feat/c14-purchase-orders

Tomá WP-C14 del backlog.

Leé primero: .claude/rules/api.md, .claude/rules/domain.md,
docs/domain-rules.md (RN-EST-01), packages/domain (la máquina de estados
de orden de compra, WP-A08), docs/especificacion-software.md (RF-MKT-01
a RF-MKT-03).

Objetivo: módulo compras — proveedores, órdenes de compra multi-línea en
moneda extranjera, gobernadas por la máquina de estados de WP-A08.

Criterio de aceptación: RF-MKT-01 a RF-MKT-03. Una transición inválida de
la orden se rechaza con un mensaje claro, no un error genérico.

TRAMPAS DE ESTA TAREA:
· Las transiciones son las de RN-EST-01/WP-A08, como DATOS — no un
  `switch` nuevo en el servicio de la API que duplique lo que el dominio
  ya resolvió.
· Cancelable desde draft/pending_approval/approved/sent. NO desde
  partially_received ni received: ya entró mercadería. Revertir eso es
  una devolución a proveedor, fuera de alcance de esta máquina — no la
  inventes acá.
· pending_approval puede volver a draft (rechazo del aprobador) sin pasar
  por cancelled — no lo trates como una cancelación.
· Esta sesión NO genera stock ni movimientos: eso pasa recién al
  contabilizar una recepción, WP-C15. Una orden de compra, por más
  aprobada que esté, no toca el inventario.

Alcance: proveedores y el ciclo de vida de la orden de compra. Recepciones
(con prorrateo y generación de lotes) es WP-C15.
```

---

### Sesión 35 — WP-C15 · Compras: recepciones

```
Antes de tocar nada: git checkout -b feat/c15-receipts

Tomá WP-C15 del backlog.

Leé primero: .claude/rules/api.md, .claude/rules/domain.md,
docs/domain-rules.md (RN-COS-01 a RN-COS-03), ADR-008,
packages/domain/src/procurement/ (landedCost.ts y freight.ts de WP-A05,
esta sesión los expone y persiste), docs/especificacion-software.md
(RF-MKT-04 a RF-MKT-07).

Objetivo: recepciones de compra como entidad propia, con prorrateo de
flete/despacho y generación transaccional de lotes de inventario.

Criterio de aceptación: RF-MKT-04 a RF-MKT-07. Una recepción por una
cantidad mayor a la pedida se rechaza.

TRAMPAS DE ESTA TAREA:
· El tipo de cambio es el REAL de la recepción, congelado, independiente
  del estimado de la orden de compra (RN-COS-01, RF-MKT-06) — nunca el
  de la orden.
· El prorrateo usa Money.allocate (WP-A03/A05) por debajo: si el reparto
  no suma exactamente el total del flete, algo se está calculando a mano
  en vez de reusar la función de dominio.
· Generar los lotes y sus movimientos de entrada es UNA transacción
  (RF-MKT-07, withTenantTx de C02) — una recepción parcial que falla a
  mitad de camino no puede dejar lotes sin sus movimientos o viceversa.
· Admite recepciones PARCIALES y múltiples por orden de compra (RF-MKT-04)
  — no asumas una recepción = una orden completa.
· Esta sesión SÍ escribe en el ledger de inventario (a diferencia de
  WP-C14): cada recepción contabilizada es la primera entrada real de
  stock del flujo de compras.

Alcance: recepciones, prorrateo, generación de lotes. La orden de compra
en sí es WP-C14.
```

---

### Sesión 36 — WP-C16 · Sourcing: escenarios y comparación

```
Antes de tocar nada: git checkout -b feat/c16-sourcing

Tomá WP-C16 del backlog.

Leé primero: .claude/rules/api.md, .claude/rules/domain.md,
docs/especificacion-software.md (RF-SRC completo).

Objetivo: módulo sourcing — escenarios de compra con supuestos de tipo de
cambio, flete y aranceles, comparados línea por línea.

Criterio de aceptación: RF-SRC-01 a RF-SRC-05. Un escenario NO toca
inventario ni caja (RF-SRC-04) — es una simulación, no una operación.

TRAMPAS DE ESTA TAREA:
· RF-SRC-04 es el criterio central del módulo: un escenario reusa
  landedCost.ts/freight.ts (WP-A05) para PROYECTAR, sin insertar ningún
  movimiento real. Si un test de este módulo necesita limpiar
  inventory_movements después de correr, algo está mal diseñado.
· "Convertir un escenario en orden de compra" (RF-SRC-05) es la única
  operación que sí produce un efecto real — y en ese momento deja de ser
  un escenario, se vuelve una orden de compra (WP-C14) con el origen
  registrado.
· El umbral de margen para alertar (RF-SRC-03) es CONFIGURABLE, no un
  número fijo en el código.

Alcance: escenarios, comparación, alerta de margen, conversión a orden de
compra. Sin canales de venta (RF-MKT-08…10, fuera del bloque C).
```

---

### Sesión 37 — WP-C17 · Ventas: pedidos, totales, IVA

```
Antes de tocar nada: git checkout -b feat/c17-sales-orders

Tomá WP-C17 del backlog.

Leé primero: .claude/rules/api.md, .claude/rules/domain.md,
docs/domain-rules.md (RN-VTA-01, RN-EST-02, RN-IVA completo),
packages/domain/src/sales/ (order.ts de WP-A08/A09, esta sesión lo
expone), docs/especificacion-software.md (RF-VTA-01 a RF-VTA-03).

Objetivo: módulo ventas — pedidos de mostrador con líneas de cualquier
tipo de variante, totales, IVA.

Criterio de aceptación: RF-VTA-01 a RF-VTA-03. Un total inconsistente
(que no cumpla total = subtotal − descuento + envío) se rechaza.

TRAMPAS DE ESTA TAREA:
· total_pyg = subtotal − discount + shipping es un INVARIANTE impuesto
  por la base (RN-VTA-01) — el endpoint no "confía" en el total que manda
  el cliente, lo recalcula o lo valida contra el cálculo de dominio.
· El pedido nace en `draft` y pasa a `awaiting_payment` (RN-EST-02) — esta
  sesión NO toca inventario todavía: RN-VTA-02 es explícito en que el
  inventario se consume recién al CONFIRMARSE EL PAGO, no al crear el
  pedido. Si esta sesión inserta un movimiento de inventario, está
  adelantando trabajo de WP-C19.
· El IVA es RN-IVA (WP-A04): extraído del precio con impuesto incluido,
  nunca una multiplicación por 0.10 aparte.
· Un pedido mixto (RN-VTA-05) combina decants, sellados y serializados en
  la misma transacción — cada línea sigue su propia lógica de consumo,
  pero eso es C19; acá alcanza con que el modelo de línea soporte los tres
  tipos.

Alcance: creación del pedido, líneas, totales, IVA. Reservas (C18),
confirmación con consumo (C19), señas (C20) y anulación (C21) son
sesiones propias.
```

---

### Sesión 38 — WP-C18 · Ventas: reservas con TTL

```
Antes de tocar nada: git checkout -b feat/c18-reservations

Tomá WP-C18 del backlog.

Leé primero: .claude/rules/api.md, .claude/rules/domain.md,
docs/domain-rules.md (RN-RES completo), ADR-019,
packages/domain/src/sales/reservation.ts (WP-A09).

Objetivo: reservas de stock al comprometer una venta, con TTL según medio
de pago y un job que libera las vencidas.

Criterio de aceptación: RF-VTA-04. Una reserva vencida se libera en menos
de 5 minutos (RN-RES-04: el job corre cada 5 min).

TRAMPAS DE ESTA TAREA:
· Los TTL son la tabla de RN-RES-02 exacta: 15 min checkout, 30 min
  tarjeta pendiente, 48 h transferencia, hasta el vencimiento de la seña,
  hasta 30 días la retención manual — no un único TTL genérico.
· El carrito NO reserva (RN-RES-01, ADR-019) — la reserva nace en el
  checkout/al comprometer la venta, no antes. Si esta sesión reserva al
  agregar al carrito, contradice el ADR directamente.
· Una reserva liberada NO se reactiva (RN-RES-04): se crea una nueva. No
  hay un "revivir" una reserva vencida.
· `disponible = saldo_proyectado − Σ reservas vivas` (RN-RES-03) es el
  cálculo que WP-C10 (saldos) va a necesitar extender una vez que esta
  sesión exista — decilo en el PR si C10 ya está cerrado y necesita un
  ajuste, no lo edites en silencio.

Alcance: reservas y el job de liberación. El conflicto en checkout
(RN-RES-05, qué pasa si la reserva venció al confirmar el pago) es de
WP-C19, no de esta sesión.
```

---

### Sesión 39 — WP-C19 · Ventas: confirmación, consumo y COGS

```
Antes de tocar nada: git checkout -b feat/c19-sale-confirmation

Tomá WP-C19 del backlog.

Leé primero: .claude/rules/api.md, .claude/rules/domain.md,
docs/domain-rules.md (RN-VTA-02, RN-VTA-05, RN-RES-05, RN-COS-04),
docs/api-conventions.md (sección 8.2, bloqueo), ADR-007, ADR-008.

Objetivo: confirmación de venta — consumo real de inventario, cálculo y
persistencia del COGS por línea, con bloqueo de lotes ordenado para
soportar concurrencia.

Criterio de aceptación: RF-VTA-05, RF-VTA-06. Test de concurrencia que
demuestre que dos confirmaciones simultáneas sobre pedidos multilínea que
tocan los mismos lotes NO producen interbloqueo.

TRAMPAS DE ESTA TAREA — es el paquete de mayor riesgo del proyecto:
· Bloqueo de lotes en orden ASCENDENTE de lot_id, en una sola sentencia
  (SELECT ... FOR UPDATE ORDER BY id, docs/api-conventions.md §8.2). Sin
  orden determinístico, dos pedidos multilínea que tocan los mismos lotes
  en orden distinto producen interbloqueo — y esto no se ve en desarrollo
  con datos de prueba, aparece con carga real. El comentario de por qué va
  en el código, porque es exactamente el detalle que alguien "prolija" en
  un refactor futuro.
· El inventario se consume AL CONFIRMARSE EL PAGO, no al crear el pedido
  (RN-VTA-02) — esta es la sesión donde el movimiento de inventario recién
  ocurre, no antes.
· Si la reserva venció y el stock ya no alcanza: RECHAZAR, reembolsar el
  pago, cancelar el pedido con motivo `stock_no_disponible` (RN-RES-05).
  NUNCA se confirma una venta sin stock, bajo ninguna circunstancia — ni
  siquiera "solo por esta vez" con aprobación manual.
· Un pedido mixto (RN-VTA-05) combina lógicas de consumo distintas en la
  MISMA transacción: sellado consume del lote directo, decant dispara
  planDecant (WP-C13) que reserva y genera una orden de fraccionamiento
  pendiente (no consumo inmediato de granel), serializado mueve
  exactamente 1 unidad y pasa a `sold` (RN-VTA-04). No trates las tres
  líneas con el mismo camino de código.
· El COGS se calcula y persiste por línea y por pedido (RF-VTA-06,
  allocateFromLots de WP-A06) — no un promedio, capas reales.

Revisión cruzada OBLIGATORIA antes de fusionar (ver §4.2 y §6). No cierres
esta sesión sin ella, sin importar cuán verde esté la suite local.

Alcance: solo confirmación de pago → consumo → COGS → bloqueo. Reservas
(C18) y fraccionamiento (C13) ya existen como módulos, esta sesión los
orquesta.
```

---

### Sesión 40 — WP-C20 · Ventas: señas y aplicación

```
Antes de tocar nada: git checkout -b feat/c20-deposits

Tomá WP-C20 del backlog.

Leé primero: .claude/rules/api.md, .claude/rules/domain.md,
docs/domain-rules.md (RN-SEN completo), ADR-013,
packages/domain/src/sales/deposit.ts (WP-A09).

Objetivo: señas de clientes como pasivo, con aplicación explícita a un
pedido.

Criterio de aceptación: RF-VTA-07, RF-VTA-08.

TRAMPAS DE ESTA TAREA:
· La seña es un PASIVO (RN-SEN-01, ADR-013): acredita
  2.1.02.001 Señas de clientes. No es ingreso hasta que se aplica a una
  venta — si el endpoint la trata como ingreso al recibirla, el asiento
  contable (cuando exista, bloque H) va a estar mal desde acá.
· applied_pyg + refunded_pyg ≤ amount_pyg es un INVARIANTE (RN-SEN-02),
  impuesto por la base — no una validación que el servicio pueda saltarse
  porque "ya viene validado del frontend".
· Una seña puede aplicarse a VARIOS pedidos, y un pedido puede recibir
  VARIAS señas (RN-SEN-03) — cada aplicación es su propia fila con su
  monto, no un campo único "pedido aplicado" en la seña.
· Una seña vencida con saldo sin aplicar NO se cancela automáticamente
  (RN-SEN-04) — aparece en un reporte para decisión humana. No le agregues
  un cron que la cancele "para prolijidad": es una decisión de negocio y
  contable, no del sistema.

Alcance: registro y aplicación de señas. El asiento contable de la seña
(RN-CTB-04) es bloque H, no de esta sesión — acá solo la parte
transaccional del pasivo.
```

---

### Sesión 41 — WP-C21 · Ventas: anulación por reversión

```
Antes de tocar nada: git checkout -b feat/c21-sale-voiding

Tomá WP-C21 del backlog.

Leé primero: .claude/rules/api.md, .claude/rules/domain.md,
docs/domain-rules.md (RN-VTA-03, RN-EST-02, el criterio de fondo de
RN-EST completo), docs/especificacion-software.md (RF-VTA-09).

Objetivo: anulación de una venta confirmada, generando movimientos de
reversión hacia los mismos lotes de origen.

Criterio de aceptación: RF-VTA-09. Los movimientos ORIGINALES quedan
intactos — la anulación no los edita ni los borra.

TRAMPAS DE ESTA TAREA:
· Anular genera movimientos `return_in` NUEVOS hacia los mismos lotes de
  origen, con el MISMO costo (RN-VTA-03) — nunca se editan los movimientos
  originales, el ledger sigue siendo append-only también acá.
· `cancelled` y `refunded` no son sinónimos (RN-EST-02): `cancelled` es
  "nunca pasó nada" (solo alcanzable desde draft/awaiting_payment, antes
  de que el inventario se tocara); `refunded` es "pasó algo y se revierte"
  — desde `paid` en adelante, la salida es SIEMPRE `refunded`, nunca
  `cancelled`. Esta sesión trabaja sobre pedidos ya `paid` o posteriores,
  así que su salida es refunded.
· Reversión, no reprocesamiento: no vuelvas a correr planDecant/
  executeDecant al revés para "deshacer" un fraccionamiento — generá el
  movimiento de reversión directamente, con el costo que ya quedó
  registrado en movement_cost_allocations.

Alcance: la anulación por reversión de una venta confirmada. Devoluciones
con inspección de mercadería (RF-VTA-12) son bloque I, posterior.
```

---

### Sesión 42 — WP-C22 · Contabilidad: plan de cuentas, caja, arqueo

```
Antes de tocar nada: git checkout -b feat/c22-accounting-core

Tomá WP-C22 del backlog.

Leé primero: .claude/rules/api.md, .claude/rules/domain.md,
docs/domain-rules.md (RN-CTB-01, RN-CTB-02), ADR-012,
docs/data-model.md (sección 3.6), packages/db/seed/ (el plan de cuentas
sembrado en WP-B02).

Objetivo: módulo contabilidad — plan de cuentas jerárquico, movimientos de
caja en guaraníes y dólares, arqueo.

Criterio de aceptación: RF-CTB-01, RF-CTB-02.

TRAMPAS DE ESTA TAREA:
· El plan de cuentas YA existe, sembrado por WP-B02 (packages/db/seed/) —
  esta sesión lo administra (CRUD sobre cuentas imputables y de
  agrupación), no lo vuelve a crear. Y sigue siendo el que hay que validar
  con el contador (pendiente abierto en CLAUDE.md, no de esta sesión).
· El MOTOR DE POSTEO (asientos derivados de eventos, RN-CTB-01, RF-CTB-03)
  es bloque H, explícitamente posterior — esta sesión NO genera asientos
  automáticos todavía. Caja y arqueo son movimientos que el operador
  registra directo, no derivados de una regla.
· SUM(debe) = SUM(haber) por asiento (RN-CTB-02) es un invariante para
  cuando SÍ haya asientos (bloque H) — dejalo documentado como
  restricción del modelo, aunque el motor que los genera todavía no
  exista.
· Caja en dos monedas (guaraníes y dólares): cada movimiento en moneda
  extranjera lleva sus cuatro campos (amount_minor, currency,
  fx_rate_to_pyg, amount_pyg como snapshot) — el mismo patrón de WP-A05,
  no uno nuevo para caja.

Alcance: plan de cuentas, caja, arqueo. El motor de posteo es bloque H.
```

---

### Sesión 43 — WP-C23 · Fiscal: documentos y puerto

```
Antes de tocar nada: git checkout -b feat/c23-fiscal-documents

Tomá WP-C23 del backlog.

Leé primero: .claude/rules/api.md, .claude/rules/domain.md,
docs/domain-rules.md (RN-FIS completo), ADR-014.

Objetivo: módulo fiscal — documentos como entidad separada de la venta,
puerto FiscalProvider con un adaptador manual.

Criterio de aceptación: RF-FIS-01 a RF-FIS-04, RF-FIS-07.

TRAMPAS DE ESTA TAREA:
· NO se construye el integrador SIFEN en esta sesión. Se construye el
  PUERTO (FiscalProvider) y UN SOLO adaptador: el manual, que registra el
  CDC que alguien cargó a mano desde fuera del sistema (RF-FIS-04). El
  adaptador homologado de proveedor (RF-FIS-05/06) es WP-H07, posterior,
  y depende además de un pendiente de negocio (el grupo SIFEN del RUC de
  JODA, todavía sin determinar). Ver ADR-014.
· total_pyg = taxed_10 + taxed_5 + exempt (RN-FIS-02) — el desglose por
  tasa es obligatorio en el documento, no un cálculo aparte que pueda
  desalinearse del total.
· Un documento en `approved` SIEMPRE tiene código de control (RN-FIS-03,
  RF-FIS-07) — impuesto por la base, no solo validado en el servicio.
· Una nota de crédito/débito referencia OBLIGATORIAMENTE el documento que
  rectifica (RN-FIS-01) — no hay nota de crédito "suelta".

Alcance: el puerto, el adaptador manual, los documentos. El adaptador
homologado es WP-H07.
```

---

### Sesión 44 — WP-C24 · Seguridad: usuarios y roles

```
Antes de tocar nada: git checkout -b feat/c24-user-admin

Tomá WP-C24 del backlog.

Leé primero: .claude/rules/api.md, docs/security-spec.md (sección 2
completa, sección 3.2), ADR-016.

Objetivo: administración de usuarios de personal y sus roles, sobre el
middleware de permisos de WP-C05.

Criterio de aceptación: RF-SEG-03, RF-SEG-06. Revocar un permiso tiene
efecto en menos de 2 minutos.

TRAMPAS DE ESTA TAREA:
· La revocación rápida sale GRATIS si WP-C05 usó Redis con TTL 60 s como
  corresponde (docs/security-spec.md §3.2) — esta sesión no necesita
  inventar un mecanismo de invalidación aparte, solo asegurarse de
  invalidar/actualizar la entrada de caché al cambiar el rol, no esperar
  a que expire sola.
· `settings.user:write` (crear/editar usuarios y roles) es exclusivo de
  `owner` según la matriz de roles (docs/security-spec.md §2.1) — ni
  `manager` lo tiene. No relajes esa fila sin confirmarlo.
· Un cliente nunca puede tener rol de personal — es un invariante de
  esquema (ADR-015), no algo que este módulo tenga que validar a mano.

Alcance: administración de usuarios y roles de personal. El catálogo de
permisos en sí ya existe (docs/security-spec.md §2), esta sesión no lo
redefine.
```

---

### Sesión 45 — WP-C25 · Observabilidad

```
Antes de tocar nada: git checkout -b feat/c25-observability

Tomá WP-C25 del backlog.

Leé primero: .claude/rules/api.md, docs/especificacion-software.md
(sección 3.6, RNF-OBS completo), docs/data-model.md (sección 5, vistas —
v_balance_drift es la fuente de la alerta de deriva).

Objetivo: bitácoras estructuradas, identificador de correlación
propagado, y las seis alertas de negocio.

Criterio de aceptación: RNF-OBS-01 a RNF-OBS-04. Las seis alertas
configuradas: saldo negativo, deriva de proyección, asiento descuadrado,
evento sin postear con más de 24 h, notificación de pago fallida, margen
negativo.

TRAMPAS DE ESTA TAREA:
· El identificador de correlación (requestId, ya armado en el contexto de
  WP-C01) se propaga a TODAS las bitácoras de una petición, no solo al log
  de entrada — si un error ocurre tres capas más abajo, tiene que llevar
  el mismo requestId.
· Dos de las seis alertas (asiento descuadrado, evento sin postear +24h)
  dependen de que exista el motor de posteo — que es bloque H, todavía no
  construido. Dejalas CONFIGURADAS y documentadas como "sin datos que
  disparen todavía", no las inventes simulando eventos que el sistema no
  genera aún.
· La deriva de proyección se apoya en v_balance_drift (docs/data-model.md
  §5), la misma vista que WP-B03/B06 ya usan en los tests de invariantes —
  no crees una consulta nueva que calcule lo mismo de otra forma.
· Los errores no controlados van a un sistema de seguimiento con traza y
  contexto (RNF-OBS-04) — esto es DISTINTO de las bitácoras estructuradas
  de negocio (RNF-OBS-02): un logger no reemplaza a un tracker de errores.

Alcance: bitácoras, correlación, las seis alertas (dos de ellas
configuradas pero inertes hasta el bloque H). Sin dashboard de
visualización — eso es reportes (bloque E/G), no de esta sesión.
```

---

### Reparto entre agentes — Fase 2

**Esta tabla reparte quién IMPLEMENTA, no quién revisa.** Que un paquete quede con Codex acá no lo saca de la revisión — la mayoría de los que Codex puede implementar son igual de riesgo alto por permisos, dinero, autenticación o la frontera fiscal, no solo por el ledger. Quién revisa cada uno, y con qué rigor, lo decide §6 "Niveles de rigor por paquete" — de forma independiente de esta tabla, y aplica igual sin importar qué agente implementó.

El criterio de esta tabla es **qué escribe en el ledger de inventario** (`inventory_movements`, append-only desde WP-B01). CLAUDE.md ya lo dice para el código en sí — corregir un error ahí es insertar un movimiento de ajuste, nunca editar uno existente — y eso vale tanto para quien lo escribe como para quien lo revisa después: un `git revert` deshace el código que produjo una fila mal escrita, pero no deshace la fila ya insertada en un Postgres compartido. Los paquetes que insertan movimientos reales del ledger quedan con Claude Code, que tiene encima los guardas mecánicos de `.claude/` (bloqueo de `prisma migrate`, formateo automático, hooks). El resto puede repartirse con Codex, porque AGENTS.md es explícito en que **esos guardas mecánicos no protegen a Codex** — ahí las reglas "mecánicas" de Claude Code vuelven a ser de confianza, y conviene reservar esa situación para paquetes donde un descuido de implementación sale barato de corregir. Cuando Codex implementa un paquete de riesgo alto según §6, la revisión en sesión limpia le toca a Claude Code — nunca a Codex revisándose a sí mismo.

| Sesión | WP  | ¿Escribe en `inventory_movements`?                           | Implementa                      | Por qué                                                                                                                 |
| ------ | --- | ------------------------------------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 28     | C08 | No                                                           | Codex                           | Catálogo puro, sin tocar stock.                                                                                         |
| 29     | C09 | No                                                           | Codex                           | Archivos y derivados, sin tocar stock — pero riesgo alto igual por §6 (carga de archivos), con revisión de Claude Code. |
| 30     | C10 | Sí (ajustes)                                                 | **Claude Code**                 | Un ajuste mal escrito es una fila de ledger real, no reversible con `git revert`.                                       |
| 31     | C11 | Sí                                                           | **Claude Code**                 | Conversión de lote en cuatro pasos transaccionales (ADR-009); un error deja un frasco a medio abrir.                    |
| 32     | C12 | Sí (indirecto, vía venta/transferencia)                      | **Claude Code**                 | Trazabilidad serial es tan irreversible como el resto del ledger.                                                       |
| 33     | C13 | Sí                                                           | **Claude Code**                 | Ejecución consume granel + insumos reales; la mitad más delicada del dominio (WP-A07).                                  |
| 34     | C14 | No                                                           | Codex                           | La orden de compra no genera stock hasta la recepción (C15).                                                            |
| 35     | C15 | Sí                                                           | **Claude Code**                 | Genera lotes y sus movimientos de entrada, de forma transaccional.                                                      |
| 36     | C16 | No, por diseño (RF-SRC-04)                                   | Codex                           | Un escenario no debe tocar inventario ni caja — si lo hiciera, sería el bug del WP.                                     |
| 37     | C17 | No (RN-VTA-02: se consume al confirmar el pago, no al crear) | Codex                           | El pedido en sí no mueve stock todavía — pero riesgo alto igual por §6 (dinero/totales), con revisión de Claude Code.   |
| 38     | C18 | No (reservas son su propia tabla)                            | Codex                           | El job de liberación no inserta movimientos del ledger.                                                                 |
| 39     | C19 | Sí — el de mayor riesgo del proyecto                         | **Claude Code, exclusivamente** | Consumo real + COGS + bloqueo bajo concurrencia. Revisión en sesión limpia obligatoria además (§6).                     |
| 40     | C20 | No (toca caja/pasivo, no inventario)                         | Codex                           | Dinero, pero no el ledger de stock — riesgo alto igual por §6, con revisión de Claude Code.                             |
| 41     | C21 | Sí (`return_in`)                                             | **Claude Code**                 | Inserta movimientos de reversión reales hacia lotes reales.                                                             |
| 42     | C22 | No (caja/plan de cuentas, no inventario)                     | Codex                           | Dinero, pero no el ledger de stock — riesgo alto igual por §6, con revisión de Claude Code.                             |
| 43     | C23 | No                                                           | Codex                           | Documentos fiscales, sin tocar stock ni caja — riesgo alto igual por §6 (frontera fiscal).                              |
| 44     | C24 | No                                                           | Codex                           | Sensible por seguridad, no escribe el ledger — riesgo alto igual por §6 (permisos), con revisión de Claude Code.        |
| 45     | C25 | No                                                           | Codex                           | Solo lectura y configuración de alertas.                                                                                |

La Fase 1 (Sesiones 21 a 27) queda fuera de este reparto porque es secuencial y de cimiento: conviene que la lleve una sola sesión/agente de punta a punta para que `withTenantTx`, el mapeador de errores y el middleware de permisos salgan coherentes entre sí, en vez de conciliar cuatro estilos distintos después. Todas sus sesiones son riesgo alto según §6 salvo C01, C06 y C07.

---

### Sesión de ejemplo — WP-E01 · Tokens de diseño

El primer paquete de frontend merece su propio prompt porque es donde un agente, sin instrucciones, produce la estética genérica.

```
Antes de tocar nada: git checkout -b feat/e01-design-tokens

Tomá WP-E01 del backlog.

Leé primero: docs/frontend-spec.md COMPLETO, ADR-023, ADR-003.

Objetivo: packages/ui/src/styles/tokens.css con los tokens de JODA Parfums
en formato @theme de Tailwind v4.

Contexto de marca: te adjunto el logo, los empaques y capturas del Instagram
actual. Los tokens se DERIVAN de eso, no se inventan.

Criterio de aceptación: entre 4 y 6 colores base con nombre y hexadecimal,
dos tipografías como máximo con roles distintos, una escala tipográfica y
una de espaciado, y un radio por jerarquía. Contraste AA verificado en cada
par texto/fondo, con los números. El archivo es consumible desde
`apps/storefront` y `apps/admin` por igual, sin nada específico de uno solo.

TRAMPAS DE ESTA TAREA:
· NO produzcas ninguno de los defaults de frontend-spec.md §3.3: fondo crema
  con serif de alto contraste y acento terracota; negro con acento verde
  ácido; el kit de tarjetas SaaS con el mismo radio y la misma sombra en
  todo; versalitas espaciadas encima de cada título.
· Tailwind v4 no usa tailwind.config.js. Los tokens van en CSS con @theme.
· El mismo archivo sirve al storefront Y al admin. Comparten tokens, no
  estética ni densidad.

Antes de escribir código: proponeme el plan de tokens en prosa, con los
hexadecimales y el razonamiento de por qué cada uno sale de la marca. Si
alguna parte del plan es lo que producirías para cualquier perfumería,
revisala y decime qué cambiaste. Recién con el plan aprobado, escribí el CSS.
```

El paso final —plan antes que código— es el que más diferencia hace. Un agente que escribe CSS directo produce el default; uno que tiene que justificar cada color contra la marca, no.

**Estado de E01 (25/09/2026).** `tokens.css` ya define los roles compartidos y registra `packages/ui/src` con `@source` para que Tailwind detecte las clases del paquete. Las declaraciones `@font-face` están en el CSS del admin (`apps/admin/src/fonts.css`); `next/font/local` y las variables de fuentes del storefront corresponden a WP-G01. La fila WP-E01 del backlog todavía figura sin cerrar: actualizar ese estado por su propio circuito antes de tratar E02 como libre.

## Bloque E — Admin y UI compartida

El estado de cada sesión sigue las dependencias y casillas de `docs/backlog.md` al 25/09/2026. Revalidalo antes de copiar un prompt. Para Codex, anteponé el preámbulo de §3 a **cada** sesión.

### Sesión E02 — WP-E02 · Primitivas shadcn

**Dependencia:** E01. **Estado hoy:** esperando el cierre de E01 en el backlog.

```
Antes de tocar nada: git checkout -b feat/e02-ui-primitives

Tomá WP-E02 del backlog.

Leé primero: docs/frontend-spec.md §2 y §4, ADR-023,
.claude/rules/frontend.md y packages/ui/src/styles/tokens.css.

Objetivo: agregar primitivas shadcn sobre Radix en packages/ui.

Criterio de aceptación: components.json vive en packages/ui con el alias
correcto; verificá que npx shadcn add deposite los archivos allí y no en
un app. Mapeá background, foreground, primary, destructive, muted, ring e
input a roles de tokens.css. Agregá un lint o chequeo de CI que falle si
un className usa primitivos joda-*. Evaluá migrar tokens.test.mjs a Vitest.

TRAMPAS DE ESTA TAREA:
· No crees una segunda paleta paralela al mapear los nombres de shadcn.
· Dejá solo primitivas genéricas en packages/ui; las composiciones viven en
  cada app. El storefront comparte estas primitivas: sin Framer Motion.

Alcance: solo WP-E02. Si el alcance crece, pará y consultá.
```

### Sesión E03 — WP-E03 · Formateo compartido

**Dependencia:** A01. **Estado hoy:** libre.

```
Antes de tocar nada: git checkout -b feat/e03-ui-format

Tomá WP-E03 del backlog.

Leé primero: docs/frontend-spec.md §4, ADR-023,
.claude/rules/frontend.md y .claude/rules/testing.md.

Objetivo: crear packages/ui/format para dinero, cantidades y fechas.

Criterio de aceptación: el dinero recibido como string de unidades menores
se muestra como Gs. 245.000; las cantidades en ml admiten hasta tres
decimales con coma (114,65 ml), las unidades no tienen decimales y las
fechas usan dd/mm/aaaa en America/Asuncion. Ningún otro módulo formatea
por su cuenta.

TRAMPAS DE ESTA TAREA:
· Usá BigInt(minor) con Intl.NumberFormat, nunca Number(minor). Compará la
  salida real de es-PY con el formato exigido en Node y en el navegador:
  sus datos ICU pueden diferir. Si no coincide, componé el separador de
  miles con puntos de forma explícita.
· Usá la zona America/Asuncion por nombre, nunca un desplazamiento fijo.
  Paraguay quedó en UTC−3 permanente desde octubre de 2024, pero un ICU
  viejo puede aplicar horario de verano. Probá una fecha de enero y otra
  de julio.

Alcance: solo WP-E03. Si el alcance crece, pará y consultá.
```

### Sesión E04 — WP-E04 · Base del admin

**Dependencias:** C05 (cerrado), E02. **Estado hoy:** esperando E02.

```
Antes de tocar nada: git checkout -b feat/e04-admin-base

Tomá WP-E04 del backlog.

Leé primero: docs/frontend-spec.md §2 y §5, docs/security-spec.md,
ADR-023, .claude/rules/frontend.md y .claude/rules/testing.md.

Objetivo: establecer enrutado, sesión, <Can> y guardas del admin.

Criterio de aceptación: la sesión usa la cookie __Host-joda_a; quien no
tiene MFA inscripto solo ve la inscripción. El admin consume tRPC con
TanStack Query. Las rutas cargan sus módulos en diferido: verificá en los
chunks del build que un vendedor no descarga contabilidad.

TRAMPAS DE ESTA TAREA:
· <Can> y las guardas mejoran la experiencia; no son la barrera de
  seguridad. La API impone permisos y responde 404.
· No afirmes la carga diferida por leer el código: inspeccioná el build.

Alcance: solo WP-E04. Si el alcance crece, pará y consultá.
```

### Sesión E05 — WP-E05 · Catálogo en el admin

**Dependencias:** C08 y C09 (cerrados), E04. **Estado hoy:** esperando E04.

```
Antes de tocar nada: git checkout -b feat/e05-admin-catalog

Tomá WP-E05 del backlog.

Leé primero: docs/frontend-spec.md §8 y §9, docs/api-conventions.md,
ADR-023, .claude/rules/frontend.md y .claude/rules/contracts.md.

Objetivo: agregar alta y edición de perfumes, relojes y accesorios al admin.

Criterio de aceptación: cada vertical tiene su formulario con
react-hook-form y zodResolver sobre el esquema de packages/contracts;
categorías N:N con exactamente una primaria; importes con separador de
miles en pantalla y enviados como string de unidades menores.

TRAMPAS DE ESTA TAREA:
· No copies esquemas ni armes un formulario genérico con campos opcionales.
· Subí imágenes por la ruta multipart de C09, no por tRPC.

Alcance: solo WP-E05. Si el alcance crece, pará y consultá.
```

### Sesión E12 — WP-E12 · Accesibilidad y paleta de comandos

**Dependencia:** E04. **Estado hoy:** esperando E04.

```
Antes de tocar nada: git checkout -b feat/e12-admin-keyboard

Tomá WP-E12 del backlog.

Leé primero: docs/frontend-spec.md §3 y §10, ADR-023,
.claude/rules/frontend.md y .claude/rules/testing.md.

Objetivo: hacer operables por teclado los flujos frecuentes del admin.

Criterio de aceptación: foco visible siempre, navegación completa por
teclado y paleta de comandos con cmdk para operaciones frecuentes sin mouse.

TRAMPAS DE ESTA TAREA:
· El atajo de la paleta no debe quitar el foco visible ni interceptar la
  escritura en un campo.
· Verificá apertura, navegación, ejecución y cierre solo con teclado.

Alcance: solo WP-E12. Si el alcance crece, pará y consultá.
```

### Sesión E06 — WP-E06 · Inventario en el admin

**Dependencias:** C10 (cerrado), C11, C12 y E04. **Estado hoy:** esperando C11, C12 y E04.

```
Antes de tocar nada: git checkout -b feat/e06-admin-inventory

Tomá WP-E06 del backlog.

Leé primero: docs/frontend-spec.md §8, docs/domain-rules.md, ADR-009,
.claude/rules/frontend.md y .claude/rules/testing.md.

Objetivo: agregar consulta de saldos, ajustes y apertura de frasco al admin.

Criterio de aceptación: los saldos y el historial se consultan desde la
API; todo ajuste exige motivo; la apertura de frasco exige confirmación
explícita antes de ejecutar la conversión irreversible.

TRAMPAS DE ESTA TAREA:
· No presentes la apertura como cambio de estado: convierte un lote sellado
  de unidades en un lote hijo de granel en ml.
· No permitas que un ajuste sin motivo ni una confirmación accidental
  disparen la mutación.

Alcance: solo WP-E06. Si el alcance crece, pará y consultá.
```

### Sesión E09 — WP-E09 · Compras y sourcing

**Dependencias:** C14, C15, C16 y E04. **Estado hoy:** esperando todas.

```
Antes de tocar nada: git checkout -b feat/e09-admin-procurement

Tomá WP-E09 del backlog.

Leé primero: docs/frontend-spec.md §8.7, docs/domain-rules.md,
ADR-023, .claude/rules/frontend.md y .claude/rules/testing.md.

Objetivo: agregar compras, recepciones y sourcing al admin.

Criterio de aceptación: al cargar flete y otros costos, la vista previa
recalcula costo puesto y margen en vivo, antes de confirmar la recepción;
los escenarios de sourcing permiten comparar alternativas.

TRAMPAS DE ESTA TAREA:
· Reusá allocateFreight y computeLandedCost de packages/domain para la
  vista previa en el navegador; el dominio es puro y puede ejecutarse allí.
· El servidor sigue siendo la fuente de verdad y recalcula al confirmar.
  No conviertas una vista previa ni un escenario en movimiento de stock.

Alcance: solo WP-E09. Si el alcance crece, pará y consultá.
```

### Sesión E07 — WP-E07 · Fraccionamiento

**Dependencias:** C13 y E04. **Estado hoy:** esperando ambas.

```
Antes de tocar nada: git checkout -b feat/e07-admin-decants

Tomá WP-E07 del backlog.

Leé primero: docs/frontend-spec.md §8.6, docs/domain-rules.md, ADR-009,
.claude/rules/frontend.md y .claude/rules/testing.md.

Objetivo: agregar la cola de órdenes de fraccionamiento al admin.

Criterio de aceptación: la cola se agrupa por frasco de origen; la merma
real es obligatoria, aparece precargada con la esperada y puede editarse
antes de ejecutar la orden.

TRAMPAS DE ESTA TAREA:
· No contabilices la merma esperada como real ni ejecutes sin declarar la
  real: la expectativa solo sirve para planificar o reservar.
· Mantené visible el origen al operar varias órdenes del mismo frasco.

Alcance: solo WP-E07. Si el alcance crece, pará y consultá.
```

### Sesión E08 — WP-E08 · Ventas de mostrador

**Dependencias:** C17, C18, C19, C20, C21 y E04. **Estado hoy:** esperando todas.

```
Antes de tocar nada: git checkout -b feat/e08-admin-sales

Tomá WP-E08 del backlog.

Leé primero: docs/frontend-spec.md §8 y §9, docs/domain-rules.md,
docs/api-conventions.md, .claude/rules/frontend.md y .claude/rules/testing.md.

Objetivo: completar la venta de mostrador en el admin.

Criterio de aceptación: el operador puede completar una venta presencial;
la confirmación envía Idempotency-Key y un doble clic no crea dos ventas.
Ante un conflicto de stock, la pantalla explica en español qué pasó y
ofrece una acción de recuperación.

TRAMPAS DE ESTA TAREA:
· Conservá la misma clave de idempotencia en los reintentos de la misma
  confirmación; no generes una nueva por cada clic.
· No muestres códigos técnicos de conflicto ni calcules totales de negocio
  en el cliente: la API da el resultado autoritativo.

Alcance: solo WP-E08. Si el alcance crece, pará y consultá.
```

### Sesión E10 — WP-E10 · Contabilidad y caja

**Dependencias:** C22 y E04. **Estado hoy:** esperando ambas.

```
Antes de tocar nada: git checkout -b feat/e10-admin-accounting

Tomá WP-E10 del backlog.

Leé primero: docs/frontend-spec.md, docs/domain-rules.md, ADR-023,
.claude/rules/frontend.md y .claude/rules/testing.md.

Objetivo: agregar contabilidad y caja al admin.

Criterio de aceptación: el flujo permite el arqueo diario de caja y
presenta los datos contables que entrega la API.

TRAMPAS DE ESTA TAREA:
· No generes asientos ni calcules saldos contables en el cliente.
· Presentá diferencias del arqueo con claridad, sin redondearlas para
  aparentar que la caja cuadra.

Alcance: solo WP-E10. Si el alcance crece, pará y consultá.
```

### Sesión E11 — WP-E11 · Reportes

**Dependencias:** C25 y E04. **Estado hoy:** esperando ambas.

```
Antes de tocar nada: git checkout -b feat/e11-admin-reports

Tomá WP-E11 del backlog.

Leé primero: docs/frontend-spec.md, docs/especificacion-software.md
(RF-REP-01…04),
ADR-023, .claude/rules/frontend.md y .claude/rules/testing.md.

Objetivo: agregar los cuatro reportes del backlog al admin con Recharts.

Criterio de aceptación: RF-REP-01…04 visibles y legibles; los valores
provienen de la API y las visualizaciones usan Recharts.

TRAMPAS DE ESTA TAREA:
· No calcules métricas de negocio ni reconstruyas agregados en el cliente.
· No confundas alertas de observabilidad de C25 con los cuatro reportes:
  verificá las definiciones de RF-REP-01…04 antes de diseñar gráficos.

Alcance: solo WP-E11. Si el alcance crece, pará y consultá.
```

### Sesión de ejemplo — WP-G03 · URLs y facetas

```
Antes de tocar nada: git checkout -b feat/g03-storefront-urls-facets

Tomá WP-G03 del backlog.

Leé primero: docs/frontend-spec.md §6 completo, docs/data-model.md §5.

Objetivo: estructura de URLs del storefront y política de indexación de
facetas.

Criterio de aceptación: la tabla de §6.3 implementada — qué faceta es ruta
indexable y cuál es parámetro con noindex y canónica a la ruta base.
Tabla de slugs históricos con redirección 301. Combinación de dos o más
facetas siempre noindex.

TRAMPA DE ESTA TAREA: es el error de posicionamiento más común en
e-commerce. Familia × concentración × marca × precio genera URLs infinitas,
Google gasta el presupuesto de rastreo en variantes vacías e indexa
duplicados. Si dejás indexable cualquier combinación, el trabajo de las
demás sesiones de SEO no sirve.

Alcance: solo el enrutado y los metadatos de indexación. El catálogo con
filtros es WP-G04.
```

---

## 3. Plantilla para el resto

### Preámbulo para Codex — pegar antes de cada prompt de sesión

Codex no carga la skill `tomar-wp` ni `.claude/rules/` por ruta. Pegá este bloque **antes** del prompt específico de cada WP que tome Codex:

```
Trabajás en el worktree joda-codex-ui. Antes de tocar nada, ejecutá
git checkout main && git pull y creá la rama propia del WP.

Leé SIEMPRE AGENTS.md, .claude/rules/frontend.md,
.claude/rules/contracts.md, .claude/rules/testing.md,
docs/frontend-spec.md, ADR-023 y la fila del WP en docs/backlog.md.
Leé además todos los documentos que nombre el prompt de esta sesión.

Si un criterio de este playbook difiere del backlog, pará y reportá la
diferencia: manda el backlog. Reuní todas las ambigüedades antes de escribir
código y preguntalas juntas.

Nunca toques packages/db ni la lógica de apps/api.

Al terminar, corré pnpm typecheck, pnpm lint, pnpm format:check, pnpm test y
pnpm build; todos deben quedar en verde. Commiteá y verificá git status
limpio. Recorré la lista "Antes de abrir un PR" de
docs/engineering-principles.md. Abrí el PR con la plantilla de
CONTRIBUTING.md y pedí la revisión del subagente revisor. No fusiones:
avisá cuando el PR esté listo.

Si encontrás algo fuera del alcance, anotá una fila con ID y criterio de
aceptación en docs/backlog.md; no lo dejes como nota suelta.
```

La rama del prompt de sesión identifica el WP; si ya la creaste con el preámbulo, no la crees de nuevo. La excepción de §6 para PRs de documentación pura sigue vigente: la revisión con subagente se exige en las sesiones de código.

```
Antes de tocar nada: git checkout -b feat/<área>-<tema>

Tomá WP-<id> del backlog.

Leé primero: .claude/rules/<área>.md y <documentos del área>.

Objetivo: <una frase, tomada del backlog>.

Criterio de aceptación: <el del backlog, con los números concretos si los hay>.

TRAMPAS DE ESTA TAREA:
· <el error predecible de esta área>
· <el invariante que se suele olvidar>

Alcance: solo WP-<id>. Si el alcance crece, pará y consultá.
```

### Trampas por área, para completar la plantilla

| Área                | Lo que hay que advertir                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dominio             | Nada de I/O. Result para fallos esperados, excepción para bugs. `Money`, no `number`.                                                                              |
| Esquema             | Nunca `prisma migrate`. Nunca editar una migración aplicada. `tenant_id` en toda tabla. Todo invariante nuevo lleva su prueba.                                     |
| API                 | `set_config` con tercer parámetro en `true`. Todo procedimiento declara su permiso. 404, no 403. Bloqueo en orden ascendente de `lot_id`.                          |
| Ventas              | El inventario se consume al confirmar el pago, no al crear el pedido. Anular es revertir, no editar.                                                               |
| Pagos               | El PAN no toca el sistema. Webhook idempotente por clave única. Confirmar el monto contra el proveedor.                                                            |
| DTO públicos        | Esquema distinto, no el mismo con opcionales. Test que verifica que no filtra costos ni cantidades.                                                                |
| Contabilidad        | Los asientos se derivan de reglas, no se cargan. Un asiento contabilizado se reversa, no se edita.                                                                 |
| ETL                 | Idempotente con `legacy_map`. No inventar historial: movimientos de apertura. El ETL solo lee del v2.                                                              |
| Frontend admin      | Las guardas son UX, no seguridad. Carga diferida para que el bundle no viaje. Densidad alta: no es una landing.                                                    |
| Frontend storefront | Componentes de servidor por defecto. Framer Motion fuera del camino crítico. `width` y `height` en toda imagen. El stock se muestra como estado, no como cantidad. |
| Diseño visual       | Pegá la lista de defaults genéricos de `frontend-spec.md` §3.3. Sin ella vas a recibir crema + serif + terracota.                                                  |
| SEO                 | Facetas combinadas siempre `noindex`. Los datos estructurados deben coincidir con lo que ve el usuario.                                                            |

---

## 4. Prompts auxiliares

### 4.1 Verificación antes de cerrar

Al final de cada sesión, antes del PR:

```
Antes de dar esto por terminado, recorré la lista de CLAUDE.md
"Cómo verificar tu trabajo" y reportame el resultado de cada punto,
uno por uno, con la salida real de los comandos.

Después revisá la lista de docs/engineering-principles.md
"Antes de abrir un PR" y decime honestamente cuáles no cumplís.

Confirmá también que el trabajo está en una rama propia, creada antes
de empezar, y commiteado — no suelto en el árbol de trabajo sobre main.

Si algo no está, no lo arregles todavía: listalo primero.
```

Pedir el listado antes del arreglo evita que corrija tres cosas de apuro y rompa una cuarta.

### 4.2 Revisión cruzada

En una sesión **nueva y limpia**, sin el contexto de quien escribió el código:

```
Revisá el PR de la rama <rama> como si no lo hubieras escrito vos.

Leé CLAUDE.md, docs/engineering-principles.md y los documentos del área
que toca el cambio.

Decime, en este orden:
1. ¿Resuelve el problema declarado en el PR?
2. ¿Viola alguna regla no negociable de CLAUDE.md o algún ADR? Citá cuál.
3. ¿Los tests prueban comportamiento o implementación?
4. ¿Qué no va a entender alguien que lea esto en seis meses?
5. Verificá las afirmaciones sobre el esquema, los documentos o el
   comportamiento de terceros que haga el código o el PR. No las des por
   buenas: abrí packages/db/migrations, los tests SQL y los documentos
   citados, y confirmá que dicen lo que el PR dice que dicen. Si el PR toca
   `.claude/settings.json` o los scripts de `scripts/hooks/`, esto incluye
   verificar que cada guarda tenga un test que confirme que BLOQUEA el caso
   que dice bloquear, no solo que corre sin explotar — un guarda roto falla
   permitiendo, en silencio, y ese es el peor modo de falla posible para un
   hook de seguridad.
6. Si el PR declara algo como "anotado en el backlog", "pendiente de otra
   WP" o "fuera de alcance", verificá que exista realmente, con ID y
   criterio de aceptación. Un comentario que promete una WP inexistente es
   peor que un pendiente declarado.
7. Si algo no se puede verificar con la evidencia disponible, decilo así.
   No completes con la explicación más plausible.

No arregles nada. Solo reportá.
```

Que sea una sesión nueva importa: un agente que acaba de escribir el código está sesgado a validarlo.

El circuito es de una sola vía: el revisor solo reporta. Los hallazgos vuelven
a la sesión de desarrollo, que es la que tiene la rama y el contexto de por
qué cada cosa quedó como quedó. Una vez entregado el análisis, la sesión de
revisión se cierra: dos sesiones opinando sobre el mismo código se
contradicen.

### 4.3 Cuando se desvía

```
Pará. Lo que estás haciendo contradice <ADR-0nn / la regla X de CLAUDE.md>.

Releé ese documento y decime:
· qué dice exactamente
· por qué elegiste apartarte
· si tenés un argumento para cambiar la decisión, o fue un descuido

Si es un descuido, corregí. Si tenés un argumento, escribilo y lo evalúo;
no lo apliques todavía.
```

### 4.4 Proponer un cambio de decisión

Cuando el argumento del agente resulta bueno:

```
Escribí un ADR nuevo que reemplace a ADR-0nn, siguiendo el formato de los
existentes: contexto, decisión, consecuencias positivas y negativas,
alternativas descartadas.

Marcá el anterior como reemplazado en su encabezado, y agregá la fila al
índice docs/adr/README.md.

Solo el ADR. No toques código todavía.
```

### 4.5 Depuración

```
<síntoma concreto: qué esperabas, qué pasó, con qué comando>

Antes de proponer un arreglo:
1. Reproducilo con un test que falle.
2. Decime cuál es la causa raíz, no el síntoma.
3. Verificá si la causa raíz afecta otros lugares del código.

Recién después proponé el arreglo. El test que falla queda en el PR.
```

### 4.6 Cierre de bloque

Al terminar cada bloque del backlog:

```
Terminamos el bloque <X>. Antes de avanzar:

1. Marcá los WP completados en docs/backlog.md.
2. Corré la suite completa y reportá el resultado.
3. Decime si algo de lo que construimos contradice la documentación,
   o si la documentación quedó desactualizada respecto del código.
4. Etiquetá: git tag v0.<n>.0-<nombre>

No empieces el bloque siguiente en esta sesión.
```

---

## 5. Cómo se carga el contexto

No hace falta —ni conviene— pedir que lea todo en cada sesión. El contexto es finito y llenarlo degrada la adherencia a las instrucciones. El sistema está armado en tres capas para que llegue lo justo:

| Capa                 | Qué es                                                         | Cuándo se carga                                         |
| -------------------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| `CLAUDE.md` (raíz)   | Reglas permanentes, comandos, mapa de documentación            | Automáticamente, en cada sesión                         |
| `.claude/rules/*.md` | No negociables por área, con `paths:` en el frontmatter        | Automáticamente, **cuando toca archivos que coinciden** |
| `docs/*.md`          | La profundidad: reglas de negocio, contratos, especificaciones | **Cuando el prompt los nombra**                         |

La capa del medio es la que hace el trabajo pesado. Al abrir un archivo de `packages/domain/`, se carga sola `.claude/rules/domain.md` con la regla de pureza, el criterio de `Result` contra excepción y los umbrales de cobertura. Sin que vos lo pidas y sin ocupar contexto en las sesiones donde no aplica.

Las seis reglas y su alcance:

```
domain.md      packages/domain/**/*.ts
database.md    packages/db/**
api.md         apps/api/**/*.ts
frontend.md    apps/storefront/** · apps/admin/** · packages/ui/**
contracts.md   packages/contracts/**/*.ts
testing.md     **/*.test.ts · e2e/** · packages/db/tests/**
```

### Lo que igual tenés que nombrar

Las reglas llevan los no negociables, no el detalle. Un agente que va a implementar el costeo del decant necesita los números de `domain-rules.md`, y eso no está en la regla. Por eso cada prompt de tarea sigue empezando por _"Leé primero: …"_.

**Regla práctica:** la capa automática evita que rompa algo; nombrar el documento es lo que le permite hacerlo bien.

### Verificar qué se cargó

Dentro de la sesión:

- `/context` — lista los archivos de memoria efectivamente cargados. Si algo no aparece ahí, el agente no lo está viendo.
- `/memory` — abre los archivos de memoria para editarlos.

Si notás que ignora una instrucción, `/context` es el primer diagnóstico: casi siempre el archivo no cargó, no es que la haya desobedecido.

### Advertencias

- **`CLAUDE.md` conviene por debajo de 200 líneas.** El nuestro está en 178. Cuando crezca, se mueven secciones a `.claude/rules/` con su `paths`, no se agrandan.
- **Los imports `@archivo.md` cargan al arranque**, así que importar los diez documentos de `docs/` no ahorra contexto: lo consume igual. No lo hagas.
- **Después de `/compact`**, el `CLAUDE.md` de la raíz se reinyecta solo; las reglas por ruta recargan cuando vuelve a tocar archivos que coincidan. Lo que se pierde es lo que dijiste solo en la conversación. Si una instrucción importa, va a un archivo.
- **La memoria automática está activa por defecto** y guarda correcciones tuyas entre sesiones. Es útil, pero no reemplaza a `CLAUDE.md`: lo que tiene que valer siempre va escrito, no delegado a que lo recuerde.
- **El auto-load de `.claude/rules/` no se pudo verificar en la extensión de VS Code.** Hay reportes conocidos de que las reglas con `paths:` no se inyectan ahí, a diferencia de la CLI. Las reglas siguen versionadas — funcionan en la CLI y no cuestan nada mantenerlas — pero no asumas que van a cargar solas: el prompt de cada tarea tiene que nombrar el archivo de regla del área junto con los documentos (ver la plantilla de la sección 3).

---

## 6. Higiene de sesión

**Sesión nueva por paquete de trabajo.** El contexto acumulado de tres tareas hace que el agente arrastre supuestos de la primera hacia la tercera. Es una de las causas más comunes de decisiones que nadie tomó.

**Sesión nueva para revisar.** Ver 4.2.

**Si una sesión se está alargando y el agente empieza a repetirse o a proponer cambios cada vez más amplios, cortala.** Commiteá lo que esté en verde, abrí una sesión limpia y volvé a empezar desde el punto siguiente. Insistir en un contexto degradado cuesta más que reiniciar.

**Nombrá siempre los documentos a leer.** `CLAUDE.md` se carga solo; el resto no. Un agente que no leyó `domain-rules.md` va a inventar la regla de la merma, y la versión que invente va a sonar razonable.

### Niveles de rigor por paquete

**La revisión cruzada (§4.2) es obligatoria para todo paquete que produce código. No hay lista de paquetes exentos.** §4.1 (verificación antes de cerrar) tampoco es opcional para ninguno, pero eso lo hace la misma sesión que implementó — la pregunta de esta sección es otra: lo que varía entre paquetes no es SI se revisa, sino QUIÉN revisa.

**Por qué no hay atajo.** El CI verifica que el código funcione; la revisión verifica que sea el correcto — son dos preguntas distintas, y ningún pipeline contesta la segunda. Los tres hallazgos más importantes del proyecto hasta ahora pasaron el CI sin problema, con la suite en verde, y solo aparecieron en una revisión cruzada:

- **El status compartido entre el sellado recién abierto y su granel hijo (WP-A07/A15).** `assertBulkLotIsDecantable` validaba solo `status`, y un lote sellado que acababa de abrirse comparte ese mismo `status` (`open_for_decant`) con el granel que nació de él — un `LotSnapshot` del sellado pasaba la validación sin deber pasarla. Ningún test existente lo cubría porque nadie había escrito ese fixture todavía.
- **La tabla de `docs/domain-contracts.md` §6.5 que contradecía la regla de fondo de las máquinas de estado (WP-A08).** El documento traía un ejemplo desactualizado que no coincidía con el criterio real de cuándo se cancela y cuándo se revierte una entidad. `pnpm test` no lee prosa de un `.md`.
- **El `set_config` con `false` en vez de `true` en `docs/testing-strategy.md` (PR #34).** El propio documento que un PR citaba como fundamento de su test contradecía, en su ejemplo, la regla no negociable que ese mismo PR estaba verificando. Documentación, sin código: ningún `lint` ni `test` lo iba a agarrar nunca.

Los tres eran "verde" en todo lo que el CI sabe medir, y los tres eran incorrectos. Esa es la razón de fondo de esta sección, no una preferencia de proceso.

**Riesgo alto — revisión en sesión limpia aparte (§4.2), o directamente por el otro agente.** Todo lo que escribe en el ledger, toca dinero, permisos, esquema, autenticación o la frontera fiscal. En el bloque C: C02, C03, C04, C05, C09, C10, C11, C12, C13, C15, C17, C18, C19, C20, C21, C22, C23, C24. Acá la revisión es completa: una sesión nueva y sin el contexto de quien escribió el código, con las siete preguntas de §4.2 — o, si quien implementó fue Codex, que revise Claude Code (y viceversa si implementó Claude Code). Dos agentes distintos leyendo el mismo código de forma independiente es una revisión más fuerte que la misma sesión reinterpretándose a sí misma, y más fuerte que un subagente dentro de la misma conversación — evitá que el mismo agente que implementó sea también el que revisa, aunque sea en una sesión "nueva".

**Riesgo medio o bajo — subagente `revisor`.** El resto del bloque C: C01, C06, C07, C08, C14, C16, C25. Misma skill (`revisar-pr`), las mismas siete preguntas de §4.2, contexto aislado del subagente — sin necesitar una sesión ni un agente completamente aparte.

**Lo único que se salta la revisión es lo que no produce código:** PRs de documentación pura, actualizaciones del backlog, correcciones de texto. Este mismo cambio es un ejemplo.

---

## 7. El punto donde hay que frenar

Tres momentos en los que la sesión se detiene y decidís vos, no el agente:

**WP-A10, el dataset dorado.** Los valores esperados salen de tu operación real: planillas de costos, ventas históricas del v2. Si los genera el código, los tests miden contra sí mismos y no protegen nada. Esos veinte números los ponés vos.

**WP-A15, la validación contra un lote real.** Completar `assertBulkLotIsDecantable` con fixtures cierra el código, pero no cierra el criterio de aceptación completo: hoy no existe ningún lugar que construya un `LotSnapshot` real desde `inventory_lots` (eso es WP-C11/WP-C13). Que los tests con fixture pasen no equivale a haber verificado el rechazo contra un lote real. Si alcanza con fixtures para cerrar la sesión, o si conviene esperar a C11/C13, lo decidís vos, no el agente.

**WP-D08, la reconciliación.** El reporte tiene que cerrar con tolerancia cero en stock, caja y señas. Si no cierra, el corte no procede. No hay margen de interpretación acá, y ningún agente debería decidir que una diferencia "es aceptable".

**WP-Gc01, el contenido de las fichas.** Las descripciones propias las escribís vos. Un agente puede ayudarte a redactar a partir de tus notas, pero no puede inventar cómo proyecta un perfume ni con qué lo compararías: si lo hace, estás publicando contenido falso sobre productos reales, y además genérico, que es justamente lo que no posiciona.

**WP-F03, el corte.** Es una decisión de negocio con una ventana de indisponibilidad. Se ejecuta con el guion en la mano y con vos mirando.
