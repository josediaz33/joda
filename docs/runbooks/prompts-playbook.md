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
Los casos borde 1 a 5 del catálogo de domain-rules.md con test cada uno.

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
corre en un PR.

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

Alcance: los tres jobs de CI (typecheck+lint+format:check, test, build)
sobre el esqueleto de los tres apps. Al terminar, evaluá con José si
conviene GitHub Pro y activar `required_status_checks` del lado del
servidor con los nombres de los jobs — es una decisión de cuenta, no del
agente (CONTRIBUTING.md §10, hoy `main` solo tiene el hook local
`pre-push`). Si el alcance crece, pará y consultá.
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

Leé primero: packages/db/README.md, docs/data-model.md, ADR-018.

Objetivo: incorporar las migraciones ya validadas al flujo del repositorio,
con los scripts db:migrate, db:seed, db:reset, db:test y db:pull.

Criterio de aceptación: `pnpm db:reset` desde cero sin errores.
`pnpm db:test` con 18/18 invariantes en verde, corriendo en CI.

TRAMPAS DE ESTA TAREA:
· NUNCA corras `prisma migrate dev`. El esquema es SQL escrito a mano;
  Prisma se regenera por introspección con db:pull. Ver ADR-018.
· NO edites las migraciones existentes. Están validadas contra PostgreSQL 16
  y sus 18 invariantes probados. Si algo te parece mejorable, decilo, no
  lo cambies.
· El orden de las migraciones importa y está en el nombre del archivo.

Alcance: incorporación e integración con CI. Sin cambios al esquema.
```

---

### Sesión 17 — WP-B06 · Prueba de aislamiento

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
par texto/fondo, con los números.

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

```

Que sea una sesión nueva importa: un agente que acaba de escribir el código está sesgado a validarlo.

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

---

## 7. El punto donde hay que frenar

Tres momentos en los que la sesión se detiene y decidís vos, no el agente:

**WP-A10, el dataset dorado.** Los valores esperados salen de tu operación real: planillas de costos, ventas históricas del v2. Si los genera el código, los tests miden contra sí mismos y no protegen nada. Esos veinte números los ponés vos.

**WP-A15, la validación contra un lote real.** Completar `assertBulkLotIsDecantable` con fixtures cierra el código, pero no cierra el criterio de aceptación completo: hoy no existe ningún lugar que construya un `LotSnapshot` real desde `inventory_lots` (eso es WP-C11/WP-C13). Que los tests con fixture pasen no equivale a haber verificado el rechazo contra un lote real. Si alcanza con fixtures para cerrar la sesión, o si conviene esperar a C11/C13, lo decidís vos, no el agente.

**WP-D08, la reconciliación.** El reporte tiene que cerrar con tolerancia cero en stock, caja y señas. Si no cierra, el corte no procede. No hay margen de interpretación acá, y ningún agente debería decidir que una diferencia "es aceptable".

**WP-Gc01, el contenido de las fichas.** Las descripciones propias las escribís vos. Un agente puede ayudarte a redactar a partir de tus notas, pero no puede inventar cómo proyecta un perfume ni con qué lo compararías: si lo hace, estás publicando contenido falso sobre productos reales, y además genérico, que es justamente lo que no posiciona.

**WP-F03, el corte.** Es una decisión de negocio con una ventana de indisponibilidad. Se ejecuta con el guion en la mano y con vos mirando.
