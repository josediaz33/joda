# Backlog

Los bloques del roadmap desglosados en **paquetes de trabajo**: unidades que un agente puede tomar, completar y verificar en una sesión, con criterio de aceptación explícito.

Identificador: `WP-<bloque><nn>`. Referencialo en la rama, el commit y el PR.

**Estados:** ☐ pendiente · ◐ en curso · ☑ hecho

---

## Bloque A — Fundación

> Meta: monorepo funcionando, con la lógica de negocio del v2 extraída y testeada. **Es el bloque que produce el activo más valioso del proyecto.**

| ID       | Paquete                                                                                                         | Depende de | Criterio de aceptación                                                                                                                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ☑ WP-A01 | Monorepo base: pnpm workspaces, Turborepo, tsconfig compartido, ESLint con `eslint-plugin-boundaries`, Prettier | —          | `pnpm install && pnpm typecheck && pnpm lint` en verde en un repo vacío                                                                                                                                                                                                                   |
| ☐ WP-A02 | Esqueleto de los tres apps con "hola mundo" y el pipeline de CI                                                 | A01        | `pnpm build` produce los tres artefactos; el CI corre en un PR; con el pipeline ya existente, evaluar GitHub Pro y activar `required_status_checks` del lado del servidor con los nombres de los jobs (ver CONTRIBUTING.md § Despliegue — hoy `main` solo tiene el hook local `pre-push`) |
| ☑ WP-A03 | `packages/domain`: `Money`, `Quantity`, `Percentage`, `Result`, jerarquía de errores                            | A01        | 100% de cobertura; sumar monedas distintas falla; `allocate` no pierde unidades (prueba de propiedades)                                                                                                                                                                                   |
| ☑ WP-A04 | `packages/domain/tax`: IVA sobre precio incluido, desglose de documento con diferencia de redondeo              | A03        | RN-IVA-01…04 con tests; el caso de las tres líneas de 33.333 da `[3030, 3030, 3031]`                                                                                                                                                                                                      |
| ☑ WP-A05 | `packages/domain/procurement`: costo puesto y prorrateo de flete por los cuatro métodos                         | A03        | RN-COS-01…03; la suma de partes iguala el total en todos los métodos                                                                                                                                                                                                                      |
| ☑ WP-A06 | `packages/domain/inventory`: selección de lotes por política y capas de costo                                   | A03        | RN-COS-04, RN-LOT-05; el caso FIFO de dos capas da 4.350.000                                                                                                                                                                                                                              |
| ☑ WP-A07 | `packages/domain/decant`: planificación, ejecución, merma en tres componentes, disponibilidad                   | A03, A06   | RN-FRA-01…06; el caso Layton da COGS 131.210; casos borde 1-4 del catálogo (el 5 no aplica a decant/, ver WP-A13 y la nota debajo de la tabla)                                                                                                                                            |
| ☐ WP-A08 | `packages/domain`: máquinas de estado de orden de compra, pedido de venta y orden de fraccionamiento            | A03        | Transiciones como dato; test exhaustivo de la matriz completa                                                                                                                                                                                                                             |
| ☐ WP-A09 | `packages/domain/sales`: totales, descuentos, TTL de reserva, señas                                             | A03, A04   | RN-VTA-01, RN-RES-02, RN-SEN-01…04                                                                                                                                                                                                                                                        |
| ☐ WP-A10 | Dataset dorado: 20 operaciones reales del v2 con resultados verificados a mano                                  | A04–A09    | Corre en CI; cada caso cita su origen                                                                                                                                                                                                                                                     |
| ☐ WP-A11 | `packages/contracts`: esquemas Zod base y convención de dinero como string                                      | A03        | Un procedimiento de ejemplo tipado extremo a extremo compila                                                                                                                                                                                                                              |
| ☐ WP-A12 | Endurecer la excepción de lint de pureza para archivos de test: hoy es un gate por nombre, no por contenido     | A01, A06   | Evaluada y aplicada una de las tres opciones de la nota debajo de la tabla, o justificado por escrito por qué ninguna corresponde                                                                                                                                                         |
| ☐ WP-A13 | `packages/domain/inventory/lotOpening.ts`: conversión sellado → granel al abrir un frasco                       | A03        | RN-LOT-02, RN-LOT-03, ADR-009; cubre el caso borde 5 del catálogo de `docs/domain-rules.md` (abrir un lote ya abierto se rechaza)                                                                                                                                                         |

**Nota sobre A10.** Los valores esperados salen de la operación histórica real, no de lo que devuelve el código nuevo. Si no coinciden, hay que averiguar cuál de los dos está mal — y a veces es el sistema viejo.

**Nota sobre A05 (encontrada al revisar A04).** `breakdownDocument` (WP-A04, `tax/vat.ts`) reconcilia un agregado por grupo contra la suma de sus partes e imputa la diferencia — misma _forma_ que le va a hacer falta al prorrateo de flete. Pero **no es la misma regla**: RN-IVA-03 imputa la diferencia a la **última línea** de la tasa; RN-COS-02 imputa la de flete a la línea de **mayor valor**. No asumir que A05 puede reusar la lógica de imputación de A04 tal cual — el criterio de desempate es distinto. Se evaluó catalogar esto como patrón nuevo en `docs/engineering-principles.md` Parte III y se decidió esperar a tener las dos implementaciones reales antes de generalizar (ver PR #4).

**Resolución (A05).** El "criterio de desempate distinto" resultó ser un error de redacción, no una regla real: RN-COS-02 se corrigió para usar el mismo mayor resto que `Money.allocate` (sin caso especial), y RN-IVA-03 sigue imputando a la última línea de la tasa porque ahí el redondeo lo valida una autoridad fiscal externa — dos reglas distintas a propósito, ver RN-COS-02 en `docs/domain-rules.md`. `manual` no prorratea: el operador fija `manualAmount` por línea y `allocateFreight` solo valida que sume el flete total.

**Excluido a propósito de A05 — registro contable de la diferencia de cambio (caso borde #12).** El caso #12 del catálogo de `docs/domain-rules.md` ("el tipo de cambio de la recepción difiere del estimado") tiene dos mitades: "usar el real" (implementado en `computeLandedCost`, RN-COS-01 — el fx es siempre el de la recepción, nunca el de la orden) y "la diferencia se registra como diferencia de cambio" (contable, **no implementado en A05**). Esta segunda mitad queda para el motor de posteo (Bloque H, probablemente WP-H03 — "compra" es una de las reglas que ahí se encienden) porque requiere comparar el fx de la recepción contra el fx estimado de la orden de compra y generar un asiento, y `packages/domain/procurement` no tiene ni necesita esa comparación para calcular el costo puesto. Es una decisión de alcance, no un olvido: A05 no queda "pendiente en silencio" en este punto.

**Limitación conocida de A05 — moneda única por recepción en `computeLandedCost`.** `computeLandedCost` (`packages/domain/src/procurement/landedCost.ts`) exige que `freight`/`customsClearance`/`other` compartan moneda con `supplierPrice`; si no, lanza `CurrencyMismatchError`. Esto **no es un caso hipotético**: en cualquier importación real a Paraguay el despacho aduanero, los aranceles y los honorarios del despachante se pagan en guaraníes, mientras el proveedor cobra en USD o BRL. Hoy se resuelve convirtiendo esos gastos locales a la moneda de la recepción **antes** de llamar a `computeLandedCost`, lo que introduce un redondeo de ida y vuelta (Gs. → moneda extranjera → Gs. de nuevo). Rediseñar cuando el volumen lo justifique, aceptando componentes con moneda y fx propios cada uno, convertidos una sola vez cada uno — no antes: es una decisión postergada a propósito, no un olvido.

**Decisión de alcance de A06 (`inventory/allocation.ts`).** RN-LOT-05 no dice todo lo necesario para implementar `serial`/`manual`: dice que el lote "se elige explícitamente" (serial) o que "el operador elige el lote" (manual) — es decir, la decisión de negocio ya ocurrió _antes_ de llamar al dominio, pero no dice qué hacer cuando quedan varios candidatos igual de elegibles. Sin un criterio temporal propio para esas dos políticas, `selectLotsByPolicy` cae al mismo desempate universal que usan `fifo`/`fefo` en caso de empate: id ascendente. No se inventó un criterio nuevo (por ejemplo, "orden de llegada en el arreglo") porque RN-LOT-05 no lo pide y hubiera sido una regla de negocio no verificada. Documentado en el código (`allocation.ts`), no solo acá. Si resulta no ser lo que el negocio espera, corresponde una regla nueva en `docs/domain-rules.md`, no un ajuste silencioso.

**Hallazgo de A06, corregido de paso — `no-restricted-globals` bloqueaba fixtures de `Date` en tests.** `LotSnapshot.receivedAt`/`expiryAt` (`docs/domain-contracts.md` §6.1) son `Date`. La config de ESLint (`packages/config/eslint/index.js`) prohibía la referencia global a `Date` inclusive en `**/*.test.ts`, aunque el bloque de excepción para tests ya declaraba explícitamente el criterio contrario ("la pureza aplica al código que se shippea, no a los tests que lo verifican") y solo apagaba `boundaries/dependencies`. Se amplió esa misma excepción para permitir `Date` (no `fetch`/`crypto`) en tests — un fixture como `new Date("2026-01-01")` es un literal fijo pasado por parámetro, no una lectura del reloj real, que es la distinción que ya traza `.claude/rules/testing.md`. Sin este ajuste, WP-A06 no podía tener tests para `LotSnapshot` en absoluto.

**Casos borde cubiertos por A07 — el catálogo pide "1 a 5", acá van 1 a 4.** El criterio de aceptación original pedía test para los casos borde 1-5 del catálogo de `docs/domain-rules.md`. Los casos 1-4 son de fraccionamiento (`planDecant`/`executeDecant`, `decant/planning.ts` y `decant/execution.ts`). El caso 5 ("Se abre un frasco que ya estaba abierto → Rechazar, un lote solo se abre una vez") es la conversión de apertura de lote — RN-LOT-02, ADR-009 — que vive en `inventory/lotOpening.ts`, todavía sin implementar (ver WP-A13, agregada acá mismo). No se mezcló ese caso en A07 porque su alcance es "solo `decant/`": abrir un frasco no es fraccionarlo. Queda explícitamente anotado, no perdido en un comentario de PR — WP-A13 lo lleva como parte de su propio criterio de aceptación.

**Decisiones de forma de A07, deliberadas y documentadas en el código — no desviaciones silenciosas de `docs/domain-contracts.md` §6.2.**

- `planDecant` recibe `bulkLot: LotSnapshot` en vez del `bulkAvailable: Quantity` suelto que lista la referencia. Un decant se sirve de GRANEL, no de un frasco sellado sin convertir, y esa es una validación que le corresponde a `planDecant` por derecho propio (no una repetición de RN-LOT-02, que gobierna si el frasco se puede abrir, no si un lote ya abierto sirve de fuente): con solo un `Quantity` no hay forma de saber si el lote todavía es decantable. El criterio exacto es el `status` del lote — `open_for_decant`, el único estado en el que un lote de granel existe mientras tiene saldo (RN-LOT-02 lo crea así, RN-LOT-04 lo pasa a `depleted` recién al agotarse) — no el `variant_type` del origen, que ni siquiera es un campo de `LotSnapshot` (`inventory/allocation.ts`) y hubiera significado tocar `inventory/`, fuera del alcance de este PR. `executeDecant` ya recibía `bulkLot: LotSnapshot`; ahora las dos funciones comparten la misma validación (`assertBulkLotIsDecantable`, exportada de `planning.ts`).
- `planDecant` y `executeDecant` comparten una sola unión `DecantError` (definida en `planning.ts`) en vez de dos separadas — la referencia ya usa ese mismo nombre para el `Result` de ambas funciones.
- La merma por evaporación (RN-FRA-05, tercer componente) está documentada en `decant/waste.ts` pero **no implementada**: `docs/domain-rules.md` describe cuándo se aplica ("por tiempo abierto, ajuste periódico programado") pero no da fórmula ni ejemplo numérico para `evaporation_ml_year`, y prorratear linealmente hubiera sido inventar una regla de negocio, no tomarla del negocio. Queda pendiente de una WP futura una vez que el negocio defina la fórmula.

**Nota sobre A12.** La excepción de la regla de pureza de `packages/domain` para archivos de test (`packages/config/eslint/index.js`) se activa por patrón de nombre (`*.test.ts`), no por contenido ni por ubicación. Ya se ensanchó dos veces, cada vez con buen motivo puntual y sin que hubiera un registro centralizado de por qué: `checkInternals` en WP-A03 y la excepción de `Date` en WP-A06. El riesgo no es un archivo de test malicioso — es la erosión acumulada de una regla que existe justamente para ser **mecánica**, no discrecional. El criterio de aceptación pide evaluar tres caminos (no necesariamente excluyentes entre sí, ni los únicos posibles):

- Acotar la excepción a un directorio `test/` en vez de un sufijo de nombre, para que el gate sea la ubicación del archivo y no cómo se llame.
- Acotar la excepción a los globals que los tests realmente necesitan (`Date`, por ejemplo), en vez de apagar la regla entera para cualquier archivo que matchee el patrón.
- Documentar en el propio `packages/config/eslint/index.js` el registro de cada ampliación —fecha, motivo, WP que la pidió— para que la próxima sea una decisión visible, no un ajuste al pasar.

No es urgente: es deuda a pagar **antes del Bloque C**, cuando la cantidad de paquetes que dependen de esta regla se multiplique y la erosión sea más cara de revertir.

**Riesgo conocido para A02 (pipeline de CI).** Turborepo necesita resolver el binario del gestor de paquetes (`pnpm`) como ejecutable real en el `PATH` del sistema — no alcanza con que `corepack pnpm <comando>` funcione. `corepack enable` instala esos shims en `C:\Program Files\nodejs\`, que en Windows requiere permisos de administrador; sin ellos, `corepack enable` falla con `EPERM` y cualquier `pnpm <script>` que dependa de `turbo run` (typecheck, lint, test a nivel raíz) falla con `Unable to find package manager binary: cannot find binary path`, aunque `corepack pnpm` ande perfecto. Encontrado y confirmado en una sesión de Claude Code corriendo en un sandbox de Windows sin permisos de admin — no reproducido todavía en una máquina de desarrollo normal ni en un runner de CI real, así que puede que no aplique ahí. Workaround verificado que no requiere admin: `npm install -g pnpm@<versión del catalog>` (el prefix global de npm, `%APPDATA%\npm`, ya está en el `PATH` y es escribible por el usuario). Si el runner de CI de A02 corre como usuario sin privilegios elevados (contenedor rootless, agente self-hosted sin admin), conviene usar ese mismo camino o una action dedicada (`pnpm/action-setup`) en vez de asumir que `corepack enable` va a funcionar.

---

## Bloque B — Esquema

> Meta: la base de datos ejecutable, con sus invariantes probados. **Ya existe validada; este bloque la incorpora al repositorio.**

| ID       | Paquete                                                                        | Depende de | Criterio de aceptación                                                      |
| -------- | ------------------------------------------------------------------------------ | ---------- | --------------------------------------------------------------------------- |
| ☐ WP-B01 | Incorporar las 10 migraciones a `packages/db/migrations/` y los scripts `db:*` | A01        | `pnpm db:reset` desde cero sin errores                                      |
| ☐ WP-B02 | Seed: permisos, roles, plan de cuentas, reglas de posteo                       | B01        | `pnpm db:seed` idempotente; matriz de roles coincide con `security-spec.md` |
| ☐ WP-B03 | Suite de invariantes en el pipeline                                            | B01        | `pnpm db:test` → 18/18 en verde en CI                                       |
| ☐ WP-B04 | Prisma por introspección + script `db:pull` + `schema.prisma` commiteado       | B01        | El cliente tipado compila y expone los 61 modelos                           |
| ☐ WP-B05 | Testcontainers: base efímera por corrida de tests de integración               | B01        | Un test de integración de ejemplo corre en CI en menos de 60 s              |
| ☐ WP-B06 | Prueba de aislamiento RLS con el rol `joda_api`                                | B01, B05   | Sin tenant → 0 filas; otro tenant → 0 filas; `UPDATE` al libro → denegado   |
| ☐ WP-B07 | `docker-compose.yml` con Postgres y Redis para desarrollo local                | B01        | Arranque completo desde cero en menos de 15 min                             |

---

## Bloque C — API

> Meta: backend funcional con autenticación, permisos y los módulos operativos.

| ID       | Paquete                                                                                   | Depende de    | Criterio de aceptación                                                                    |
| -------- | ----------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| ☐ WP-C01 | Esqueleto Fastify + tRPC, contexto de petición, mapeador de errores de PostgreSQL         | A11, B04      | Un procedimiento de ejemplo responde tipado; un `CHECK` violado devuelve error en español |
| ☐ WP-C02 | `withTenantTx`: transacción con contexto de sesión y `set_config` local                   | C01, B06      | Test que verifica que el contexto no se filtra entre peticiones del pool                  |
| ☐ WP-C03 | Autenticación de personal: sesión, cookies, refresco rotativo con detección de reúso      | C01           | Reusar un refresco invalida toda la familia                                               |
| ☐ WP-C04 | Segundo factor obligatorio para personal                                                  | C03           | Usuario sin inscribir solo accede a la pantalla de inscripción                            |
| ☐ WP-C05 | Middleware de permisos con caché en Redis + regla de 404                                  | C03           | Test que recorre el router y falla si un procedimiento no declara permiso                 |
| ☐ WP-C06 | Middleware de idempotencia con `idempotency_keys`                                         | C02           | Reintento con mismo cuerpo devuelve la respuesta guardada; con cuerpo distinto, 409       |
| ☐ WP-C07 | Auditoría: escritura en `audit_log` dentro de la transacción                              | C02           | Toda mutación de inventario y contabilidad queda registrada                               |
| ☐ WP-C08 | Módulo catálogo: productos, verticales, categorías, tags, variantes, BOM                  | C02           | RF-CAT-01…07; DTO público sin costos, con test que lo verifica                            |
| ☐ WP-C09 | Módulo catálogo: medios, subida con validación por bytes mágicos y derivados              | C08           | RF-CAT-08; un archivo con extensión falsa se rechaza                                      |
| ☐ WP-C10 | Módulo inventario: consulta de saldos, ajustes, historial de lote                         | C02, A06      | RF-INV-03…05; un ajuste a negativo se rechaza                                             |
| ☐ WP-C11 | Módulo inventario: apertura de frasco                                                     | C10, A07      | RF-INV-08; abrir dos veces el mismo lote se rechaza                                       |
| ☐ WP-C12 | Módulo inventario: unidades serializadas                                                  | C10           | RF-INV-10; serial único por tenant                                                        |
| ☐ WP-C13 | Módulo fraccionamiento: planificación, órdenes, ejecución                                 | C11, A07      | RF-FRA-01…06; ejecutar sin merma real se rechaza                                          |
| ☐ WP-C14 | Módulo compras: proveedores, órdenes, máquina de estados                                  | C02, A08      | RF-MKT-01…03; transición inválida rechazada con mensaje claro                             |
| ☐ WP-C15 | Módulo compras: recepciones con prorrateo y generación de lotes                           | C14, A05      | RF-MKT-04…07; recepción mayor a lo pedido se rechaza                                      |
| ☐ WP-C16 | Módulo sourcing: escenarios y comparación                                                 | C14, A05      | RF-SRC-01…05; un escenario no toca inventario ni caja                                     |
| ☐ WP-C17 | Módulo ventas: pedidos, líneas, totales, IVA                                              | C02, A09      | RF-VTA-01…03; total inconsistente rechazado                                               |
| ☐ WP-C18 | Módulo ventas: reservas con TTL y job de liberación                                       | C17, A09      | RF-VTA-04; reserva vencida liberada en menos de 5 min                                     |
| ☐ WP-C19 | Módulo ventas: confirmación con consumo, COGS y bloqueo ordenado                          | C18, C13, A06 | RF-VTA-05, RF-VTA-06; test de concurrencia sin interbloqueo                               |
| ☐ WP-C20 | Módulo ventas: señas y aplicación                                                         | C17, A09      | RF-VTA-07, RF-VTA-08                                                                      |
| ☐ WP-C21 | Módulo ventas: anulación por reversión                                                    | C19           | RF-VTA-09; los movimientos originales quedan intactos                                     |
| ☐ WP-C22 | Módulo contabilidad: plan de cuentas, caja, arqueo                                        | C02           | RF-CTB-01, RF-CTB-02                                                                      |
| ☐ WP-C23 | Módulo fiscal: documentos, adaptador manual, puerto                                       | C17           | RF-FIS-01…04, RF-FIS-07                                                                   |
| ☐ WP-C24 | Módulo seguridad: administración de usuarios y roles                                      | C05           | RF-SEG-03, RF-SEG-06; revocación efectiva en menos de 2 min                               |
| ☐ WP-C25 | Observabilidad: bitácoras estructuradas, identificador de correlación, alertas de negocio | C01           | RNF-OBS-01…04; las seis alertas configuradas                                              |

---

## Bloque D — Migración

> Meta: los datos del v2 en la nube, verificados.

| ID       | Paquete                                                                | Depende de | Criterio de aceptación                                                       |
| -------- | ---------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------- |
| ☐ WP-D01 | `exportSnapshot.ts` en el admin v2                                     | —          | Produce JSON con versión y conteos; se puede correr sin afectar la operación |
| ☐ WP-D02 | ETL idempotente con `legacy_map`                                       | B01, D01   | Reejecutar no duplica nada                                                   |
| ☐ WP-D03 | ETL: catálogo, verticales, variantes, BOM                              | D02        | RF-MIG-02; conteos coinciden                                                 |
| ☐ WP-D04 | ETL: proveedores, órdenes históricas                                   | D02        | Conteos coinciden                                                            |
| ☐ WP-D05 | ETL: movimientos de apertura por cada saldo existente                  | D03        | RF-MIG-04; sin historial inventado; stock coincide exacto                    |
| ☐ WP-D06 | ETL: imágenes de base64 a almacenamiento con deduplicación y derivados | D03        | RF-MIG-03; conteo de imágenes coincide; nada de base64 en la base            |
| ☐ WP-D07 | ETL: ventas históricas y saldo de caja                                 | D05        | Caja coincide con tolerancia cero                                            |
| ☐ WP-D08 | Reporte de reconciliación                                              | D03–D07    | RF-MIG-05, RF-MIG-06; falla si alguna métrica no cierra                      |

---

## Bloque E — Backoffice

> Meta: el admin operando contra la API. Migración módulo a módulo.

| ID       | Paquete                                                                                                                                   | Depende de    | Criterio de aceptación                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------- |
| ☐ WP-E01 | **Tokens de diseño**: derivar paleta, tipografías y escalas de la marca JODA a `packages/ui/src/styles/tokens.css` (Tailwind v4 `@theme`) | A01           | Contraste AA verificado en todos los pares texto/fondo; consumible desde ambos apps |
| ☐ WP-E02 | `packages/ui/primitives`: shadcn sobre Radix con `components.json` configurado en el paquete                                              | E01           | `npx shadcn add` deposita en `packages/ui`, no en un app                            |
| ☐ WP-E03 | `packages/ui/format`: `money`, `quantity`, `date` con locale `es-PY` y zona `America/Asuncion`                                            | A01           | `Gs. 245.000`; ningún `toLocaleString` suelto en el resto del código                |
| ☐ WP-E04 | Base del admin: enrutado, sesión, `<Can>`, guardas de ruta con carga diferida                                                             | C05, E02      | Un `vendedor` no descarga el código de contabilidad                                 |
| ☐ WP-E05 | Módulo catálogo en el admin                                                                                                               | C08, C09, E04 | Alta y edición de perfumes, relojes y accesorios                                    |
| ☐ WP-E06 | Módulo inventario en el admin                                                                                                             | C10–C12, E04  | Consulta de saldos, ajustes, apertura de frasco                                     |
| ☐ WP-E07 | Módulo fraccionamiento en el admin                                                                                                        | C13, E04      | Cola agrupada por frasco de origen; merma real obligatoria, precargada y editable   |
| ☐ WP-E08 | Módulo ventas en el admin                                                                                                                 | C17–C21, E04  | Venta de mostrador completa                                                         |
| ☐ WP-E09 | Módulo compras y sourcing en el admin                                                                                                     | C14–C16, E04  | Costo puesto y margen recalculados **en vivo** al cargar flete, antes de confirmar  |
| ☐ WP-E10 | Módulo contabilidad y caja en el admin                                                                                                    | C22, E04      | Arqueo diario                                                                       |
| ☐ WP-E11 | Reportes con Recharts                                                                                                                     | C25, E04      | RF-REP-01…04                                                                        |
| ☐ WP-E12 | Accesibilidad del admin: foco visible, navegación por teclado, paleta de comandos con cmdk                                                | E04           | Operaciones frecuentes sin mouse                                                    |

---

## Bloque F — Corte

> Meta: operar en la nube. **Es la meta intermedia del proyecto: un sistema en producción vale más que tres a medias.**

| ID       | Paquete                                                                          | Depende de | Criterio de aceptación                                                    |
| -------- | -------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------- |
| ☐ WP-F01 | Recuperación a un punto en el tiempo activa y simulacro de restauración completo | B07        | Restauración verificada en un proyecto nuevo                              |
| ☐ WP-F02 | Guion de corte con orden, verificaciones y plan de reversión                     | D08, E09   | Ensayado en staging con datos reales anonimizados                         |
| ☐ WP-F03 | **Ejecución del corte**                                                          | F01, F02   | Reconciliación en verde; verificación manual de 10 productos y del arqueo |
| ☐ WP-F04 | Monitoreo post-corte: primera semana con verificación diaria de deriva           | F03        | `v_balance_drift` en cero todos los días                                  |

---

## Bloque G — Storefront

| ID       | Paquete                                                                                                 | Depende de | Criterio de aceptación                                                       |
| -------- | ------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------- |
| ☐ WP-G01 | Base del storefront: Next.js, tipografías autoalojadas, lectura por vistas públicas con `joda_readonly` | F03, E03   | No accede a ninguna tabla base; `display: swap`, dos familias como máximo    |
| ☐ WP-G02 | **Presupuesto de rendimiento en CI** con Lighthouse CI                                                  | G01        | Los umbrales de `frontend-spec.md` §5.1 bloquean la fusión                   |
| ☐ WP-G03 | Estructura de URLs y política de facetas indexables                                                     | G01        | Slugs estables con redirección 301; combinación de facetas siempre `noindex` |
| ☐ WP-G04 | Catálogo y filtros por facetas                                                                          | G03        | RF-ECO-01, RF-CAT-11; LCP bajo 2,5 s en 4G                                   |
| ☐ WP-G05 | Página de producto: selector de variante con precio por mililitro, disponibilidad como estado           | G04        | RF-ECO-02; nunca se expone la cantidad exacta                                |
| ☐ WP-G06 | **Datos estructurados**: Product, Offer, BreadcrumbList, Organization, WebSite                          | G05        | Coinciden con lo que ve el usuario; validados con la herramienta de Google   |
| ☐ WP-G07 | Metadatos y Open Graph por producto                                                                     | G05        | RF-ECO-10; imagen 1200×630 bajo 300 kB; vista previa correcta en WhatsApp    |
| ☐ WP-G08 | `sitemap.xml` desde la base y `robots.txt`                                                              | G03        | Solo productos publicados, con `lastmod` real                                |
| ☐ WP-G09 | Carrito sin reserva                                                                                     | G04        | RF-ECO-03                                                                    |
| ☐ WP-G10 | Identidad de cliente y compra como invitado                                                             | C03, G01   | RF-ECO-11                                                                    |
| ☐ WP-G11 | Checkout con reserva y vencimiento visible                                                              | G09, C18   | RF-ECO-04; conflicto de stock con mensaje recuperable (RN-RES-05)            |
| ☐ WP-G12 | Adaptador de pago con checkout hospedado                                                                | G11        | RF-ECO-05; el número de tarjeta no toca el sistema                           |
| ☐ WP-G13 | Webhooks idempotentes con verificación de firma y monto                                                 | G12, C06   | RF-ECO-07, RF-ECO-08; evento duplicado no reprocesa                          |
| ☐ WP-G14 | Transferencia bancaria con confirmación manual                                                          | G11        | RF-ECO-06                                                                    |
| ☐ WP-G15 | Seguimiento de pedido                                                                                   | G13        | RF-ECO-09                                                                    |
| ☐ WP-G16 | **Accesibilidad en CI** con `@axe-core/playwright` sobre rutas críticas                                 | G05        | RNF-USA-04; sin violaciones AA                                               |
| ☐ WP-G17 | Suite de extremo a extremo de los cinco flujos críticos                                                 | G15, E08   | Corre en CI de la rama principal                                             |

---

## Bloque H — Contabilidad y fiscal

| ID       | Paquete                                                           | Depende de | Criterio de aceptación                                   |
| -------- | ----------------------------------------------------------------- | ---------- | -------------------------------------------------------- |
| ☐ WP-H01 | Motor de posteo con plantillas declarativas                       | C22, A03   | RF-CTB-03; asiento generado cuadra                       |
| ☐ WP-H02 | Bandeja de eventos sin postear con reprocesamiento                | H01        | RF-CTB-05; nada se pierde en silencio                    |
| ☐ WP-H03 | Encendido progresivo de reglas: venta, cobro, compra, COGS, señas | H02        | Cada regla verificada contra un asiento calculado a mano |
| ☐ WP-H04 | Balance de sumas y saldos, libro diario, libro mayor              | H03        | RF-CTB-07, RF-CTB-08                                     |
| ☐ WP-H05 | Cierre de período con bloqueo                                     | H04        | RF-CTB-09; no cierra con eventos sin postear             |
| ☐ WP-H06 | Libros de compras y ventas IVA                                    | H04        | RF-CTB-10                                                |
| ☐ WP-H07 | Adaptador fiscal de proveedor homologado                          | C23        | RF-FIS-05, RF-FIS-06                                     |

---

## Bloque G-bis — Contenido (no es trabajo de código)

> El posicionamiento no se gana con HTML impecable si las fichas repiten la
> descripción del fabricante. Esto lo hacés vos, no un agente.

| ID        | Tarea                                                                                                                                              | Criterio                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| ☐ WP-Gc01 | Descripción propia para los 30 productos más vendidos: opinión, proyección y duración medidas, comparación con otros del catálogo, ocasión y clima | Ninguna copiada del fabricante |
| ☐ WP-Gc02 | Indicador en el admin de qué fichas tienen descripción propia                                                                                      | Métrica visible en el panel    |

---

## Bloque I — Posterior

Según demanda real, sin orden fijo: devoluciones y garantías (RF-VTA-12), envíos (RF-VTA-13), canales adicionales (RF-MKT-08…10), cuentas por cobrar y pagar (RF-CTB-11), modo offline con bandeja de salida, importación masiva de catálogo (RF-CAT-13), sugerencia de reposición (RF-MKT-11), notificación de disponibilidad (RF-ECO-12).

---

## Cómo tomar un paquete

1. Verificá que sus dependencias estén en ☑.
2. Leé los documentos que correspondan al área (tabla en `CLAUDE.md` §Documentación).
3. Rama `feat/<área>-<tema>` referenciando el `WP`.
4. Trabajá **solo ese paquete**. Si el alcance crece, pará y consultá.
5. Verificá con la lista de `CLAUDE.md` §"Cómo verificar tu trabajo".
6. PR con la plantilla de `CONTRIBUTING.md`.

**El camino crítico hasta operar en la nube es:** A → B → C → D → E → **F**. El storefront viene después, y es mucho más simple sobre un ERP que ya opera.
