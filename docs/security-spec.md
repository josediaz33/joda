# Especificación de Seguridad

Implementa ADR-015 (identidades separadas) y ADR-016 (RBAC en tres capas). Referencia obligatoria antes de tocar autenticación, permisos o políticas de base.

---

## 1. Modelo de identidad

Dos poblaciones, dos tablas, dos superficies.

|                   | Cliente              | Personal                              |
| ----------------- | -------------------- | ------------------------------------- |
| Tabla             | `customers`          | `staff_users`                         |
| Dominio           | `jodaparfums.com`    | `admin.jodaparfums.com`               |
| Cookie            | `__Host-joda_c`      | `__Host-joda_a` (scope al subdominio) |
| Audiencia         | `customer`           | `staff`                               |
| Segundo factor    | Opcional             | **Obligatorio**                       |
| Sesión            | 30 días              | 8 h                                   |
| Token de refresco | 90 días, rotativo    | 8 h, rotativo con detección de reúso  |
| Permisos          | Ninguno del catálogo | Según roles asignados                 |

**Que un cliente no pueda tener un rol de personal es un invariante de esquema:** no existe fila donde ponérselo. No es una condición que haya que recordar validar.

La separación de cookies importa: un XSS en el storefront no alcanza la sesión del admin, porque la cookie de personal está limitada al subdominio.

---

## 2. Catálogo de permisos

Forma: `recurso.subrecurso:acción`.

| Código                          | Descripción                           |
| ------------------------------- | ------------------------------------- |
| `catalog.product:read`          | Ver productos y variantes             |
| `catalog.product:write`         | Crear y editar productos              |
| `catalog.product:publish`       | Publicar al storefront                |
| `inventory.stock:read`          | Ver stock, lotes **y costos de lote** |
| `inventory.stock:adjust`        | Ajustar inventario                    |
| `inventory.decant:execute`      | Ejecutar órdenes de fraccionamiento   |
| `sales.order:read`              | Ver pedidos                           |
| `sales.order:write`             | Crear y confirmar pedidos             |
| `sales.order:refund`            | Anular y reembolsar                   |
| `accounting.cashbox:read`       | Ver caja y arqueos                    |
| `accounting.cashbox:write`      | Registrar movimientos de caja         |
| `accounting.deposit:read`       | Ver señas                             |
| `accounting.deposit:write`      | Registrar y aplicar señas             |
| `accounting.journal:read`       | Ver asientos y balances               |
| `accounting.journal:write`      | Contabilizar asientos                 |
| `market.supplier:read`          | Ver proveedores                       |
| `market.supplier:write`         | Crear y editar proveedores            |
| `market.purchase_order:read`    | Ver órdenes de compra                 |
| `market.purchase_order:write`   | Crear órdenes de compra               |
| `market.purchase_order:approve` | Aprobar órdenes de compra             |
| `market.purchase_order:receive` | Registrar recepciones                 |
| `market.sourcing:read`          | Ver escenarios de sourcing            |
| `market.sourcing:write`         | Crear escenarios                      |
| `market.channel:write`          | Gestionar canales y publicaciones     |
| `fiscal.document:read`          | Ver documentos fiscales               |
| `fiscal.document:issue`         | Emitir documentos fiscales            |
| `settings.user:read`            | Ver usuarios y roles                  |
| `settings.user:write`           | Gestionar usuarios y roles            |

**Permiso decidido, todavía no sembrado: `inventory.decant:plan`** («Planificar órdenes de fraccionamiento»; decisión de José, 2026-10-07 y 2026-10-08; lo agrega WP-B18, de la serie B, antes de WP-C19). No está en la tabla ni en la matriz porque no existe: la tabla tiene los 28 códigos de `permissions.ts` y del seed, y los tres tienen que decir lo mismo. Cuando WP-B18 lo agregue entra en los tres a la vez. Lo reciben el `vendedor` y el `deposito` por seed; `owner` lo recibe porque el seed le da todos los permisos, y `manager` porque recibe todos menos `settings.user:write`. **`inventory.decant.plan` exige exactamente este permiso**, sin lógica de «cualquiera de los dos»: el `deposito`, que hoy planifica por HTTP porque tiene `inventory.decant:execute`, no pierde la planificación porque lo recibe. Diseño en §3.1, «Planificar un decant sin leer lotes».

### 2.1 Matriz de roles

| Permiso                    | owner | manager | vendedor | deposito |
| -------------------------- | :---: | :-----: | :------: | :------: |
| `catalog.product:read`     |   ✓   |    ✓    |    ✓     |    ✓     |
| `catalog.product:write`    |   ✓   |    ✓    |          |          |
| `catalog.product:publish`  |   ✓   |    ✓    |          |          |
| `inventory.stock:read`     |   ✓   |    ✓    |          |    ✓     |
| `inventory.stock:adjust`   |   ✓   |    ✓    |          |    ✓     |
| `inventory.decant:execute` |   ✓   |    ✓    |          |    ✓     |
| `sales.order:read`         |   ✓   |    ✓    |    ✓     |          |
| `sales.order:write`        |   ✓   |    ✓    |    ✓     |          |
| `sales.order:refund`       |   ✓   |    ✓    |          |          |
| `accounting.cashbox:read`  |   ✓   |    ✓    |          |          |
| `accounting.cashbox:write` |   ✓   |    ✓    |          |          |
| `accounting.deposit:read`  |   ✓   |    ✓    |    ✓     |          |
| `accounting.deposit:write` |   ✓   |    ✓    |    ✓     |          |
| `accounting.journal:*`     |   ✓   |    ✓    |          |          |
| `market.*`                 |   ✓   |    ✓    |          | receive  |
| `fiscal.document:read`     |   ✓   |    ✓    |          |          |
| `fiscal.document:issue`    |   ✓   |    ✓    |    ✓     |          |
| `settings.user:read`       |   ✓   |    ✓    |          |          |
| `settings.user:write`      |   ✓   |         |          |          |

**Tres decisiones deliberadas:**

- **`vendedor` no ve caja ni costos.** Que alguien cargue una venta no implica que vea el flujo financiero del negocio ni lo que cuesta cada frasco. Sí maneja señas, porque es parte de vender: las registra y las aplica al vender, y por eso tiene `accounting.deposit:write` **y** `accounting.deposit:read`. Con RLS, escribir una seña exige poder leerla (§3.1, "La trampa de la lectura"). `accounting.cashbox:read` sigue fuera de su alcance. **Lee todas las señas del tenant, no solo las de su cliente:** la base filtra por tenant, no por vendedor. Decisión aceptada (2026-10-01): acotarlo por cliente no se justifica en un negocio de este tamaño.
- **`deposito` no ve precios de compra.** Mueve mercadería. `inventory.stock:read` incluye costos de lote y del ledger (los movimientos y sus capas de costo, desde 0037), así que si más adelante hace falta un depósito sin acceso a costos, se separa en `inventory.stock:read` e `inventory.cost:read`.
- **`vendedor` planifica decants sin leer lotes.** Al vender un decant tiene que poder planificar la orden (WP-C19), y para eso hace falta ver qué granel hay. Darle `inventory.stock:read` está descartado porque expone costos de lote; tendrá `inventory.decant:plan` (como el `deposito`) y los lotes candidatos le llegan por una función acotada que no devuelve costos (§3.1, «Planificar un decant sin leer lotes»).

**`catalog.product:publish` cubre más que el producto.** Es el permiso de cualquier cambio que decide qué ve el visitante: publicar y despublicar, mostrar u ocultar una variante, y mostrar u ocultar una categoría (WP-C08k, implementado). Volver a publicar un producto archivado que se reactivó también (WP-C08q, decidido, pendiente de implementación). El `vendedor` y el `deposito` no lo tienen; ver §3.3 por cómo se comprueba cuando el procedimiento solo declara `write`.

---

## 3. Las tres capas

| Capa               | Dónde      | Rol                                                                   |
| ------------------ | ---------- | --------------------------------------------------------------------- |
| **1 — RLS**        | PostgreSQL | Aislamiento por tenant + permisos sobre lo sensible. Deny-by-default. |
| **2 — Middleware** | API        | `requirePermission()` en cada procedimiento. **Defensa principal.**   |
| **3 — Servicio**   | API        | Reglas dependientes del recurso concreto.                             |
| _Guardas de React_ | Frontend   | **Experiencia de usuario, no seguridad.**                             |

### 3.1 Capa 1 — RLS

Toda tabla con `tenant_id` lleva RLS habilitado **y forzado**:

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

**`tenant_isolation` es RESTRICTIVE** (WP-B10): se combina con AND contra toda otra política. Si fuera permisiva (el default de Postgres), se combinaría con OR contra las de permiso de abajo, y tener el permiso alcanzaría para leer filas de cualquier tenant; ese era el defecto que corrigió B10. Detalle del patrón, incluida qué tablas llevan `tenant_access` y para qué comandos, en `docs/data-model.md` §7.

Encima, políticas de permiso sobre lo sensible:

```sql
CREATE POLICY accounting_read ON app.journal_entries
  FOR SELECT USING (app.has_permission('accounting.journal:read'));

CREATE POLICY lots_read ON app.inventory_lots
  FOR SELECT USING (app.has_permission('inventory.stock:read'));

CREATE POLICY movements_read ON app.inventory_movements
  FOR SELECT USING (app.has_permission('inventory.stock:read'));
```

#### Escritura sobre lo sensible (WP-B11, `0030_write_permissions_sensitive_tables.sql`)

Leer exigía un permiso desde 0010; escribir solo exigía tenant. Desde 0030, en `suppliers`, `purchase_orders`, `inventory_lots`, `chart_of_accounts` y `customer_deposits`, escribir exige el permiso de escritura, una política por comando. Combinado con `tenant_isolation` (RESTRICTIVE), el resultado es tenant **Y** permiso:

| Tabla               | INSERT                                                                                                       | UPDATE                                                 | DELETE                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------- |
| `suppliers`         | `market.supplier:write`                                                                                      | `market.supplier:write`                                | nadie (se desactiva con `is_active`)                 |
| `purchase_orders`   | `market.purchase_order:write`                                                                                | `market.purchase_order:write`, `:approve` o `:receive` | `market.purchase_order:write`, y **solo en `draft`** |
| `inventory_lots`    | `market.purchase_order:receive`, `inventory.decant:execute`, `sales.order:refund` o `inventory.stock:adjust` | los mismos cuatro                                      | nadie (historial de costo; se corrige con un ajuste) |
| `chart_of_accounts` | `accounting.journal:write`                                                                                   | `accounting.journal:write`                             | nadie (se desactiva con `is_active`)                 |
| `customer_deposits` | `accounting.deposit:write`                                                                                   | `accounting.deposit:write`                             | nadie (se devuelve o se aplica, nunca se borra)      |

Los cuatro permisos de los lotes son el mapeo que aprobó José el 2026-09-25: recepción de compra, apertura de frasco y decant por anticipado, devolución a cuarentena, y ajuste o saldo de apertura.

**Escenarios de sourcing y sus líneas (WP-B11b, `0032_write_permissions_sourcing_scenarios.sql`).** `sourcing_scenarios` quedó afuera de las cinco: el INSERT exigía `market.sourcing:write` desde 0010 (política `sourcing_write`) y UPDATE y DELETE solo exigían tenant. Su tabla hija, `sourcing_scenario_lines`, no exigía permiso de nada, ni para leer ni para escribir: cualquier staff, vendedor incluido, leía y editaba precios de proveedor, FX asumido y margen proyectado, y §2.1 dice que el vendedor no ve costos. Desde 0032, en las dos tablas, leer exige `market.sourcing:read` y INSERT, UPDATE y DELETE exigen `market.sourcing:write`, una política por comando; la trampa de la lectura de abajo vale igual y el invariante 94 la cubre. **El DELETE sí existe**, a diferencia de las cinco: un escenario es una simulación, no historial de costo ni plata recibida, y no tiene estado con el que desactivarlo. Borrarlo borra sus líneas por la cascada (que no evalúa RLS), y como exige el mismo permiso que borrarlas no abre nada. Los invariantes 91 a 94 verifican las dos tablas, y el 91 verifica además que la lectura de las líneas pida el permiso.

**La base impone el piso, no la operación.** La capa 1 no sabe cuál de las operaciones está haciendo quien escribe: en `inventory_lots` acepta cualquiera de los cuatro permisos, y en el UPDATE de `purchase_orders` la unión de los tres **sobre la fila entera**. Qué transición puede hacer cada permiso (aprobar, recibir, cancelar) lo imponen la capa 2 (`requirePermission`) y `packages/domain`, no la base. Un DELETE sin política permisiva no da error: afecta cero filas.

**Una orden enviada no se borra, y lo sostiene un guarda.** La política de DELETE de órdenes lee `status = 'draft'` como premisa: borrador significa "nunca enviada". La de UPDATE no mira el estado, así que sin más un rol con `:write` y `:read` devolvía una orden a `draft` con un UPDATE y la borraba en una segunda transacción. Lo impone `trg_po_no_return_to_draft` (`0031_purchase_order_no_return_to_draft.sql`): se entra a `draft` o a `pending_approval`, los dos estados previos a la aprobación, solo desde esos mismos dos. Cubre los dos porque `sent → pending_approval → draft → DELETE` era un rodeo de tres pasos. Es lo que permite la máquina de A08 (una orden devuelta a corregir antes de aprobarse), más las identidades `draft → draft` y `pending_approval → pending_approval`, así que la base no agrega ninguna arista entre estados distintos. De `approved` en adelante rechaza (`23514`), también para un `UPDATE` sin `WHERE` y para el depósito, que no lee órdenes. El criterio es ADR-026: la base impone la irreversibilidad de un estado cuando volver atrás desarmaría otro invariante de la base, y acá desarmaría la política de DELETE. Solo guarda la **entrada** a los estados previos a la aprobación: la matriz de transiciones de la orden y sus terminales (`received`, `cancelled`) siguen en el dominio, aunque la guarda sí les impide volver a esos dos estados. Lee solo `OLD` y `NEW`, falla cerrado por lista blanca (un estado de origen que no sea `draft` o `pending_approval` rechaza, también uno que se agregue al enum) y no es `SECURITY DEFINER`.

**La trampa de la lectura.** Con RLS, `INSERT ... RETURNING` y los `UPDATE` o `DELETE` que **leen columnas** (con `WHERE` o `RETURNING`) evalúan también la política de **lectura** de la tabla. Un rol con el permiso de escribir y sin el de leer no recibe un error que lo explique: el `INSERT ... RETURNING` que emite Prisma se rechaza con `42501`, y el `UPDATE ... WHERE` o `DELETE ... WHERE` afecta cero filas. Qué responde la API depende de cada ruta, según haya leído la fila antes **en la misma petición**: si la política de lectura se la ocultó, 404; si la leyó y es la escritura la que no la alcanza, 403; y una ruta que escribe sin leer antes recibe `P2025` de Prisma y responde 404 (`docs/api-conventions.md` §4.4). El borrado de una orden de compra es del segundo grupo (WP-C14): `removeOrder` lee y bloquea la orden, comprueba que el `DELETE` afectó exactamente una fila antes de auditar y, si afectó cero, responde 403 `FORBIDDEN_INSUFFICIENT_PERMISSION`, no 404: quien ya leyó la orden sabe que existe, así que no hay existencia que ocultar. La transición de estado de una orden (`transitionOrder`) responde igual. Un `UPDATE` sin `WHERE` ni `RETURNING` (o con `WHERE true`) no lee nada y solo necesita el permiso de escritura: el depósito, que tiene `:receive` y no `:read`, no edita una orden por id pero sí podría con un `UPDATE` sin `WHERE`, porque `:receive` habilita la fila entera. Consecuencias:

- **En los roles sembrados, todo permiso de escritura de estas tablas viene con el de lectura de la misma tabla.** El invariante 94 de `packages/db/tests/invariants.sql` falla si no, nombrando rol y tabla. Un permiso de escritura nuevo entra en ese invariante en el mismo PR.
- **Una excepción registrada:** `deposito` tiene `market.purchase_order:receive` y no `market.purchase_order:read`, así que no ve la orden que recibe. No se resuelve en la capa 1: WP-C15 define que el depósito carga la recepción en borrador (`goods_receipts`, con las cantidades y sin precios) y la contabiliza quien lee la orden.
- **Un rol personalizado** que combine un permiso de escritura con uno de lectura distinto de su par queda en ese mismo hueco. La base no lo impide; se impide al administrar roles: WP-C24 exige que asignar un permiso de escritura sobre estas cinco tablas asigne también el de lectura de su par.

**Nunca `FOR ALL` en una política de permiso.** Un `FOR ALL` permisivo también cubre `SELECT`: quien puede escribir leería la tabla entera aunque no tenga el permiso de leer. El invariante 92 lo verifica.

**Solo audiencia `staff`.** `has_permission` exige una sesión de staff viva (WP-B13), así que un contexto `system` o `customer` no escribe en estas cinco tablas. Hoy ningún código lo necesita; el día que un webhook de pago tenga que registrar una seña, necesita una política propia o una función `SECURITY DEFINER` acotada, no un permiso prestado. Ese camino no está definido todavía: queda anotado en WP-C20 (señas) y WP-G13 (webhooks de pago).

#### Roles, permisos de rol y asignaciones (WP-B11c, `0033_write_permissions_roles.sql`)

Quien escribe estas tablas se da permisos: si bastara con el tenant, B11 entero se anularía con un `INSERT` en `role_permissions`. Desde 0033, en `roles`, `role_permissions` y `staff_user_roles`, INSERT, UPDATE y DELETE exigen `settings.user:write`, una política por comando.

| Tabla              | INSERT                                            | UPDATE                  | DELETE                |
| ------------------ | ------------------------------------------------- | ----------------------- | --------------------- |
| `roles`            | `settings.user:write`, y la fila no es de sistema | `settings.user:write`   | `settings.user:write` |
| `role_permissions` | `settings.user:write`, y el rol no es de sistema  | ídem (origen y destino) | ídem                  |
| `staff_user_roles` | `settings.user:write`                             | `settings.user:write`   | `settings.user:write` |

**La lectura no cambia: sigue por tenant.** La API lee `role_permissions` y `staff_user_roles` como `joda_api`, bajo RLS, para resolver los permisos de cada sesión (`getGrantedPermissionCodes`), y el vendedor no tiene `settings.user:read`. Exigirlo para leer rompería el login de todos. Por eso la trampa de la lectura de arriba no aplica: quien escribe estas tablas siempre puede leerlas. El invariante 104 verifica las dos mitades: la escritura exige el permiso, la lectura no.

**Los roles de sistema (`is_system`) no se borran ni se renombran, por nadie.** `trg_system_roles_guard` rechaza (`23514`) borrar un rol de sistema, cambiarle el `name` o el `code`, y cambiar la marca `is_system` en cualquier sentido; la política de INSERT exige `NOT is_system`. Es un trigger y no una política porque «por nadie» incluye al superusuario y a `service_role`, que eluden RLS. Sin él, quien pudiera borrar roles borraría el de dueño. Lee solo `OLD` y `NEW` y no es `SECURITY DEFINER` (invariante 29). Detalle en `docs/data-model.md` §4.7.

**Los permisos de un rol de sistema no se modifican desde la API.** `role_permissions` de un rol `is_system` no admite INSERT, UPDATE ni DELETE por `joda_api`: las tres políticas exigen, además del permiso, que el rol no sea de sistema (el UPDATE, en la fila de origen y en la de destino, para que no se mueva un permiso hacia uno). Esos permisos son la matriz de §2.1 y se cambian por el seed, que corre como superusuario. Sin esto, el dueño se vaciaba su propio rol con un `DELETE` y quedaba tan bloqueado como si lo hubiera borrado. Es solo RLS: el ETL (`service_role`) y el seed la eluden. El invariante 113 lo verifica por el texto de las políticas y `write_permissions.test.ts`, por comportamiento.

**El catálogo `permissions` lo carga el seed, no la API.** `joda_api` no tiene INSERT, UPDATE ni DELETE sobre él (`REVOKE` de 0033); conserva SELECT. Como no tiene RLS ni `tenant_id` (es global, 0014), el único freno era el privilegio: un `DELETE` de un vendedor del tenant A borraba por cascada las `role_permissions` de todos los tenants. El invariante 111 lo verifica, incluidos los privilegios de columna y los heredados de PUBLIC.

**Lo que el WP no cierra.** La asignación del rol de dueño: quien tiene `settings.user:write` puede borrar la fila de `staff_user_roles` del dueño. El rol está protegido como fila y como matriz, pero no su asignación. Es la regla del último dueño —nadie se quita el rol de dueño si es el único que lo tiene en el tenant—, criterio de WP-C24 (`docs/backlog.md`).

**`settings.user:write` equivale a ser dueño.** La inmutabilidad de los roles de sistema protege la matriz del seed, no limita ese permiso: quien lo tiene sin ser dueño puede asignarse el rol de dueño en `staff_user_roles`, o fabricar un rol propio con todos los permisos y asignárselo. La revisión cruzada de B11b/c/d (2026-10-07) lo probó como `joda_api`: pasó de no poder contabilizar a poder. No es un hueco nuevo (arriba ya se dice que quien escribe estas tablas se da permisos), pero conviene dejarlo escrito: **otorgar `settings.user:write` es otorgar todos los permisos**, y la regla del último dueño (C24) no lo cubre. Si el negocio quiere separar «administrar usuarios» de «ser dueño» (por ejemplo, que solo un dueño asigne el rol de dueño), es una decisión nueva y con su WP.

#### El ledger, las líneas de órdenes, las recepciones y el borrado de pedidos (WP-B11d, `0034_write_permissions_children_ledger.sql`)

B11 puso permiso en las cabeceras y dejó sin él a lo que cuelga de ellas y al ledger: como vendedor funcionaban un `UPDATE purchase_order_lines SET unit_price_minor = 1`, un `INSERT` de tipo `adjustment` de +5 sobre un lote y borrar una venta (que desengancha la seña); y las líneas de una orden se leían sin permiso, precios de compra incluidos. Desde 0034, una política por comando (nunca `FOR ALL`). El SELECT sigue por tenant salvo en `purchase_order_lines`, que exige `market.purchase_order:read`.

| Tabla                  | SELECT                       | INSERT                                                         | UPDATE                                                 | DELETE                                                         |
| ---------------------- | ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| `inventory_movements`  | `inventory.stock:read`       | según `movement_type`, ver abajo                               | nadie (ledger append-only)                             | nadie (ledger append-only)                                     |
| `purchase_order_lines` | `market.purchase_order:read` | `market.purchase_order:write`, y la orden padre en **`draft`** | `market.purchase_order:write`, `:approve` o `:receive` | `market.purchase_order:write`, y la orden padre en **`draft`** |
| `goods_receipts`       | tenant                       | `market.purchase_order:receive`                                | `market.purchase_order:receive`                        | nadie (se cancela con su estado)                               |
| `goods_receipt_lines`  | tenant                       | `market.purchase_order:receive`                                | `market.purchase_order:receive`                        | nadie                                                          |
| `sale_orders`          | tenant                       | solo tenant (ver «Lo que el WP no cierra»)                     | solo tenant                                            | `sales.order:write`, y **solo en `draft`**                     |

**El permiso del movimiento depende de su `movement_type`**, que es lo único que distingue qué operación hace quien escribe:

| `movement_type`                                                          | Permiso                         |
| ------------------------------------------------------------------------ | ------------------------------- |
| `sale`                                                                   | `sales.order:write`             |
| `adjustment`                                                             | `inventory.stock:adjust`        |
| `decant_consumption`, `decant_yield`, `bom_consumption`, `waste`         | `inventory.decant:execute`      |
| `transfer_in`, `transfer_out`                                            | `inventory.decant:execute`      |
| `purchase_receipt`                                                       | `market.purchase_order:receive` |
| `return_in` (devolución de un cliente)                                   | `sales.order:refund`            |
| `return_out` (devolución a un proveedor: es compras y genera un crédito) | `market.purchase_order:write`   |

Decisiones de José (2026-10-01): `return_out` va con compras, no con ventas; y los `transfer_*` con `inventory.decant:execute`. Como no se distinguen por `movement_type` sino por `reference_type` (texto libre), un `CHECK` impone que en un `transfer_*` valga solo `lot_separation` o `lot_opening` y que no sea NULL. El día que exista otro tipo de transferencia, se agrega a propósito; el CHECK aplica también al ETL (`service_role` elude RLS, no los CHECK). Un `movement_type` nuevo que no figure en la política se rechaza hasta mapearlo, y el invariante 114 falla para obligar a decidirlo.

**Las líneas de una orden se agregan y se quitan solo con la orden en `draft`** (decisión de José, 2026-10-02, a partir de la revisión cruzada). Es la misma premisa que la política de DELETE de la orden («nunca enviada», sostenida por `trg_po_no_return_to_draft`): sin ella, quien tenía `:write` borraba las líneas de una orden enviada y la dejaba vacía. El UPDATE queda abierto en cualquier estado porque la recepción actualiza `qty_received`; si el precio o la cantidad pedida pueden cambiar después de enviar, lo decide WP-C15. El `EXISTS` lee la orden bajo RLS, así que quien escribe líneas tiene que poder leer la orden.

**Un pedido en `draft` se borra; uno confirmado, no.** La política de DELETE lee `draft` como «nunca confirmada», y la sostiene `trg_so_no_return_to_draft` (se entra a `draft` solo desde `draft`; ADR-026, `docs/data-model.md` §4.6, guarda 4): sin ella, un `UPDATE` a `draft` y un `DELETE` borraban una venta cobrada.

**Una seña enganchada a un pedido impide borrarlo.** `customer_deposits.sale_order_id` pasa de `ON DELETE SET NULL` a `RESTRICT` (decisión de José, 2026-10-02): una seña existe antes del cobro, así que un borrador puede tener una enganchada, y borrarlo la desenganchaba en silencio. Con RESTRICT hay que desvincularla a propósito, y la API traduce el `23503` a un mensaje que lo dice (`CONFLICT_ORDER_HAS_DEPOSIT`, `errorMapper.ts`).

**La trampa de la lectura.** No aplica a las tablas cuyo SELECT es por tenant: ni `INSERT ... RETURNING` ni `UPDATE ... WHERE` dependen de otro permiso. **Sí aplica a `purchase_order_lines`**, cuya lectura exige `market.purchase_order:read`: quien escribe líneas sin poder leerlas recibe 42501 en el `INSERT` (el `EXISTS` lee la orden) y cero filas en un `UPDATE` o `DELETE` con `WHERE`. El invariante 94 la verifica para los roles sembrados, con la excepción registrada del depósito (`:receive` sin `:read`): desde 0034 ya no ve las líneas de la orden que recibe, y cómo recibe sin ver precios es de WP-C15. **Desde 0037 aplica también a `inventory_movements`** (ver «El costo del ledger», abajo): el SELECT del ledger ya no es por tenant.

**Lo que el WP no cierra, cada uno con su destino en `docs/backlog.md`.** (1) INSERT y UPDATE de `sale_orders` y las demás tablas de la venta (`sale_order_lines`, `payments`, ...) siguen solo por tenant, y un contexto `system` (el webhook que confirma un pago) no inserta los movimientos `sale` de esa confirmación, porque `has_permission` exige staff: necesita el camino definido de WP-G13. (2) `movement_cost_allocations`, las capas de costo de cada salida, sigue solo por tenant en INSERT: WP-B11e. (3) La lectura de `goods_receipt_lines` (precio unitario y flete prorrateado) sigue por tenant: WP-C15.

**La condición que hace que esta capa exista de verdad:**

| Rol             | Uso                              | `BYPASSRLS`           |
| --------------- | -------------------------------- | --------------------- |
| `joda_api`      | Runtime de la API                | **No**                |
| `joda_readonly` | Catálogo público                 | **No**                |
| `service_role`  | Migraciones y ETL, solo desde CI | Sí — nunca en runtime |

Si la API usara `service_role` o el dueño de las tablas, RLS **no se evaluaría** y toda la capa sería decorativa. Además, `joda_api` no tiene `UPDATE` ni `DELETE` sobre `inventory_movements`, `movement_cost_allocations`, `audit_log` ni `fiscal_events`.

**Verificado:** conectado como `joda_api`, sin `tenant_id` en contexto → cero filas; con otro tenant → cero filas; `UPDATE` sobre el libro → `permission denied`.

**Provisión de la credencial de runtime (WP-C02).** `apps/api` se conecta exclusivamente con `DATABASE_URL_API` (ver `.env.example`) — nunca con `DATABASE_URL`, que queda reservada a migraciones y ETL (el equivalente local de `service_role`). Sin `DATABASE_URL_API` el proceso no arranca: se valida con Zod al inicio (`apps/api/src/config/env.ts`), sin fallback a ninguna otra variable. Además, antes de aceptar tráfico, `apps/api` corre `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user` (`apps/api/src/db/client.ts`, `assertRlsNotBypassed`) y aborta el arranque si devuelve `true` — la red que atrapa a `DATABASE_URL_API` apuntando por error al owner de las tablas o a un superusuario. La password de desarrollo la fija `packages/db/seed/0002_seed_joda_api_credential.sql`; en producción sale del gestor de secretos.

**Una línea de orden no cambia de orden (`0036_purchase_order_line_no_reparent.sql`, revisión cruzada de B11d).** El INSERT y el DELETE de líneas exigen la orden padre en `draft`, pero la política de UPDATE queda abierta (la recepción actualiza `qty_received`) y no puede comparar `OLD` con `NEW`: un `UPDATE` de `purchase_order_id` mandaba la línea a otra orden y vaciaba una enviada, o le agregaba una. `trg_po_line_no_reparent` lo rechaza para todo rol (`23514`); el detalle está en `docs/data-model.md` §4.6, guarda 5. Invariantes 126 y 127.

**El costo del ledger (`0037_read_permission_ledger_costs.sql`, WP-B11f).** Decisión de José (2026-10-07): el vendedor no obtiene `inventory_movements.total_cost_pyg` por ninguna vía, ni por la API ni leyendo la base. Hasta 0036 el costo de un lote (`inventory_lots`) y el de una línea de OC (`purchase_order_lines`) exigían permiso, pero el ledger y sus capas de costo se leían por tenant: como vendedor, `SELECT total_cost_pyg FROM app.inventory_movements` devolvía el costo de cada movimiento (el de un frasco, 1.496.500, en la base del smoke). **El alcance de B11f es el ledger y sus capas de costo;** las recepciones (`goods_receipts` y `goods_receipt_lines`) quedan pendientes en WP-C15 (ver abajo). Mismo mecanismo que las otras dos, sin inventar otro (con `(SELECT app.has_permission(...))` y no la función suelta: el ledger es la tabla de alto volumen, y suelta se evalúa fila por fila, 3,2 s contra 84 ms con 100.000 movimientos):

| Tabla                       | SELECT                 | INSERT                        | UPDATE y DELETE            |
| --------------------------- | ---------------------- | ----------------------------- | -------------------------- |
| `inventory_movements`       | `inventory.stock:read` | según `movement_type` (0034)  | nadie (ledger append-only) |
| `movement_cost_allocations` | `inventory.stock:read` | solo tenant (permiso en B11e) | nadie (ledger append-only) |

- **Las capas también.** La suma de `movement_cost_allocations.total_cost_pyg` por movimiento es el `total_cost_pyg` del movimiento (trigger de 0009): dejarlas por tenant era el rodeo. Traen además `unit_cost_pyg`, el costo unitario de cada lote consumido.
- **La tabla entera, no la columna.** RLS decide por fila, y `joda_api` es un solo rol para todas las sesiones de la API: un `REVOKE SELECT (total_cost_pyg)` dejaría ciego también a quien debe verlo. Si el vendedor necesita cantidades de un movimiento, se le expone una proyección de la API sin `totalCostPyg`; hoy ningún procedimiento la pide (el kardex, `lot.history` y `serial.history`, exige `inventory.stock:read`).
- **Los disparadores no se ven afectados, pero uno hablaba de más.** Los que leen el ledger o sus capas son `SECURITY DEFINER` desde 0018: la verificación de que las capas cuadran con el movimiento no depende de quién escribe. Su mensaje, en cambio, traía el costo del movimiento (`asignado=X declarado=Y`), y como el INSERT de las capas es solo por tenant y la FK no evalúa RLS, el vendedor lo leía en un movimiento ajeno insertando una capa de 1. Desde 0037 los montos van solo con `inventory.stock:read`; el invariante 131 lo verifica. Queda la igualdad (una capa pasa solo si su total es el del movimiento), que cierra B11e.
- **La trampa de la lectura es real para el vendedor.** Escribe un movimiento `sale` con `sales.order:write` y no puede leerlo, así que su `INSERT … RETURNING` (el que emite el `create` de Prisma) recibe 42501. Lo registra **sin `RETURNING`**, y toma el id para sus capas con `currval(pg_get_serial_sequence('app.inventory_movements', 'id'))` (no `lastval()`: dentro del INSERT de la capa devuelve la identidad de la propia capa). Se descartó dejar que el SELECT admita las filas `sale` de quien puede escribirlas, como sugería la fila de B11f: son las filas que traen el costo de lo que el vendedor vendió. Los otros roles sembrados que escriben movimientos (dueño, encargado, depósito) tienen `inventory.stock:read` y no tienen la trampa; el invariante 129 lo verifica, con la excepción registrada del vendedor, y el 130 que el vendedor siga sin ese permiso.
- **Lo que no cierra, con su destino en `docs/backlog.md`.** (1) WP-C19 hereda la forma de escribir del vendedor (SQL crudo, sin `RETURNING`) y tiene que decidir con qué sesión elige la capa de costo, porque el vendedor tampoco lee los lotes. (2) WP-B11e: una política de INSERT de las capas que consulte `inventory_movements` corre bajo RLS y no ve el movimiento del vendedor; y es el lugar de atar la capa a un movimiento que quien la escribe creó en esa transacción, que cierra la prueba por igualdad. (3) **WP-B11g, decisión de diseño:** el mismo costo vive en columnas que RLS no esconde y que el vendedor lee: `sale_orders.cogs_pyg`, `sale_order_lines.cogs_pyg` y los snapshots de `audit_log`, `idempotency_keys` y `unposted_events`. (4) **La raíz del costo, pendiente en C15 (decisión de José, 2026-10-08):** `goods_receipt_lines` (precio unitario y flete prorrateado) y `goods_receipts` se leen por tenant, y con ellos se reconstruye el costo de una recepción. No se cierran en este PR sino en la parte de DB de WP-C15, con lectura `market.purchase_order:read` o `:receive`; el vendedor no tiene ninguno. Hasta entonces, «el vendedor no obtiene el costo» vale para el ledger y sus capas de costo, no para sus orígenes. (5) **WP-B11h:** `journal_lines` se lee y se escribe por tenant, a diferencia de `journal_entries`; plazo escrito por José: antes de habilitar cualquier regla de posteo (H01) y siempre antes del cutover. (6) El rechazo del disparador sin cifras vale para toda sesión sin `inventory.stock:read`, también el ETL o un `psql` sin contexto de staff: al depurar un descuadre los montos se consultan en el ledger.

#### Planificar un decant sin leer lotes (H1 de WP-C13; decisión de José, 2026-10-07; la implementa WP-B18)

**El problema.** `lots_read` exige `inventory.stock:read`, que incluye los costos de lote (§2). El `vendedor` no lo tiene, así que bajo RLS no ve ningún lote, y planificar un decant al vender (`createPlannedWorkOrder`, que C19 llama dentro de su transacción de confirmación) necesita leer el granel candidato. Sin una salida, el vendedor recibía un `CONFLICT_NO_BULK_AVAILABLE` que decía «abrí un frasco» aunque el granel existía.

**La decisión.** No se afloja `lots_read` ni se le da `inventory.stock:read` al vendedor. Se agrega el permiso `inventory.decant:plan` (§2) y los lotes candidatos se leen por una función `SECURITY DEFINER` acotada. **Este PR no la implementa:** es el alcance de WP-B18 (serie B, antes de C19; `docs/backlog.md`, «Decisiones de José sobre H1, H3 y E07»).

**Qué tiene que cumplir la función:**

- **`search_path` fijo y nombres calificados**: `SET search_path = app, pg_temp` con todo calificado, el patrón de `0017` y `0018`. En una `SECURITY DEFINER`, `pg_temp` se busca primero si no se lo fija.
- **El chequeo de permiso va adentro**: `app.has_permission('inventory.decant:plan')` dentro de la función. Que la API llame antes a `requirePermission` (capa 2) no alcanza: la función es la que le abre a `joda_api` una lectura que la política le cierra, y no puede depender de que quien la llame se acuerde.
- **Falla cerrado.** Sin el permiso, sin sesión de staff o sin tenant en el contexto, rechaza con un error; no devuelve cero filas. Un vacío es indistinguible de «no hay granel», que es el engaño de H1.
- **Filtra por el tenant de la sesión** (`app.current_tenant_id()`): con `SECURITY DEFINER` la función ve las filas de todos los tenants.
- **Devuelve solo `lot_id`, la cantidad disponible y la fecha de apertura.** Ningún costo (`unit_landed_cost`, `unit_cost`), proveedor ni fecha de recepción. Entrega candidatos; elegir cuál usa la orden sigue siendo del dominio (`planDecant`).
- **Se revoca de `PUBLIC` y se concede solo a `joda_api`**, como `find_staff_login_by_email` en `0011`.
- **La dependencia operativa de B09 (`0018`)**: la función lee `inventory_lots` por encima de `lots_read`, así que su dueño tiene que eludir RLS, y la migración lo declara como lo hacen las de `0018`.

**Lo que esta especificación deja abierto para WP-B18 y C19**, sin decidirlo:

- **El parámetro y los filtros.** La función recibe la variante de origen y aplica lo que hoy hace `listOpenBulkLots` (`repository.ts`): lote de granel en `open_for_decant`, con saldo, por `opened_at` y luego `id`.
- **El `LotSnapshot` de `plan`.** `planDecant` pide `status`, `variantType`, `uom` y `unitCost`, y la función devuelve solo tres columnas. C19 resuelve cómo `plan` arma el snapshot sin costo (por ejemplo, haciendo del estado y del tipo una garantía de lo que la función devuelve).
- **Los insumos del BOM.** `plan` también lee sus lotes (`listSupplyLots`), detrás de la misma política: la función los cubre con el mismo contrato, o C19 decide cómo se verifica su disponibilidad sin costos.
- **El `sourceLotId` del vendedor.** Un lote de origen que RLS oculta es un 404 (WP-C13); C19 decide si el vendedor puede pasar uno.

**Las respuestas tampoco muestran costos.** Ni la respuesta de `plan` ni la lectura de la orden por el vendedor exponen costos, lotes con costo ni totales. Son un esquema propio en `packages/contracts`, distinto del administrativo (la regla de `.claude/rules/contracts.md`, no el mismo con campos opcionales), y un **test de contrato** verifica que no filtra las claves prohibidas (`cost`, `landed`, `supplier`, `margin`, `fx_rate`). Hoy no existe un procedimiento donde el vendedor lea la orden (`inventory.decant.list` exige `inventory.stock:read`), y `adminDecantWorkOrderSchema` no tiene claves de costo: la exigencia vale para la respuesta de `plan` y para el procedimiento de lectura que C19 agregue, si lo agrega.

**Qué no cambia.** `lots_read` sigue exigiendo `inventory.stock:read`; el `vendedor` sigue sin leer `inventory_lots`; ejecutar la orden sigue exigiendo `inventory.decant:execute` (la política de `inventory_movements` de B11d); la función no escribe nada.

**Una orden activa por línea de venta (H3; decisión de José, 2026-10-08).** `decant_work_orders` guarda la línea de venta (`sale_order_line_id`) y un índice único parcial `WHERE status <> 'cancelled'` impide una segunda orden activa para la misma línea; cancelar permite replanificar. La `Idempotency-Key` de `plan` sigue siendo opcional y solo sirve para reintentos: no puede garantizar «una orden por línea», porque la elige el cliente. Es un invariante de la base y lo agrega WP-B18; que `plan` reciba la línea y traduzca la violación a un 409 es de C19.

**Qué prueba WP-B18** (y C19 comprueba por la API), como `joda_api` y no como superusuario: el vendedor, sin `inventory.stock:read`, obtiene `lot_id`, disponible y apertura de su tenant, y nada más; una sesión sin `inventory.decant:plan` recibe el rechazo y no un vacío; el dueño de otro tenant no ve lotes ajenos; un intento de sombra en `pg_temp` no cambia el resultado; la respuesta del vendedor no trae ninguna clave de costo, y el índice rechaza una segunda orden activa para la misma línea y admite una nueva después de cancelar la anterior.

### 3.2 Capa 2 — Middleware

```ts
export const requirePermission =
  (...required: PermissionCode[]) =>
  async (req: Request, reply: Reply) => {
    const s = req.session;
    if (!s || s.audience !== "staff") return reply.code(404).send();
    const granted = await permissionCache.get(s.userId);
    if (!required.every((p) => granted.has(p))) return reply.code(404).send();
  };
```

**404, no 403.** Un 403 confirma la existencia del endpoint.

**Los permisos no van en el token.** El token lleva `userId`, `tenantId`, `sessionId`, `audience`. Los permisos se resuelven en el servidor con caché en Redis, TTL 60 s: revocar un rol tiene efecto en un minuto, no cuando expire el token.

### 3.3 Capa 3 — Servicio

Reglas que dependen del recurso concreto y no se pueden expresar como permiso estático:

- Un `vendedor` solo anula ventas propias del día en curso.
- Ajustes de inventario por encima de un umbral de valor requieren `manager`.
- Cerrar un período contable requiere que no haya eventos sin postear.
- **`catalog.product:publish` es el permiso de lo que la tienda muestra, y no siempre lo declara el procedimiento.** Publicar y despublicar un producto, mostrar u ocultar una variante y **mostrar u ocultar una categoría** lo exigen, y `catalog.category.update` solo declara `catalog.product:write`: el servicio pide además `publish` cuando el pedido cambia `isVisible` (renombrar o mover sigue siendo `write`; RN-CAT-05, WP-C08k, decisión de José del 2026-10-12). Activar un producto que ya tiene `published_at` también lo exige; reactivar un archivado, que vuelve sin publicar, solo pide `write` (RN-CAT-04, WP-C08q).

### 3.4 Frontend

```tsx
<Can perform="accounting.cashbox:read">
  <ResumenCaja />
</Can>
```

```tsx
{
  path: 'contabilidad',
  loader: requirePermissionLoader('accounting.cashbox:read'),
  lazy: () => import('./modules/contabilidad/routes'),
}
```

**Esto es experiencia de usuario, no seguridad.** Cualquiera puede editar el estado de React y renderizar la pantalla de caja. Lo que no puede es obtener los datos: la petición sale igual y la API responde 404.

`lazy()` además evita descargar el código del módulo.

> Si alguna vez una pantalla protegida solo por `<Can>` muestra datos reales, el bug está en la API.

---

## 4. Sesiones

### 4.1 Cookies

```
__Host-joda_a
  HttpOnly · Secure · SameSite=Strict · Path=/ · sin Domain (scope al host exacto)
```

El prefijo `__Host-` impide que un subdominio comprometido sobrescriba la cookie.

### 4.2 Tokens

- **Acceso:** 15 min, en memoria del servidor de sesión. Nunca en `localStorage`.
- **Refresco:** rotativo. Cada uso emite uno nuevo e invalida el anterior.
- **Detección de reúso:** si reaparece un refresco ya consumido, se invalida **toda la familia de tokens** de esa sesión y se fuerza reautenticación. Es la señal de que alguien copió un token.

### 4.3 Segundo factor

Obligatorio para personal. TOTP. Un usuario sin segundo factor inscripto puede autenticarse pero solo accede a la pantalla de inscripción.

**El desafío se repite en cada sesión nueva, no solo la primera vez.** Un usuario ya inscripto que inicia sesión no queda automáticamente habilitado: la sesión nace igual de restringida (solo puede llamar a `auth.mfa.verify`) hasta presentar un código válido. Si no fuera así, el segundo factor dejaría de tener efecto después de la primera inscripción — cualquiera con la contraseña entraría para siempre sin él. Implementado en WP-C04: `staff_sessions.mfa_verified_at` guarda el momento en que ESA sesión (no el usuario en general) satisfizo el desafío.

---

## 5. Protección de entrada

| Vector                  | Mitigación                                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inyección SQL           | Prisma parametriza. `$queryRawUnsafe` prohibido por regla de lint que falla el build. SQL crudo solo con `Prisma.sql` y marcadores.                                                                                                |
| Asignación masiva       | Zod `.strict()` en toda entrada. Rechaza campos no declarados.                                                                                                                                                                     |
| XSS                     | React escapa por defecto. `dangerouslySetInnerHTML` prohibido; contenido enriquecido pasa por sanitizador. CSP con nonce.                                                                                                          |
| CSRF                    | Cookies `SameSite` + token de doble envío en mutaciones del admin.                                                                                                                                                                 |
| Carga de archivos       | Validación por **bytes mágicos**, no por `Content-Type`. Reprocesamiento con `sharp` (elimina metadatos y cargas útiles embebidas). Nombre por hash. Límite de tamaño y dimensiones. Servidos desde dominio distinto al del admin. |
| Fuerza bruta            | Límite de tasa + retardo progresivo. Bloqueo temporal a los 10 intentos.                                                                                                                                                           |
| Enumeración de usuarios | Mensaje idéntico para usuario inexistente y contraseña incorrecta. Tiempo de respuesta constante.                                                                                                                                  |
| Recorrido de rutas      | Ninguna ruta de archivo se construye con entrada del usuario.                                                                                                                                                                      |
| SSRF                    | No hay endpoints que descarguen URLs provistas por el usuario. Si se agregan, lista blanca de dominios.                                                                                                                            |

### 5.1 Cabeceras

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-...'; ...
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), camera=(), microphone=()
```

---

## 6. Datos de pago

**El número de tarjeta no entra al sistema.** Checkout hospedado o iframe del proveedor: el dato viaja del navegador del cliente al proveedor sin pasar por el servidor, el dominio ni las bitácoras de JODA.

Se almacenan `card_last4` y `card_brand`, que no son datos de tarjeta bajo las normas de la industria.

**Lista negra en el registrador de bitácoras**, aplicada centralmente y no en cada llamada:

```ts
const REDACT = ["card", "pan", "cvv", "cvc", "token", "authorization", "password", "secret"];
```

**Verificación de webhooks:** validar firma del proveedor antes de procesar, y confirmar el monto contra la API del proveedor antes de dar una venta por pagada. Un webhook es una notificación, no una autorización.

---

## 7. Auditoría

`audit_log` es append-only e inmutable, y ni la API puede borrarla.

Registran: toda mutación de inventario, contabilidad, compras, precios, permisos y configuración fiscal.

Campos: `actor_id`, `audience`, `action`, `entity`, `entity_id`, `before`, `after`, `ip`, `user_agent`, `request_id`, `occurred_at`.

`action` usa el mismo nombre que el procedimiento tRPC, para poder cruzar bitácora con métricas.

---

## 8. Secretos

- Nunca en el repositorio. `.env` en `.gitignore`, con `.env.example` documentando las variables sin valores.
- Validados con Zod al arrancar: **si falta una variable, el proceso no levanta.** Fallar en el arranque es infinitamente preferible a fallar en la primera venta.
- Rotación de credenciales de base y de proveedores cada 12 meses, o inmediata ante sospecha.
- La credencial elevada de base (`service_role`) vive únicamente en los secretos de integración continua.

---

## 9. Datos personales

- Se recoge el mínimo: nombre, contacto, dirección de envío, documento cuando la facturación lo exige.
- No se almacenan datos de tarjeta, ni preferencias sensibles, ni historial de navegación asociado a la identidad.
- Un cliente puede solicitar la eliminación de su cuenta: se anonimizan sus datos personales conservando los registros contables y fiscales, que tienen obligación legal de retención.
- Las bitácoras no contienen datos personales más allá del identificador del actor.

---

## 10. Lista de verificación para revisión de código

Antes de aprobar un PR que toque estas áreas:

- [ ] ¿Todo procedimiento nuevo declara su permiso en `meta`?
- [ ] ¿La transacción establece el contexto de sesión antes de la primera consulta, con el tercer parámetro en `true`?
- [ ] ¿Se usa `joda_api` y no una credencial elevada?
- [ ] ¿Toda tabla nueva tiene `tenant_id` y su política de aislamiento?
- [ ] ¿El DTO público excluye costos, proveedores, márgenes y cantidades exactas de stock?
- [ ] ¿La mutación irreversible acepta clave de idempotencia?
- [ ] ¿Los errores mostrados al usuario están en español y no filtran detalles internos?
- [ ] ¿Se registró la operación en la bitácora de auditoría, dentro de la misma transacción?
- [ ] ¿Hay algún secreto, token o dato personal en un `console.log` olvidado?
