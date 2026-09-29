# GLOSARIO

Lenguaje ubicuo de JODA Parfums. **El negocio habla español; el código habla inglés.** Este documento es el puente, y es de lectura obligatoria antes de escribir cualquier cosa.

Si necesitás un término que no está acá, no inventes un sinónimo: agregalo a este archivo en el mismo PR.

---

## Catálogo

### Vertical (`product_kind`)

Clasificación de **comportamiento**, no de navegación. Determina qué reglas aplican: un perfume se fracciona y genera merma; un reloj lleva serial y garantía. Valores: `perfume`, `watch`, `accessory`. Agregar una vertical es un cambio de software (migración + tabla de detalles + reglas + UI), no un `INSERT`.

### Categoría comercial (`categories`)

Árbol de **navegación**: breadcrumbs, SEO, merchandising. "Perfumería → Perfumes de Nicho". Un producto pertenece a varias a la vez (`product_categories`, N:N), una marcada como primaria para el breadcrumb. **No confundir con vertical.**

### Atributo

Propiedad de un producto. Si participa en cálculos (volumen, concentración, movimiento del reloj) va como **columna tipada** en `{kind}_details`. Si es descriptivo (color de la caja, año de lanzamiento) va como **faceta**.

### Faceta (`products.facets`)

Proyección JSONB indexada con GIN para filtros y búsqueda del storefront. La mantiene la capa de servicio y la verifica un job nocturno. **No lleva reglas de negocio.**

### Tag

Marca transversal de marketing: "Best Seller", "Edición Limitada", "San Valentín". No jerárquica, no estructural.

### Producto (`products`)

La entidad conceptual: "Layton de Parfums de Marly". **No se vende un producto**, se vende una variante.

### Variante (`product_variants`)

La unidad vendible y la unidad de inventario. Un mismo perfume genera varias:

| Tipo     | UOM    | Qué es                                                           |
| -------- | ------ | ---------------------------------------------------------------- |
| `sealed` | `unit` | Frasco precintado, tal como llegó del proveedor                  |
| `bulk`   | `ml`   | **Granel**: el líquido de un frasco abierto. No se vende directo |
| `decant` | `ml`   | Fracción vendible: 5, 10, 30 ml                                  |
| `unit`   | `unit` | Un reloj, un accesorio                                           |
| `supply` | `unit` | **Insumo**: vial, atomizador, etiqueta, empaque                  |
| `tester` | `ml`   | Frasco de exhibición                                             |

### Modo de producción (`production_mode`)

- `stocked`: hay lotes propios de esa variante.
- `made_to_order`: se produce al vender, consumiendo granel + insumos. Un decant típicamente es esto, y apunta a su granel de origen vía `source_variant_id`.

---

## Inventario

### Lote (`inventory_lots`)

La unidad física comprada, con su costo real. Un lote tiene **una sola unidad de medida, para siempre**. Es la unidad de costeo: dos frascos del mismo perfume comprados en momentos distintos son dos lotes con costos distintos.

### Frasco sellado abierto

Estado `open_for_decant`. Un frasco que se abrió para fraccionar **deja de ser vendible como sellado**, y la base lo impone. Esto es lo que en el ERP v2 se llamaba _stock comprometido_.

### Apertura de frasco

**Conversión entre lotes**, no un cambio de estado. Sale 1 unidad del lote sellado (`transfer_out`), nace un lote hijo de granel en mililitros (`transfer_in`) que hereda el costo íntegro **de una unidad** y apunta al padre por `parent_lot_id`. Se abre una unidad, siempre: si el lote nació con varias, la apertura las **separa** antes (la unidad que se abre pasa a un lote propio de una unidad). Ver ADR-009 y RN-LOT-02.

### Kardex / Ledger (`inventory_movements`)

El libro mayor de inventario. **Append-only e inmutable**: no se edita ni se borra, ni siquiera por la API. Es la fuente de verdad del stock. Corregir un error es insertar un movimiento de ajuste.

### Movimiento

Cada asiento del Kardex, con signo: positivo entra, negativo sale. Tipos: `purchase_receipt`, `sale`, `return_in`, `return_out`, `decant_consumption`, `decant_yield`, `bom_consumption`, `waste`, `adjustment`, `transfer_in`, `transfer_out`.

### Saldo proyectado (`inventory_balances`)

Materialización de la suma del ledger por lote, con `CHECK (on_hand >= 0)` como invariante. **Es derivado, nunca autoritativo.** La vista `v_balance_drift` lo verifica contra el ledger y debe devolver cero filas siempre.

### Reserva (`stock_reservations`)

Bloqueo temporal de stock, **separado del ledger**. El carrito no reserva; la reserva nace al iniciar el checkout, con TTL según medio de pago. Ver ADR-019.

**Disponible = saldo proyectado − reservas vivas.**

### Unidad serializada (`serialized_units`)

Un reloj concreto, con número de serie, garantía y trazabilidad de dueño. Un reloj **no es** `cantidad = 1`: es una entidad.

### Política de asignación (`allocation_policy`)

Cómo se elige qué lote consumir: `fifo` (el más antiguo), `fefo` (el que vence primero), `serial` (por número de serie), `manual`. Configurable por variante.

### BOM (`bom_components`)

_Bill of materials_, la **lista de insumos**. Un decant de 10 ml consume 10 ml de fragancia + 1 vial + 1 atomizador + 1 etiqueta. Sin BOM, el margen del decant está sistemáticamente sobreestimado.

---

## Fraccionamiento

### Decant

Fracción de perfume trasvasada de un frasco grande a un vial pequeño. El producto insignia del negocio.

### Orden de fraccionamiento (`decant_work_orders`)

El puente entre los **dos momentos** del decant:

1. **Compromiso comercial** (checkout): se reserva granel e insumos. Nadie tocó una pipeta.
2. **Transformación física** (fulfillment): alguien llena el vial. **Acá se conoce la merma real.**

Una orden marcada como ejecutada debe declarar merma real y ejecutor.

### Merma técnica

Líquido que se pierde y no se vende. **Tiene tres componentes distintos** y confundirlos deja faltantes fantasma:

| Componente               | Naturaleza                 | Campo                 |
| ------------------------ | -------------------------- | --------------------- |
| **Trasvase**             | Proporcional al volumen    | `waste_factor` (%)    |
| **Fondo no recuperable** | Fijo por frasco            | `unusable_residue_ml` |
| **Evaporación**          | Función del tiempo abierto | `evaporation_ml_year` |

### Merma esperada vs. merma real

`waste_expected` sirve para **reservar** stock. `waste_actual` es lo que efectivamente se perdió, y es lo que se contabiliza. La vista `v_decant_yield` compara ambas por producto y operador. En la validación del esquema, la real fue 1,75× la esperada.

---

## Compras y costos

### Proveedor (`suppliers`)

Quién vende a JODA. Su identidad y sus precios son **información competitiva**: nunca salen en una respuesta pública.

### Orden de compra / OC (`purchase_orders`)

El pedido al proveedor. Máquina de estados: `draft → pending_approval → approved → sent → partially_received → received`, o `cancelled`. Las transiciones válidas viven en `packages/domain`.

### Recepción (`goods_receipts`)

**Entidad propia**, no un campo de la OC. Una orden puede llegar en tres tandas con tres fletes distintos. Nunca `po.status = 'received'; stock += qty`.

### Costo puesto / landed cost (`landed_cost_pyg`)

Lo que realmente cuesta la mercadería en Encarnación: precio (`supplierPrice`) + flete (`freight`) + despacho (`customsClearance`) + impuestos y comisiones (`other`), con el **FX real de esa recepción**, no el estimado de la orden. Es lo que se usa para calcular márgenes. Impuestos y comisiones no tienen campo propio — van dentro de `other` hasta que el motor de posteo (Bloque H) necesite distinguirlos por cuenta contable.

`computeLandedCost` (`packages/domain/src/procurement/landedCost.ts`) asume una sola moneda extranjera por recepción: todos los componentes tienen que compartir moneda con `supplierPrice`. En una importación real el despacho, los aranceles y el despachante se pagan en guaraníes mientras el proveedor cobra en USD/BRL — hoy eso se resuelve convirtiendo esos gastos a la moneda de la recepción **antes** de pasarlos a `computeLandedCost` (ver la limitación conocida en `docs/backlog.md`, nota de WP-A05).

### Prorrateo de flete

Distribución del flete entre las líneas de una recepción. Métodos: `by_value`, `by_unit`, `by_volume`, `manual`. El criterio elegido se guarda para que el costo sea reproducible. En `manual` el operador fija el flete de cada línea a mano (`manualAmount`) y el sistema solo valida que la suma cierre contra el flete total — no reparte nada.

### Snapshot de FX (`fx_rate_to_pyg`)

Tipo de cambio congelado al momento de la transacción. **Nunca se recalcula.** Si el dólar se mueve, el historial no se reescribe solo.

### Sourcing / escenario (`sourcing_scenarios`)

Simulación de compra para comparar alternativas (proveedor A vs. B, comprar ahora vs. esperar). **No toca inventario, ni caja, ni cuentas por pagar** hasta que se convierte explícitamente en una orden.

### Capas de costo (`movement_cost_allocations`)

Registro de qué lote y a qué costo se consumió en cada salida. Una venta de 3 unidades puede consumir dos lotes con costos distintos; sin esto, el COGS es una aproximación.

---

## Ventas

### Canal (`sales_channels`)

Dónde se vende: `web`, `presencial`, `instagram`, `whatsapp`. Con política de stock `shared` (todos compiten por el mismo pool) o `allocated` (se aparta cantidad por canal).

### Pedido (`sale_orders`)

La venta. Estados: `draft → awaiting_payment → paid → preparing → ready → shipped → delivered`, o `cancelled` / `refunded`.

### Seña / depósito (`customer_deposits`)

Adelanto del cliente sobre una compra futura. **Es un pasivo, no un ingreso**: es plata que se debe, no que se ganó. Se acredita a `2.1.02.001 Señas de clientes` y se aplica explícitamente a un pedido. Ver ADR-013.

### COGS (`cogs_pyg`)

_Cost of goods sold_, el **costo de la mercadería vendida**. Para un decant incluye líquido + merma + insumos, calculado sobre el landed cost real de ese frasco.

### RMA (`returns`)

_Return merchandise authorization_, la **devolución**. Estados: `requested → received → inspection → approved/rejected → resolved`. El destino de lo devuelto (`disposition`) puede ser `restock_available`, `quarantine`, `open_box`, `refurbished`, `damaged`, `supplier_return`.

---

## Contabilidad

### Partida doble

Todo hecho económico genera un asiento donde `SUM(debe) = SUM(haber)`. La base lo impone con una constraint diferida que se valida al `COMMIT`.

### Plan de cuentas (`chart_of_accounts`)

Árbol de cuentas: activo, pasivo, patrimonio, ingresos, egresos. Solo las cuentas **imputables** (`is_postable`) reciben asientos; las de agrupación no.

### Asiento (`journal_entries` + `journal_lines`)

El registro contable de un hecho económico. Un asiento **contabilizado** (`posted`) no se modifica: se reversa con otro asiento.

### Regla de posteo (`posting_rules`)

Plantilla declarativa que convierte un evento de negocio en un asiento. **Los asientos se derivan, no se cargan a mano.** El operador confirma una venta; el motor genera el asiento. Las reglas nacen **apagadas** y se encienden de a una.

### Evento sin postear (`unposted_events`)

Bandeja de hechos económicos que todavía no generaron asiento, porque su regla está apagada o falló. Visible y reprocesable, **nunca perdido en silencio**.

### Arqueo

Conteo físico de caja contra el saldo del sistema. La diferencia dispara alerta.

---

## Fiscal (Paraguay)

### SIFEN

Sistema Integrado de Facturación Electrónica Nacional, administrado por la DNIT.

### e-Kuatia / e-Kuatia'i

El ecosistema de facturación electrónica. **e-Kuatia'i** es la herramienta gratuita de la DNIT para bajo volumen de emisión.

### DNIT

Dirección Nacional de Ingresos Tributarios. Absorbió a la ex SET.

### CDC

Código de Control del Documento: identificador único de 44 dígitos de un documento tributario electrónico. Un documento aprobado siempre tiene CDC.

### KuDE

Representación gráfica imprimible del documento electrónico. Es lo que ve el cliente.

### Timbrado

Autorización de la DNIT para emitir comprobantes, con vigencia y numeración.

### Documento fiscal (`fiscal_documents`)

Factura, nota de crédito, nota de débito, autofactura o nota de remisión. **Una venta puede generar 0, 1 o N documentos fiscales.** Nunca colapsar `sale_order` y factura en la misma tabla.

### IVA incluido

En Paraguay el precio se muestra con impuesto incluido. Por eso:

```
IVA 10% = total / 11        IVA 5% = total / 21        Exenta = 0
```

**Nunca `total * 0.10`.** El redondeo se resuelve a nivel de documento, que es lo que valida SIFEN, y la diferencia se imputa a la última línea.

### Base gravada

Lo que queda de un bruto con IVA incluido después de extraer el IVA: `base = bruto − iva`, nunca un cálculo independiente (RN-IVA-04) — así `base + iva = bruto` siempre, exacto. RN-FIS-02 lo confirma literal: "cada `taxed_*` es la base gravada".

**Dos formas, mismo concepto (no es una inconsistencia).** `packages/domain/src/tax/vat.ts` la nombra `base` (campo) / `taxBase()` (función): un campo genérico por línea, porque cada línea ya lleva su `rate` como dato. Las migraciones SQL la parten en `taxed_10_pyg` / `taxed_5_pyg` / `exempt_pyg` (`sale_orders`, `fiscal_documents`, RN-FIS-02): tres columnas porque una tabla relacional necesita una por tasa. Es la misma "base gravada" expresada de dos formas obligadas por la forma de cada capa — como `flete_por_aire`/`flete_por_barco` en SQL para lo que en dominio es un único "costo de flete" con un campo `method`. No hay rename pendiente.

### Guaraní / PYG

Moneda de Paraguay, **sin subdivisión operativa**. En el código, `bigint` de unidades enteras. Nunca `float`, nunca decimales.

---

## Plataforma

### Tenant (`tenant_id`)

Unidad de aislamiento. Hoy hay uno solo (JODA), pero está en toda tabla desde el día uno para no pagar una segunda reescritura si el sistema se vende como producto.

### RLS

_Row Level Security_ de PostgreSQL. Aislamiento por tenant y por permiso, evaluado en la base. **Solo funciona si la conexión no es privilegiada**: por eso la API usa el rol `joda_api`, que es `NOBYPASSRLS`.

### `joda_api`

Rol de base con el que se conecta el proceso que atiende peticiones. Creado `NOBYPASSRLS`, sin `UPDATE` ni `DELETE` sobre el libro de inventario, las capas de costo, la auditoría ni los eventos fiscales. Es lo que hace que RLS sea una defensa real y no decorativa.

### `joda_readonly`

Rol de base con el que el storefront lee el catálogo público. Solo `SELECT`, y únicamente sobre las vistas de `public` (`v_catalog_products`, `v_catalog_variants`). No alcanza ninguna tabla base: si el storefront leyera tablas, el esquema interno se volvería API pública y no se podría refactorizar nada.

### `service_role`

Credencial elevada de Supabase. **Exclusiva de migraciones y ETL ejecutados desde integración continua.** Nunca en el runtime de la API: elude RLS por completo.

### Audiencia (`audience`)

Quién está actuando: `staff`, `customer` o `system`. Determina qué superficie del sistema es accesible.

### Sesión de personal

La identidad autenticada de un usuario de `staff_users` mientras opera el backoffice (ADR-015). Vive del lado del servidor: la cookie `__Host-joda_a` es lo único que llega al navegador, httpOnly y firmada. Dura como máximo 8 h desde el login — una ventana **absoluta**, que no se extiende al usar el sistema — y agrupa una **familia** de tokens de refresco que rotan dentro de esa ventana (`staff_sessions`, `staff_refresh_tokens`, `packages/db/migrations/0011_staff_sessions.sql`).

### Token de acceso

La resolución vigente de una sesión de personal — quién es, de qué tenant, con qué audiencia — cacheada en Redis por 15 min (`docs/security-spec.md` §4.2). No es un artefacto que viaje aparte al cliente: nunca sale del servidor, ni siquiera en el cuerpo de una respuesta.

### Token de refresco

Secreto opaco, rotativo, que renueva el token de acceso dentro de la ventana de 8 h de una sesión de personal. **"Rotativo" describe el uso explícito** — cada llamada a `auth.session.refresh` emite uno nuevo e invalida el anterior, nunca se reescribe un token existente, se inserta una fila nueva y se marca `consumed_at` en la vieja (mismo espíritu que el ledger de inventario: append-only, no editar en su lugar). Fuera de ese camino, validar el mismo secreto repetidas veces (el "camino lento" de `apps/api/src/trpc/context.ts` cuando el token de acceso cacheado venció) no lo rota — es un riesgo residual conocido, documentado en `resolveRequestSession` (`apps/api/src/modules/auth/service.ts`), no cerrado por este WP.

### Detección de reúso

Si un token de refresco ya consumido (con `consumed_at` no nulo) vuelve a presentarse, es la señal de que alguien copió un token — se invalida **toda la familia** de la sesión, no solo ese token, y se fuerza reautenticación (`docs/security-spec.md` §4.2, criterio de aceptación de WP-C03).

### Segundo factor / TOTP (`staff_users.mfa_enrolled`)

Obligatorio para personal, opcional para clientes (ADR-015). TOTP (_Time-based One-Time Password_, RFC 6238): un código de 6 dígitos que cambia cada 30 s, derivado de un secreto compartido entre el servidor y la app autenticadora del usuario. Un usuario sin inscribir solo puede acceder a la pantalla de inscripción (`auth.mfa.enroll`/`confirmEnroll`); uno ya inscripto tiene que satisfacer el desafío (`auth.mfa.verify`) en **cada sesión nueva**, no solo la primera vez — si no, dejaría de ser un segundo factor después de la primera inscripción. El estado se guarda por sesión, no por usuario: `staff_sessions.mfa_verified_at` (`docs/security-spec.md` §4.3, criterio de aceptación de WP-C04).

### Idempotencia

Garantía de que repetir una operación no la duplica. Aplica a webhooks de pago (`UNIQUE (provider, external_event_id)`) y a mutaciones offline del admin (`Idempotency-Key`). Bancard reintenta: sin esto, una venta se confirma dos veces.

### Deriva (`v_balance_drift`)

Diferencia entre el saldo proyectado y la suma del ledger. **Siempre debe ser cero.** Si no lo es, algo se escribió por fuera del flujo.

### Corte

El momento único en que la operación pasa del sistema actual (Dexie, en el navegador) a la plataforma en la nube. Es el bloque F del backlog y la meta intermedia del proyecto. Se ejecuta en una sola ventana, sin escritura dual, y no procede si el reporte de reconciliación no cierra con tolerancia cero en stock, caja y señas. Ver ADR-021.

### Dataset dorado

Conjunto de unas veinte operaciones del negocio —compras con flete, aperturas de frasco, fraccionamientos, ventas mixtas— con sus resultados verificados a mano, no generados corriendo el código que se quiere probar. Vive en `packages/domain/test/golden/` y corre en cada PR.

Cada caso declara su procedencia en el campo `origen` (dos valores posibles, sin término medio — `packages/domain/test/golden/case.ts`):

- **Ejemplo trabajado de `docs/domain-rules.md`**: el número ya estaba redactado en la documentación al escribir la regla. Detecta que un refactor cambió un cálculo, pero no confirma que el cálculo coincide con cómo opera JODA — el ejemplo se redactó al documentar, no salió de una venta o compra real.
- **Operación real**: sale del export del ERP v2 (WP-D01) o de una planilla de costos, con el valor esperado calculado a mano contra la operación histórica. Es la única procedencia que de verdad confirma el costeo (WP-A10b).

Es lo que permite refactorizar el costeo sin miedo: si los casos siguen dando lo mismo después de reescribir el módulo, el refactor es correcto. Un valor esperado nunca se actualiza para "hacer pasar el test", ni se genera ejecutando el código bajo prueba; cambiarlo requiere justificación explícita en el PR.

### Reconciliación

Comparación entre el sistema actual y el nuevo antes del corte: conteos de productos, variantes, proveedores y ventas, stock por variante en unidades y mililitros, saldo de caja e imágenes migradas. **Tolerancia cero.** Si alguna métrica no cierra, el corte no se ejecuta.

### Paquete de trabajo (WP)

Unidad del backlog que un agente puede tomar, completar y verificar en una sesión, con criterio de aceptación explícito. Identificador `WP-<bloque><nn>`, referenciado en la rama, el commit y el PR.

### Puerto y adaptador

Patrón para integraciones externas. El **puerto** es la interfaz en `packages/domain` (por ejemplo `FiscalProvider`); el **adaptador** es la implementación concreta en `apps/api/src/adapters/`. Permite arrancar con un adaptador `manual` y cambiarlo por uno homologado sin tocar el resto.
