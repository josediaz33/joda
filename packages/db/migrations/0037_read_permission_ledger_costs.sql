-- =====================================================================
-- 0037_read_permission_ledger_costs.sql  (WP-B11f, ADR-016)
--
-- DEFECTO. El costo de lo que se mueve está en tres tablas, y el vendedor leía
-- dos de ellas. `inventory_lots` (`unit_landed_cost_pyg`) exige
-- `inventory.stock:read` desde 0010 y `purchase_order_lines` (`unit_price_minor`)
-- desde 0034. Pero `inventory_movements` se lee por tenant (`tenant_access_select`
-- con `true`, 0034) y `movement_cost_allocations` también (`tenant_access`,
-- `FOR ALL` con `true`, 0014). Como vendedor, que no tiene
-- `inventory.stock:read`, `SELECT total_cost_pyg FROM app.inventory_movements`
-- devolvía el costo de cada movimiento (en la base del smoke, el de un frasco:
-- 1.496.500), y las capas de costo, el desglose por lote. Es el mismo dato que
-- B11 y B11d cerraron en lotes y en líneas de OC, abierto por otra tabla
-- (revisión cruzada de B11b/c/d, 2026-10-07).
--
-- DECISIÓN DE JOSÉ (2026-10-07). El vendedor NO obtiene
-- `inventory_movements.total_cost_pyg` por ninguna vía: ni por la API ni
-- leyendo la base. Mismo mecanismo que lotes y líneas de OC, sin inventar otro.
--
-- CORRECCIÓN. La política de SELECT de las dos tablas exige
-- `inventory.stock:read` ("Ver stock, lotes y costos de lote"), como `lots_read`
-- (0010) y `po_lines_read` (0034):
--
--   tabla                       SELECT                    INSERT       UPDATE / DELETE
--   --------------------------  ------------------------  -----------  ---------------
--   inventory_movements         inventory.stock:read      según tipo   nadie (ledger)
--                                                         (0034)
--   movement_cost_allocations   inventory.stock:read      solo tenant  nadie (ledger)
--
-- Por qué las dos y no solo `inventory_movements`. La capa de costo es el
-- desglose del `total_cost_pyg` del movimiento (la suma de sus capas es ese
-- total, trigger de 0009): dejarla por tenant era la ruta de rodeo, sumar
-- `movement_cost_allocations.total_cost_pyg` por `movement_id`. Y trae además
-- `unit_cost_pyg`, el costo unitario de cada lote consumido.
--
-- Por qué la tabla entera y no la columna. RLS decide por FILA; no puede
-- esconder `total_cost_pyg` y mostrar el resto. Un `REVOKE SELECT
-- (total_cost_pyg)` tampoco: `joda_api` es un solo rol para todas las sesiones
-- de la API, y el revoke dejaría ciego también a quien sí debe ver el costo. Si
-- el vendedor necesita las cantidades de un movimiento (no su costo), se le
-- expone una proyección de la API sin `totalCostPyg`; hoy ningún procedimiento
-- lo pide: el kardex (`lot.history`, `serial.history`) exige
-- `inventory.stock:read`, y la disponibilidad que ve quien vende sale de
-- `v_stock_available`, que lee saldos y no movimientos.
--
-- `movement_cost_allocations`: la `tenant_access` `FOR ALL` se reemplaza por
-- una política por comando. El INSERT queda como estaba (solo tenant, `true`):
-- ponerle el permiso del movimiento es WP-B11e, y se hace sobre la política
-- `tenant_access_insert` de esta migración. UPDATE y DELETE no tienen política
-- (la tabla es append-only y `joda_api` no tiene esos privilegios desde 0010),
-- así que nada cambia para ellos. `tenant_isolation` (RESTRICTIVE, 0016) sigue
-- combinándose con AND contra todo: tenant Y permiso.
--
-- LOS DISPARADORES NO SE VEN AFECTADOS. Los que leen el ledger o sus capas
-- (`assert_cost_allocation_matches`, la proyección de saldos) son SECURITY
-- DEFINER desde 0018: ven el ledger sin importar quién escribe. Por eso un
-- rol que escribe un movimiento sin poder leerlo sigue validado igual.
-- `v_balance_drift` es `security_invoker` y ya exigía `inventory.stock:read`
-- por los lotes: no cambia.
--
-- LA TRAMPA DE LA LECTURA, y es real para un rol sembrado. `INSERT ...
-- RETURNING` evalúa también la política de SELECT sobre la fila nueva, y el
-- cliente de Prisma emite `RETURNING` en todo `create`. La política de INSERT
-- de `inventory_movements` (0034) deja al vendedor escribir un movimiento
-- `sale` con `sales.order:write`; desde esta migración, su `INSERT ...
-- RETURNING` recibe 42501, porque no puede leer lo que escribió. Un `INSERT`
-- SIN `RETURNING` pasa: no evalúa la política de SELECT. El id del movimiento
-- (necesario para sus capas de costo) se toma en la misma sesión con
-- `currval(pg_get_serial_sequence('app.inventory_movements', 'id'))`, no con
-- `lastval()`: dentro del propio INSERT de la capa, `lastval()` devuelve la
-- identidad de la capa (su `id` se evalúa antes que el VALUES) y la capa
-- queda colgada de un movimiento que no es. `write_permissions.test.ts`
-- verifica que el vendedor registra así un `sale` y su capa, que la capa
-- cuadra con el movimiento al final de la transacción y que ninguno de los
-- dos se le muestra después.
-- Los otros tres roles sembrados que escriben movimientos (depósito:
-- `stock:adjust`, `decant:execute`, `po:receive`; dueño y encargado: todo)
-- tienen `inventory.stock:read`, así que no tienen la trampa; el invariante
-- 129 lo verifica para los roles sembrados, con la excepción registrada del
-- vendedor, y el 130 que el vendedor siga sin ese permiso.
--
-- Lo que se descartó, porque no cumple la decisión: dejar que el SELECT admita
-- las filas `sale` ("el que puede escribir el movimiento lo lee", como sugería
-- la fila de WP-B11f). Los movimientos `sale` son justamente los que traen el
-- costo de lo que el vendedor vendió: abrirlos para que el INSERT ... RETURNING
-- pase sería abrirle al vendedor el dato que esta migración le cierra.
--
-- QUÉ QUEDA FUERA, cada uno con su destino en `docs/backlog.md`.
-- (1) El camino de escritura del vendedor, de WP-C19: registrar el movimiento
-- `sale` y sus capas SIN `RETURNING` (SQL crudo y `currval`, no un `create`
-- de Prisma). Y como el vendedor tampoco lee los lotes (`lots_read`, 0010) para
-- elegir qué capa de costo consume, C19 ya tenía que resolver con qué sesión se
-- calcula el costo: es la misma pregunta que el hallazgo H1 de la revisión de
-- WP-C13. (2) WP-B11e, el INSERT de las capas de costo por permiso del
-- movimiento: si su política consulta `inventory_movements` para saber el
-- `movement_type` de `movement_id`, esa consulta corre bajo RLS y el vendedor
-- no ve el movimiento que acaba de insertar; hay que resolverlo allá. (3) El
-- mismo costo vive en otras columnas que RLS no esconde: `sale_orders.cogs_pyg`
-- y `sale_order_lines.cogs_pyg` (el vendedor lee sus ventas), y en los
-- snapshots de `audit_log` (la apertura de un frasco guarda
-- `unitLandedCostPyg`) e `idempotency_keys.response` (la respuesta de un
-- ajuste incluye `totalCostPyg`), que se leen por tenant. Cerrarlos es una
-- decisión de diseño (qué ve cada rol de una venta; qué permiso lee la
-- auditoría), no de esta migración.
--
-- Esta migración cambia políticas; no cambia columnas ni datos.
-- =====================================================================
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- inventory_movements
-- ---------------------------------------------------------------------
DROP POLICY tenant_access_select ON app.inventory_movements;

CREATE POLICY movements_read ON app.inventory_movements
  FOR SELECT USING (app.has_permission('inventory.stock:read'));

-- ---------------------------------------------------------------------
-- movement_cost_allocations
-- ---------------------------------------------------------------------
DROP POLICY tenant_access ON app.movement_cost_allocations;

CREATE POLICY allocations_read ON app.movement_cost_allocations
  FOR SELECT USING (app.has_permission('inventory.stock:read'));
CREATE POLICY tenant_access_insert ON app.movement_cost_allocations
  FOR INSERT WITH CHECK (true);
