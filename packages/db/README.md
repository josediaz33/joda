# `packages/db` — esquema JODA Parfums v4

Esquema completo del ecosistema ERP + E-commerce, **ejecutado y verificado contra PostgreSQL 16**. No es una propuesta: es DDL que corre.

## Qué hay acá

```
migrations/    10 archivos, aplicados en orden. SQL-first.
seed/          permisos, roles, plan de cuentas, reglas de posteo
tests/         flujo de negocio real + suite de invariantes
prisma/        schema.prisma (se genera por introspección, ver abajo)
```

## Verificación

Todo lo que sigue se ejecutó, no se estimó:

| | |
|---|---|
| Tablas | 61 |
| Vistas | 6 |
| Enums / dominios | 28 / 5 |
| CHECK constraints | 104 |
| Claves foráneas | 138 |
| Índices | 128 |
| Triggers (no internos) | 25 |
| Tablas con RLS activo | 36 |
| Políticas RLS | 45 |
| **Pruebas de invariantes** | **18 / 18 pasan** |

El flujo de negocio de `tests/smoke_business_flow.sql` corre de punta a punta: compra en USD con flete → recepción → apertura de frasco → fraccionamiento con merma real → venta → asiento contable. Cierra con deriva cero entre el ledger y la proyección de saldos.

## Cómo correrlo

```bash
createdb joda
for f in migrations/0*.sql seed/0001_seed_base.sql; do
  psql -d joda -v ON_ERROR_STOP=1 -f "$f"
done

# opcional: verificar
psql -d joda -f tests/smoke_business_flow.sql
psql -d joda -f tests/invariants.sql
```

## Por qué SQL-first y no `prisma migrate`

Prisma no puede expresar buena parte de lo que sostiene este esquema: constraint triggers diferidos (el cuadre de asientos, el cuadre de capas de costo), políticas RLS, dominios, columnas generadas, `CHECK` compuestos, FK compuestas para la coherencia de verticales. Si el esquema lo define Prisma, todo eso desaparece o queda en `migration.sql` editado a mano, que es lo peor de ambos mundos.

El flujo correcto es el inverso: **el SQL es la fuente de verdad, Prisma es el cliente tipado**.

```bash
export DATABASE_URL="postgresql://.../joda?schema=app"
npx prisma db pull      # introspecciona y regenera schema.prisma
npx prisma generate     # cliente tipado para apps/api
```

`prisma db pull` se corre después de cada migración y el `schema.prisma` resultante se commitea. Prisma no gestiona el ciclo de migraciones, lo refleja.

---

## Hallazgos de la implementación

Tres cosas que no aparecieron en ninguno de los cuatro documentos de arquitectura y que solo salieron al ejecutar el esquema.

### 1. Un lote no puede cambiar de unidad de medida

Un frasco sellado es 1 unidad. Un frasco abierto es 125 mililitros. **No es el mismo lote**: no se pueden restar mililitros de un lote medido en unidades sin mezclar peras con ml, y cualquier atajo ahí destruye la trazabilidad del Kardex.

La apertura de un frasco es una **conversión**, no un cambio de estado:

```
lote sellado (unit)          lote granel (ml)
  transfer_out −1  ────────►   transfer_in +125
  status = open_for_decant     parent_lot_id = lote sellado
  1.496.500 Gs.                11.972 Gs./ml
```

Esto obligó a agregar `variant_type = 'bulk'` y `inventory_lots.parent_lot_id`. Sin esa conversión explícita, el modelo de decants no cierra.

### 2. `ON CONFLICT DO UPDATE` no protege contra un `CHECK`

La proyección de saldos estaba escrita así:

```sql
INSERT INTO inventory_balances (lot_id, ..., on_hand) VALUES (NEW.lot_id, ..., NEW.qty)
ON CONFLICT (lot_id) DO UPDATE SET on_hand = inventory_balances.on_hand + EXCLUDED.on_hand;
```

Parece correcto y falla en la primera salida de stock. PostgreSQL evalúa los `CHECK` de la fila propuesta **antes** de detectar el conflicto por índice único, así que `on_hand = -10` viola `balance_non_negative` y aborta antes de que el `ON CONFLICT` llegue a sumar.

La corrección: la fila de saldo nace en cero junto con el lote (trigger sobre `inventory_lots`), y la proyección es siempre un `UPDATE` puro. Beneficio adicional no buscado: desaparece la carrera entre dos movimientos concurrentes creando la misma fila de saldo.

### 3. La merma estimada estaba 75% por debajo de la real

En el flujo de prueba, con `waste_factor = 2%` sobre 10 ml la merma esperada es 0,200 ml. La merma real registrada fue 0,350 ml. La vista `v_decant_yield` lo expone como `actual_over_expected = 1.75`.

Con números reales de un frasco de nicho, esa diferencia son unos 1.800 Gs. por decant. Sobre cientos de decants al año es plata que hoy no aparece en ningún reporte. Por eso la orden de fraccionamiento separa merma esperada de merma real: el porcentaje sirve para reservar stock, el registro real sirve para saber cuánto cuesta de verdad.

---

## Decisiones no obvias del esquema

**El ledger es inmutable, y ni la API puede tocarlo.** `REVOKE UPDATE, DELETE ... FROM joda_api`, más triggers que rechazan la operación. La corrección de un error es un movimiento de ajuste, no una edición.

**La API se conecta con un rol `NOBYPASSRLS`.** Si la API usara la `service_role` de Supabase o el owner de las tablas, RLS no se evaluaría y sería decorativo. `service_role` queda solo para migraciones y ETL, ejecutados desde CI. Verificado: `joda_api` sin `tenant_id` en contexto ve cero filas, con otro tenant ve cero filas, y su `UPDATE` sobre el ledger recibe `permission denied`.

**El IVA se calcula sobre precio con impuesto incluido**, que es el régimen paraguayo: 10% → `total/11`, 5% → `total/21`. La función `app.vat_from_gross()` es el único lugar donde vive esa regla, y `app.round_pyg()` el único donde vive el redondeo. Duplicar cualquiera de las dos es garantía de descuadre en el XML de SIFEN.

**Los asientos se derivan, no se cargan.** `posting_rules` guarda plantillas declarativas por evento de negocio, y nacen **apagadas**. Mientras una regla esté apagada, el evento cae en `unposted_events`: visible y reprocesable, nunca perdido en silencio. Un ERP que exige saber contabilidad para operar es un ERP que no se usa.

**La seña es pasivo.** `customer_deposits` acredita `2.1.02.001 Señas de clientes`, no una cuenta de ingreso. El `CHECK` impide aplicar o devolver más de lo recibido.

**El carrito no reserva stock.** La reserva nace al iniciar el checkout, con TTL según medio de pago. Reservar al agregar al carrito permite que cualquiera bloquee inventario de piezas únicas abriendo pestañas.

**El PAN nunca entra a la base.** `payments` guarda `card_last4` y `card_brand`, que no son datos de tarjeta bajo PCI. El checkout es hospedado. La diferencia entre SAQ A y SAQ D es la diferencia entre un formulario y una auditoría anual.

**Los webhooks son idempotentes por esquema.** `UNIQUE (provider, external_event_id)` en `payment_events`. Bancard reintenta; sin esa restricción, un reintento confirma dos veces la misma venta.

**Agregar una vertical es una migración, no una reescritura.** `ALTER TYPE product_kind ADD VALUE 'x'` + `CREATE TABLE x_details` con la FK compuesta `(product_id, kind)`. Verificado: intentar cargar `perfume_details` sobre un producto `watch` es rechazado por la base.

---

## Pendiente antes de producción

1. **Confirmar el grupo SIFEN del RUC.** Condiciona si `fiscal_documents` se activa en el MVP o después.
2. **Validar el plan de cuentas con el contador.** El de `seed/` es una base razonable para retail paraguayo, no una verdad revelada.
3. **Definir el criterio de prorrateo de flete por defecto** (`by_value` está puesto como default) y documentarlo en un ADR.
4. **Contratar PITR y hacer un simulacro de restauración** a un proyecto nuevo, antes de migrar datos reales. Un backup que nunca se restauró es una creencia.
5. **Job nocturno sobre `v_balance_drift`.** Si devuelve filas, algo se escribió por fuera del flujo.
