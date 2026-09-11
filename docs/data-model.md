# Modelo de Datos

Referencia del esquema. La verdad ejecutable está en `packages/db/migrations/`; este documento explica **por qué** está así.

Estado: validado contra PostgreSQL 16 — 61 tablas, 104 `CHECK`, 138 claves foráneas, 128 índices, 36 tablas con RLS, 18/18 invariantes verificados.

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
                          └──── parent_lot_id (autoreferencia: granel → sellado)

product_variants ──< stock_reservations   (separadas del ledger)

inventory_lots ──< decant_work_orders >── product_variants
                          │
                          └── sale_order_id
```

**La autoreferencia `parent_lot_id` es lo que modela la apertura de frasco.** Un lote de granel apunta al lote sellado del que salió, con el costo heredado.

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

Los 18 verificados en `packages/db/tests/invariants.sql`. **Agregar un invariante nuevo obliga a agregar su test.**

| #   | Invariante                                        | Mecanismo                                                              |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | El libro de inventario no se edita                | Trigger `BEFORE UPDATE`                                                |
| 2   | El libro de inventario no se borra                | Trigger `BEFORE DELETE` + `REVOKE` a `joda_api`                        |
| 3   | El saldo de un lote nunca es negativo             | `CHECK (on_hand >= 0)` en la proyección                                |
| 4   | El signo del movimiento coincide con su tipo      | `CHECK` compuesto por `movement_type`                                  |
| 5   | La unidad del movimiento coincide con la del lote | Trigger `BEFORE INSERT`                                                |
| 6   | Un frasco abierto no se vende sellado             | Trigger `BEFORE INSERT`                                                |
| 7   | Todo asiento cuadra                               | Constraint trigger **diferida**                                        |
| 8   | Una línea contable es débito o crédito, no ambos  | `CHECK`                                                                |
| 9   | Un asiento contabilizado no se modifica           | Trigger que consulta el estado del asiento                             |
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

Toda tabla con `tenant_id` tiene RLS habilitado **y forzado**, con una política de aislamiento generada en bucle:

```sql
ALTER TABLE app.<tabla> ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.<tabla> FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.<tabla>
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
```

Encima, políticas de permiso sobre lo sensible: `journal_entries`, `chart_of_accounts`, `customer_deposits`, `sourcing_scenarios`, `suppliers`, `purchase_orders`, `inventory_lots`.

**`FORCE` es necesario** porque sin él el dueño de la tabla eludiría las políticas. Y la API se conecta con `joda_api`, creado `NOBYPASSRLS`: si usara `service_role`, nada de esto se evaluaría.

---

## 8. Cómo agregar una vertical de producto

Ejemplo con "Accesorios" ya presente; para una nueva:

```sql
-- 1. Extender el enum
ALTER TYPE app.product_kind ADD VALUE 'candle';

-- 2. Tabla de detalles con la FK compuesta
CREATE TABLE app.candle_details (
  product_id  uuid PRIMARY KEY REFERENCES app.products(id) ON DELETE CASCADE,
  kind        app.product_kind NOT NULL DEFAULT 'candle' CHECK (kind = 'candle'),
  wax_type    text NOT NULL,
  burn_hours  integer CHECK (burn_hours > 0),
  FOREIGN KEY (product_id, kind) REFERENCES app.products(id, kind)
);

-- 3. RLS
ALTER TABLE app.candle_details ENABLE ROW LEVEL SECURITY;
-- (no lleva tenant_id: hereda el aislamiento por la FK a products)
```

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
