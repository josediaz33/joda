# Modelo de Datos

Referencia del esquema. La verdad ejecutable está en `packages/db/migrations/`; este documento explica **por qué** está así.

Estado: validado contra PostgreSQL 16 — 63 tablas, 106 `CHECK`, 166 claves foráneas, 165 índices, 62 tablas con RLS (todas salvo `permissions`, catálogo global — ver WP-B08), 78/78 invariantes verificados.

---

## 1. Convenciones

| Aspecto         | Regla                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Esquema         | Todo en `app`. Las vistas públicas en `public`.                                                                                                |
| Identificadores | `uuid` con `gen_random_uuid()`, salvo tablas de alto volumen que usan `bigint` identity (`inventory_movements`, `journal_lines`, `audit_log`). |
| Nombres         | Inglés, `snake_case`, tablas en plural.                                                                                                        |
| Aislamiento     | `tenant_id uuid NOT NULL` en toda tabla de negocio. Sin excepciones.                                                                           |
| Dinero          | Dominio `pyg` (bigint). Moneda extranjera: `minor_amount` + `currency_code` + `fx_rate`.                                                       |
| Cantidades      | Dominio `qty` = `numeric(14,3)`. Tres decimales para mililitros.                                                                               |
| Fechas          | `timestamptz` siempre. Almacenamiento en UTC.                                                                                                  |
| Enums           | Tipos nativos de PostgreSQL, no tablas de catálogo, cuando el conjunto es cerrado y lo conoce el código.                                       |
| Auditoría       | `created_at`, `updated_at` en entidades mutables. Las append-only solo `occurred_at`.                                                          |

**"Toda tabla de negocio" incluye las tablas de unión y de líneas**, aunque el tenant se pueda derivar del padre por FK. Las comprobaciones de integridad referencial de Postgres corren con privilegio interno y NO evalúan RLS, así que una FK al padre no protege nada. El bucle de `0010_security_rls.sql` habilita RLS donde existe la columna `tenant_id`: una tabla sin esa columna queda desprotegida en silencio. Es lo que pasó con 25 tablas hasta WP-B08 (§7 y §11 de `packages/db/README.md` tienen el detalle completo).

---

## 2. Mapa por módulo

```
IDENTIDAD              tenants · staff_users · customers · customer_addresses
                       permissions · roles · role_permissions · staff_user_roles
                       audit_log · idempotency_keys

CATÁLOGO               brands · categories · tags
                       products · perfume_details · watch_details · accessory_details
                       product_categories · product_tags
                       product_variants · bom_components
                       media · product_media

INVENTARIO             inventory_lots · serialized_units
                       inventory_movements · movement_cost_allocations
                       inventory_balances · stock_reservations
                       decant_work_orders

COMPRAS / MARKET       suppliers · supplier_contacts
                       purchase_orders · purchase_order_lines · purchase_order_transitions
                       goods_receipts · goods_receipt_lines
                       sourcing_scenarios · sourcing_scenario_lines

VENTAS                 sales_channels · channel_listings
                       sale_orders · sale_order_lines · sale_order_transitions
                       shipments · payments · payment_events
                       customer_deposits · customer_deposit_applications
                       returns · return_items

CONTABILIDAD           chart_of_accounts · accounting_periods
                       journal_entries · journal_lines
                       posting_rules · unposted_events

FISCAL                 fiscal_config · fiscal_documents
                       fiscal_document_lines · fiscal_events
```

---

## 3. Relaciones centrales

### 3.1 Producto y sus verticales

```
                        products
                   (kind, UNIQUE(id, kind))
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
 perfume_details      watch_details      accessory_details
 FK (product_id,      FK (product_id,    FK (product_id,
     kind='perfume')      kind='watch')      kind='accessory')
```

La FK compuesta es lo que impide que un reloj tenga detalles de perfume. Cada tabla de detalle declara `kind` con `DEFAULT` y `CHECK` de valor fijo, y referencia `products (id, kind)`.

**Navegación separada del comportamiento:**

```
products ──< product_categories >── categories (árbol, path materializado)
products ──< product_tags       >── tags
```

`product_categories` lleva un índice único parcial `WHERE is_primary` que garantiza exactamente una categoría primaria por producto.

### 3.2 Variantes y BOM

```
products ──< product_variants
                   │  variant_type: sealed | bulk | decant | unit | supply | tester
                   │  production_mode: stocked | made_to_order
                   │  source_variant_id ──┐  (de qué granel se sirve)
                   │                      │
                   └──< bom_components >──┘  (qué insumos consume)
```

### 3.3 Inventario

```
product_variants ──< inventory_lots ──┬──< inventory_movements ──< movement_cost_allocations
                          │           │                                (capas de costo)
                          │           ├──── inventory_balances  (1:1, proyección)
                          │           │
                          │           └──< serialized_units
                          │
                          └──── parent_lot_id (autoreferencia: lote del que se derivó)

product_variants ──< stock_reservations   (separadas del ledger)

inventory_lots ──< decant_work_orders >── product_variants
                          │
                          └── sale_order_id
```

**`inventory_balances` la escriben solo los triggers.** `init_lot_balance` y `project_lot_balance` son `SECURITY DEFINER`; `joda_api` solo tiene SELECT (WP-B09b, `0024_revoke_balances_write.sql`, invariante 74). Un saldo equivocado se corrige con un movimiento de ajuste, nunca editando la proyección.

**La autoreferencia `parent_lot_id` significa "lote del que se derivó"**, y es lo que modela la apertura de frasco. Se distinguen dos casos por el tipo de variante del hijo:

- **Apertura** (sellado → granel): el lote de granel apunta al lote sellado del que salió, con el costo de UNA unidad del sellado heredado íntegro (RN-LOT-02).
- **Separación** (sellado → sellado): al abrir un frasco de un lote de varias unidades, la unidad que se abre nace como un lote propio de una unidad que apunta al lote original (caso borde 21, WP-C11).

No hay una columna que diga cuál es cuál: el tipo de la variante del hijo lo dice.

**Del granel a la compra son dos saltos.** Al abrir un frasco de un lote de varias unidades, el granel apunta al lote de una unidad separado, y ese al lote original. Para llegar a la recepción, el proveedor y el costo de compra hay que seguir `parent_lot_id` hasta el lote que no tiene padre: solo ese conserva `goods_receipt_line_id`. El lote de una unidad que nace de la separación lo deja en NULL a propósito, para no contar la misma recepción dos veces. Con un lote de una unidad, la apertura es directa y hay un solo salto.

**`reference_type` de los movimientos de la apertura** (WP-C11): `lot_separation` en los dos movimientos de la separación (`reference_id` = el lote de una unidad que nace) y `lot_opening` en los dos de la apertura (`reference_id` = el lote sellado que se abre, también en la entrada al granel, no el id del granel).

### 3.4 Flujo de compra

```
suppliers ──< purchase_orders ──< purchase_order_lines
                    │                      │
                    │                      │
                    └──< goods_receipts ──< goods_receipt_lines ──> inventory_lots
                                                                          │
                                                                          └──> inventory_movements
```

La recepción es entidad propia: una orden puede llegar en varias tandas con fletes distintos.

### 3.5 Flujo de venta

```
customers ──< sale_orders ──< sale_order_lines ──> serialized_units
                  │                    │
                  │                    └──> product_variants
                  ├──< payments ──< payment_events   (UNIQUE provider+external_event_id)
                  ├──< shipments
                  ├──< returns ──< return_items
                  ├──< fiscal_documents ──< fiscal_document_lines
                  └──< customer_deposit_applications >── customer_deposits
```

### 3.6 Contabilidad

```
chart_of_accounts (árbol) ──< journal_lines >── journal_entries >── accounting_periods
                                                       │
posting_rules ─────────────────────────────────────────┤
                                                       │
unposted_events ───────────────────────────────────────┘
```

`journal_entries.source_type` + `source_id` traza cada asiento al hecho económico que lo originó.

---

## 4. Catálogo de invariantes

Los 18 originales verificados en `packages/db/tests/invariants.sql` (el archivo tiene hoy 90: los de WP-C03 en adelante no están en esta tabla). **Agregar un invariante nuevo obliga a agregar su test.**

| #   | Invariante                                        | Mecanismo                                                              |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | El libro de inventario no se edita                | Trigger `BEFORE UPDATE`                                                |
| 2   | El libro de inventario no se borra                | Trigger `BEFORE DELETE` + `REVOKE` a `joda_api`                        |
| 3   | El saldo de un lote nunca es negativo             | `CHECK (on_hand >= 0)` en la proyección                                |
| 4   | El signo del movimiento coincide con su tipo      | `CHECK` compuesto por `movement_type`                                  |
| 5   | La unidad del movimiento coincide con la del lote | Trigger `BEFORE INSERT`                                                |
| 6   | Un frasco abierto no se vende sellado             | Trigger `BEFORE INSERT` (desde WP-B08c, ningún movimiento)             |
| 7   | Todo asiento cuadra                               | Constraint trigger **diferida**                                        |
| 8   | Una línea contable es débito o crédito, no ambos  | `CHECK`                                                                |
| 9   | Un asiento contabilizado no se modifica           | Triggers sobre líneas y asiento (0020): solo `draft` cambia            |
| 10  | Una notificación de pago no se procesa dos veces  | `UNIQUE (provider, external_event_id)`                                 |
| 11  | Un producto no tiene detalles de otra vertical    | FK compuesta `(product_id, kind)`                                      |
| 12  | Una seña no se sobre-aplica                       | `CHECK (applied + refunded <= amount)`                                 |
| 13  | Las capas de costo cuadran con el movimiento      | Constraint trigger diferida                                            |
| 14  | Una nota de crédito referencia un documento       | `CHECK` condicional por `doc_type`                                     |
| 15  | Un documento aprobado tiene código de control     | `CHECK` condicional por `status`                                       |
| 16  | El total del pedido es consistente                | `CHECK (total = subtotal − descuento + envío)`                         |
| 17  | Una variante bajo pedido declara su granel        | `CHECK (production_mode = 'stocked' OR source_variant_id IS NOT NULL)` |
| 18  | La bitácora de auditoría no se borra              | Trigger `BEFORE UPDATE OR DELETE`                                      |

### 4.1 Por qué algunas constraints son diferidas

`trg_journal_balanced` y `trg_cost_allocation_matches` se validan al `COMMIT`, no en cada fila. Las líneas de un asiento se insertan de a una: validar inmediatamente rechazaría la primera línea siempre.

```sql
CREATE CONSTRAINT TRIGGER trg_journal_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_entry_balanced();
```

Para testearlas hay que forzar la evaluación: `SET CONSTRAINTS app.trg_journal_balanced IMMEDIATE;`

### 4.2 Todo trigger que impone un invariante falla cerrado

**Si no puede leer lo que necesita para decidir, rechaza.** Nunca compara contra un valor que podría ser NULL por falta de visibilidad. Se escribe con `IF NOT FOUND THEN RAISE`, no con una comparación que se evalúe a falso:

```sql
-- MAL: si RLS oculta el asiento, v_status queda NULL, la comparación da
-- NULL (no TRUE) y el trigger deja pasar.
SELECT status INTO v_status FROM app.journal_entries WHERE id = ...;
IF v_status = 'posted' THEN RAISE ...; END IF;

-- BIEN: no encontrar el asiento es motivo de rechazo.
SELECT status INTO v_status FROM app.journal_entries WHERE id = ...;
IF NOT FOUND THEN RAISE ...; END IF;
IF v_status = 'posted' THEN RAISE ...; END IF;
```

No es hipotético. WP-B10 hizo que `journal_entries` exija `accounting.journal:read` para leer. `guard_posted_journal` corría con los permisos de quien edita, y un vendedor sin ese permiso pudo editar y borrar líneas de un asiento contabilizado. Corregido en `0017_guard_posted_journal_fail_closed.sql`.

Además, una función que impone un invariante verifica integridad, no expone datos: va `SECURITY DEFINER` con `SET search_path = app, pg_temp` (`pg_temp` al final, nombres calificados con `app.`). Si una tabla referenciada tiene `tenant_id`, la función verifica que coincida con el de la fila que dispara el trigger: como `SECURITY DEFINER` ve todos los tenants y una FK no evalúa RLS, nadie más lo haría.

Desde WP-B09 (`0018_invariant_triggers_security_definer.sql`) toda función de disparador de `app.*` sigue este patrón. Los invariantes 28–30 lo verifican de forma estructural: toda función de disparador tiene `search_path = app, pg_temp`; toda es `SECURITY DEFINER` salvo `set_updated_at` y `guard_append_only`, que no leen ninguna tabla; y el dueño de toda función `SECURITY DEFINER` elude RLS. Ese último es una dependencia operativa. `SECURITY DEFINER` corre como el rol que ejecutó la migración, y si ese rol no es superusuario ni `BYPASSRLS`, `FORCE ROW LEVEL SECURITY` lo filtra igual que a `joda_api`.

**Ningún trigger depende de que otro haya corrido antes.** Los `BEFORE INSERT` de una tabla se ejecutan en orden alfabético, y un trigger que rechaza primero puede ocultar que el siguiente falla abierto. Pasó con `assert_sealed_lot_not_open`: desde WP-B01 dejaba vender como sellado un frasco abierto cuando no veía el lote, y no se notaba porque `trg_movement_uom` corría antes y rechazaba. Por eso cada función hace su propia búsqueda con su propio `IF NOT FOUND`. Los invariantes 33 y 34 deshabilitan los demás triggers y prueban cada función por separado.

### 4.3 Toda FK entre tablas con `tenant_id` incluye `tenant_id`

**Una FK no evalúa RLS.** Verifica que la fila apuntada exista, no que sea del mismo tenant. Hasta WP-B08c, un staff creaba un lote propio con la variante de otro tenant.

Desde `0023_cross_tenant_fks.sql`, cada FK entre dos tablas con `tenant_id` es compuesta: `(col, tenant_id) REFERENCES destino (id, tenant_id)`. La tabla destino lleva `UNIQUE (id, tenant_id)`, redundante con la PK, porque Postgres lo exige para ser referenciada así. Es declarativa y falla cerrado por construcción. Con `col` en NULL no verifica nada, y está bien: no hay referencia.

- **Una tabla nueva sigue el mismo patrón.** El invariante 67 falla si aparece una FK entre tablas con `tenant_id` que no incluya `tenant_id`. `cross_tenant_fks.test.ts` compara su inventario contra `pg_constraint` y prueba cada FK como `joda_api`.
- **ON DELETE SET NULL se escribe `SET NULL (col)`.** Sin la lista de columnas, Postgres pondría en NULL también `tenant_id`.
- **`inventory_movements.lot_id` incluye además la variante:** `(lot_id, variant_id, tenant_id) REFERENCES inventory_lots (id, variant_id, tenant_id)`. La variante de un movimiento es la de su lote. Un lote con movimientos no cambia de variante.
- **`serialized_units.lot_id` incluye además la variante** (WP-C12, `0029_serialized_unit_lot_variant.sql`): `(lot_id, variant_id, tenant_id) REFERENCES inventory_lots (id, variant_id, tenant_id)`. La variante de una unidad serializada es la de su lote (RN-SER-04), el mismo patrón que los movimientos. Con `lot_id` nulo no verifica nada (una unidad puede existir sin lote), y un lote con unidades no cambia de variante. `stock_reservations` (lote y unidad serializada) hereda lo mismo en WP-C18.
- **Los triggers de 0018 siguen verificando el tenant por su cuenta.** Corren antes que las FKs, que son AFTER, y no dependen de ellas (§4.2).

### 4.4 La apertura de frasco (WP-C11, `0028_sealed_open_single_unit.sql`)

Dos invariantes que hacen que la apertura no se pueda hacer mal aunque alguien se saltee la API:

- **Un lote de variante sellada en `open_for_decant` tiene `qty_initial = 1`.** `trg_sealed_open_single_unit`, `BEFORE INSERT OR UPDATE OF status, qty_initial, variant_id`. Es un invariante del estado de la fila, no una transición: no entra en las excepciones de ADR-017. Sin él, marcar abierto un lote de tres dejaba dos frascos sellados con saldo e invendibles (RN-LOT-03), y el granel heredaba el costo del lote entero (caso borde 21). Como todo trigger de invariante, falla cerrado (§4.2): si no encuentra la variante en el tenant del lote, rechaza.
- **Un producto tiene a lo sumo una variante de granel.** Índice único parcial `product_variants_one_bulk_per_product ON product_variants (product_id) WHERE variant_type = bulk`. Un producto es un solo líquido aunque se venda en varios tamaños; la apertura necesita saber a qué granel va el frasco, y lo impone la base, no la búsqueda.

**El ETL tiene que respetar los dos** (WP-D03 y WP-D05, con criterio de aceptación). Un lote de varias unidades con alguna abierta en el v2 no se puede cargar tal cual: la migración falla si el dato es incoherente, en vez de aceptarlo.

---

## 5. Vistas

| Vista                       | Propósito                                                       | Consumidor                   |
| --------------------------- | --------------------------------------------------------------- | ---------------------------- |
| `app.v_stock_available`     | `saldo − reservas vivas` por variante                           | API, backoffice              |
| `app.v_balance_drift`       | Proyección contra suma del libro. **Debe devolver cero filas.** | Job nocturno, alertas        |
| `app.v_decant_yield`        | Merma real contra esperada por producto                         | Reportes                     |
| `app.v_trial_balance`       | Balance de sumas y saldos por período                           | Contabilidad                 |
| `public.v_catalog_products` | Catálogo publicado, sin costos ni proveedores                   | Storefront (`joda_readonly`) |
| `public.v_catalog_variants` | Variantes publicadas con disponibilidad **booleana**            | Storefront (`joda_readonly`) |

Las vistas públicas son el contrato con el storefront. **El storefront nunca lee tablas base.** Si leyera, el esquema interno se volvería API pública y no se podría refactorizar nada.

**Con qué permisos corre cada vista** (WP-B12, `0021_app_views_security_invoker.sql`):

- `v_trial_balance`, `v_balance_drift` y `v_decant_yield` son `security_invoker`: RLS se evalúa como en una consulta directa. Sin tenant, cero filas. `v_trial_balance` además exige `accounting.journal:read`, y `v_balance_drift` exige `inventory.stock:read`.
- **`v_balance_drift` vacía no significa "sin deriva"** para quien no ve los lotes. El chequeo de deriva corre con el rol de migraciones/CI, o con tenant y `inventory.stock:read`, y en ese caso verificando que ve lotes.
- `v_trial_balance` cuenta los asientos `posted` y `reversed`: una reversión compensa a su original (RN-CTB-06). La compensación vale en el total. Por período, cada asiento queda en el suyo: si la reversión cae en un período posterior, el original sigue en su período (un período cerrado no se reescribe) y la reversión impacta en el propio (invariante 65).
- `public.v_catalog_*` corren como su dueño a propósito, para que `joda_readonly` vea el catálogo publicado.
- `v_stock_available` es `security_invoker` desde WP-B12b (`0022_stock_available_invoker.sql`): exige solo tenant, así que el vendedor la ve y otro tenant no. `v_catalog_variants` ya no la lee: calcula `saldo − reservas vivas` desde `inventory_balances` y `stock_reservations` dentro de la propia vista, que sigue corriendo como su dueño. No se la leyó a través de una vista interna porque esa vista también correría como su dueño y el `ALTER DEFAULT PRIVILEGES` de 0010 se la concedería a `joda_api`. La fórmula queda escrita dos veces, y el invariante 66 verifica que las dos coincidan.

`v_catalog_variants` expone `in_stock` como booleano, nunca la cantidad: el stock es información competitiva.

---

## 6. Índices relevantes

Más allá de las claves primarias y foráneas:

| Índice                           | Sobre                                                          | Para qué                 |
| -------------------------------- | -------------------------------------------------------------- | ------------------------ |
| `products_facets_gin`            | `products.facets` (GIN, `jsonb_path_ops`)                      | Filtros del storefront   |
| `products_search_gin`            | `products.search_vector` (GIN)                                 | Búsqueda de texto        |
| `lots_variant_fifo`              | `(tenant_id, variant_id, received_at)` parcial                 | Selección FIFO           |
| `lots_variant_fefo`              | `(tenant_id, variant_id, expiry_at)` parcial                   | Selección FEFO           |
| `mov_lot_time`                   | `(lot_id, occurred_at, id)`                                    | Historial de lote        |
| `reservations_live`              | `(tenant_id, variant_id)` parcial `WHERE released_at IS NULL`  | Cálculo de disponible    |
| `reservations_expiry`            | `(expires_at)` parcial                                         | Job de liberación        |
| `product_categories_one_primary` | `(product_id)` único parcial `WHERE is_primary`                | Invariante de breadcrumb |
| `unposted_open`                  | `(tenant_id, occurred_at)` parcial `WHERE resolved_at IS NULL` | Bandeja de eventos       |

Los índices parciales importan: `lots_variant_fifo` solo cubre lotes con estado utilizable, así que no crece con el histórico agotado.

---

## 7. Seguridad a nivel de fila

Toda tabla con `tenant_id` tiene RLS habilitado **y forzado**, con una política de aislamiento **RESTRICTIVE** más una permisiva base (WP-B10, `0016_rls_tenant_isolation_restrictive.sql`):

```sql
ALTER TABLE app.<tabla> ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.<tabla> FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.<tabla> AS RESTRICTIVE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
-- Permisiva base requerida por Postgres, que deniega todo si no hay
-- ninguna permisiva. El filtrado lo hace tenant_isolation, que es
-- RESTRICTIVE. Nunca uses esta política sin la restrictiva.
CREATE POLICY tenant_access ON app.<tabla>
  USING (true) WITH CHECK (true);
```

Encima, políticas de permiso sobre lo sensible: `journal_entries`, `chart_of_accounts`, `customer_deposits`, `sourcing_scenarios`, `suppliers`, `purchase_orders`, `inventory_lots`. En esas tablas no hay `tenant_access` para los comandos que cubre la política de permiso: ahí la permisiva es la de permiso, así que el resultado es tenant **Y** permiso.

**Por qué RESTRICTIVE.** Las políticas permisivas se combinan con OR. Hasta WP-B10, `tenant_isolation` era permisiva (el default de Postgres), así que en las siete tablas de arriba alcanzaba con tener el permiso para leer filas de **cualquier** tenant. Una restrictiva se combina con AND contra todas las demás. El invariante 23 falla si aparece una tabla con RLS sin `tenant_isolation` RESTRICTIVE.

**`FORCE` es necesario** porque sin él el dueño de la tabla eludiría las políticas. Y la API se conecta con `joda_api`, creado `NOBYPASSRLS`: si usara `service_role`, nada de esto se evaluaría.

**Dos excepciones, sin `tenant_id` ni RLS, por diseño — no un olvido** (WP-B08, `packages/db/migrations/0014_rls_sweep.sql`):

- `permissions` — catálogo global de códigos de permiso, el mismo para todos los tenants.
- `tenants` — la tabla que define los tenants no puede tener su propio `tenant_id`. Tiene su propia política, `id = app.current_tenant_id()`.

Cualquier otra tabla de `app.*` sin RLS es un descuido: `packages/db/tests/invariants.sql` (invariante 22) falla si aparece una. La motivación de este chequeo fue real, no hipotética — `product_media` tuvo exactamente este hueco durante todo WP-C09 (subida de imágenes de catálogo), detectado recién en la revisión cruzada: tenía una FK a `products`, pero ninguna FK de Postgres evalúa RLS, así que un `product_id` de otro tenant la pasaba igual. **La FK sola nunca alcanza para aislar por tenant** — cualquier tabla nueva que dependa del tenant solo por una FK transitiva necesita su propio `tenant_id`, punto.

---

## 8. Cómo agregar una vertical de producto

Ejemplo con "Accesorios" ya presente; para una nueva:

```sql
-- 1. Extender el enum
ALTER TYPE app.product_kind ADD VALUE 'candle';

-- 2. Tabla de detalles con la FK compuesta Y su propio tenant_id — la FK a
-- products NO alcanza para aislar por tenant (los checks de integridad
-- referencial de Postgres no evalúan RLS; ver WP-B08,
-- packages/db/migrations/0014_rls_sweep.sql, motivado por un producto de
-- OTRO tenant que pasaba la FK de product_media sin que nada lo notara).
CREATE TABLE app.candle_details (
  tenant_id   uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  product_id  uuid PRIMARY KEY REFERENCES app.products(id) ON DELETE CASCADE,
  kind        app.product_kind NOT NULL DEFAULT 'candle' CHECK (kind = 'candle'),
  wax_type    text NOT NULL,
  burn_hours  integer CHECK (burn_hours > 0),
  FOREIGN KEY (product_id, kind) REFERENCES app.products(id, kind)
);

-- 3. RLS — misma política que toda tabla con tenant_id (§7 de este
-- documento). Una migración nueva no hereda el bucle automático de
-- 0010_security_rls.sql (ya corrió); declarala explícita:
ALTER TABLE app.candle_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.candle_details FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.candle_details
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
```

El service que inserte en `candle_details` también tiene que pasar
`tenant_id` (el de `ctx`, igual que cualquier otro insert) — RLS protege la
FILA, no evita por sí solo insertar una fila propia que referencia un
`product_id` ajeno. Verificar que el producto exista PARA EL TENANT antes de
insertar (`findProductRow` dentro de `withTenantTx`, mismo patrón que
`createVariant`, WP-C08) sigue siendo responsabilidad del código, no de RLS.

Después: esquema Zod en `packages/contracts`, mapper de facetas en `packages/domain/src/catalog/facets.ts`, formulario en el admin. **Ninguna tabla existente se modifica.**

> `ALTER TYPE ... ADD VALUE` no puede correr dentro de un bloque de transacción en algunas versiones. Va en su propia migración, separada de la creación de la tabla.

---

## 9. Migraciones

**Política expand/contract**, siempre:

| Paso                                              | Deploy  |
| ------------------------------------------------- | ------- |
| Agregar la columna nueva (nullable o con default) | N       |
| Escribir en ambas columnas                        | N       |
| Migrar los datos existentes                       | N o N+1 |
| Dejar de leer la vieja                            | N+1     |
| Eliminar la vieja                                 | N+2     |

Nunca `DROP COLUMN` en el mismo deploy que deja de usarla. Nunca editar una migración ya aplicada: siempre una nueva.

Después de cada migración: `pnpm db:pull` para regenerar `schema.prisma`, y commitear el resultado en el mismo PR.
