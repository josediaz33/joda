# Playbook de Prompts

Cómo avanzar el proyecto sesión por sesión después del prompt maestro. Cada prompt está listo para copiar.

**Regla de oro: una sesión, un paquete de trabajo.** El backlog está dimensionado para eso. Sesiones que abarcan tres paquetes producen PRs que nadie puede revisar y decisiones que nadie tomó conscientemente.

---

## 1. Anatomía de un buen prompt de tarea

`CLAUDE.md` se carga solo en cada sesión y ya lleva las reglas permanentes. El prompt de la tarea solo tiene que aportar cinco cosas:

```
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

### Sesión 1 — Andamiaje

El `PROMPT_MAESTRO.md`. Solo estructura, colocación de documentos y commit inicial. Sin código.

---

### Sesión 2 — WP-A01 · Monorepo base

```
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

### Sesión 8 — WP-B01 a WP-B03 · Esquema

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

### Sesión 9 — WP-B06 · Prueba de aislamiento

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
Tomá WP-<id> del backlog.

Leé primero: <documentos del área>.

Objetivo: <una frase, tomada del backlog>.

Criterio de aceptación: <el del backlog, con los números concretos si los hay>.

TRAMPAS DE ESTA TAREA:
· <el error predecible de esta área>
· <el invariante que se suele olvidar>

Alcance: solo WP-<id>. Si el alcance crece, pará y consultá.
```

### Trampas por área, para completar la plantilla

| Área | Lo que hay que advertir |
|---|---|
| Dominio | Nada de I/O. Result para fallos esperados, excepción para bugs. `Money`, no `number`. |
| Esquema | Nunca `prisma migrate`. Nunca editar una migración aplicada. `tenant_id` en toda tabla. Todo invariante nuevo lleva su prueba. |
| API | `set_config` con tercer parámetro en `true`. Todo procedimiento declara su permiso. 404, no 403. Bloqueo en orden ascendente de `lot_id`. |
| Ventas | El inventario se consume al confirmar el pago, no al crear el pedido. Anular es revertir, no editar. |
| Pagos | El PAN no toca el sistema. Webhook idempotente por clave única. Confirmar el monto contra el proveedor. |
| DTO públicos | Esquema distinto, no el mismo con opcionales. Test que verifica que no filtra costos ni cantidades. |
| Contabilidad | Los asientos se derivan de reglas, no se cargan. Un asiento contabilizado se reversa, no se edita. |
| ETL | Idempotente con `legacy_map`. No inventar historial: movimientos de apertura. El ETL solo lee del v2. |
| Frontend admin | Las guardas son UX, no seguridad. Carga diferida para que el bundle no viaje. Densidad alta: no es una landing. |
| Frontend storefront | Componentes de servidor por defecto. Framer Motion fuera del camino crítico. `width` y `height` en toda imagen. El stock se muestra como estado, no como cantidad. |
| Diseño visual | Pegá la lista de defaults genéricos de `frontend-spec.md` §3.3. Sin ella vas a recibir crema + serif + terracota. |
| SEO | Facetas combinadas siempre `noindex`. Los datos estructurados deben coincidir con lo que ve el usuario. |

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

No arregles nada. Solo reportá.
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

| Capa | Qué es | Cuándo se carga |
|---|---|---|
| `CLAUDE.md` (raíz) | Reglas permanentes, comandos, mapa de documentación | Automáticamente, en cada sesión |
| `.claude/rules/*.md` | No negociables por área, con `paths:` en el frontmatter | Automáticamente, **cuando toca archivos que coinciden** |
| `docs/*.md` | La profundidad: reglas de negocio, contratos, especificaciones | **Cuando el prompt los nombra** |

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

Las reglas llevan los no negociables, no el detalle. Un agente que va a implementar el costeo del decant necesita los números de `domain-rules.md`, y eso no está en la regla. Por eso cada prompt de tarea sigue empezando por *"Leé primero: …"*.

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

**WP-D08, la reconciliación.** El reporte tiene que cerrar con tolerancia cero en stock, caja y señas. Si no cierra, el corte no procede. No hay margen de interpretación acá, y ningún agente debería decidir que una diferencia "es aceptable".

**WP-Gc01, el contenido de las fichas.** Las descripciones propias las escribís vos. Un agente puede ayudarte a redactar a partir de tus notas, pero no puede inventar cómo proyecta un perfume ni con qué lo compararías: si lo hace, estás publicando contenido falso sobre productos reales, y además genérico, que es justamente lo que no posiciona.

**WP-F03, el corte.** Es una decisión de negocio con una ventana de indisponibilidad. Se ejecuta con el guion en la mano y con vos mirando.
