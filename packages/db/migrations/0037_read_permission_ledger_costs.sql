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
-- LOS DISPARADORES NO SE VEN AFECTADOS, pero uno hablaba de más. Los que leen
-- el ledger o sus capas (`assert_cost_allocation_matches`, la proyección de
-- saldos) son SECURITY DEFINER desde 0018: ven el ledger sin importar quién
-- escribe. Por eso un rol que escribe un movimiento sin poder leerlo sigue
-- validado igual. `v_balance_drift` es `security_invoker` y ya exigía
-- `inventory.stock:read` por los lotes: no cambia.
--
-- LA RUTA DE FUGA QUE QUEDABA: el mensaje de ese disparador. Rechaza una capa
-- que no cuadra con `Capas de costo del movimiento N no cuadran: asignado=X
-- declarado=Y`, y `Y` es el `total_cost_pyg` del movimiento, leído con los
-- privilegios del dueño. La política de INSERT de las capas es solo por tenant
-- (WP-B11e) y la FK a `movement_id` no evalúa RLS, así que el vendedor podía
-- insertar una capa de 1 sobre CUALQUIER movimiento del tenant (una recepción
-- de compra, un transfer), forzar la verificación (`SET CONSTRAINTS ...
-- IMMEDIATE`, o el COMMIT) y leer el costo en el error: 1.496.500, con el
-- ledger ya cerrado. Reproducido contra 0037 sin esta función.
--
-- Se corrige con el mismo criterio: los montos van en el mensaje solo para
-- quien tiene `inventory.stock:read`; para los demás, el mismo rechazo sin
-- cifras. Para un movimiento sin capas, el rechazo sigue distinguiendo «el
-- total coincide» de «no coincide», o sea que quien adivine el total exacto
-- lo confirma; cerrarlo del todo es atar la capa a un movimiento que quien la
-- escribe acaba de crear, y eso es el diseño de WP-B11e (queda anotado allí y
-- fijado como comportamiento conocido en `write_permissions.test.ts`).
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
-- vendedor, el 130 que el vendedor siga sin ese permiso y el 131 que el
-- rechazo de una capa que no cuadra no traiga los montos.
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
-- no ve el movimiento que acaba de insertar; hay que resolverlo allá. Y es el
-- lugar de cerrar la prueba por igualdad de arriba: que una capa solo se
-- pueda atar a un movimiento que quien la escribe creó en esa transacción.
-- (3) El
-- mismo costo vive en otras columnas que RLS no esconde: `sale_orders.cogs_pyg`
-- y `sale_order_lines.cogs_pyg` (el vendedor lee sus ventas), y en los
-- snapshots de `audit_log` (la apertura de un frasco guarda
-- `unitLandedCostPyg`) e `idempotency_keys.response` (la respuesta de un
-- ajuste incluye `totalCostPyg`), que se leen por tenant. Cerrarlos es una
-- decisión de diseño (qué ve cada rol de una venta; qué permiso lee la
-- auditoría), no de esta migración (WP-B11g). (4) La raíz del costo:
-- `goods_receipt_lines` (precio unitario y flete prorrateado) y
-- `goods_receipts` se leen por tenant, y con ellos se reconstruye el costo de
-- una recepción: 19000 × 7300 / 100 × qty + flete = 1.496.500, el
-- `total_cost_pyg` del movimiento 1 del smoke. Decisión de José
-- (2026-10-08): el alcance de B11f es el ledger y sus capas de costo; las
-- recepciones se cierran en la parte de DB de WP-C15, con lectura
-- `market.purchase_order:read` o `:receive` (el vendedor no tiene ninguno).
-- (5) `journal_lines` (asientos de COGS que dejará el posteo) se lee y se
-- escribe por tenant, a diferencia de `journal_entries`: WP-B11h, con plazo
-- escrito por José: antes de habilitar cualquier regla de posteo (H01) y
-- siempre antes del cutover. (6) El rechazo sin cifras vale para cualquier
-- sesión sin `inventory.stock:read`, también para el ETL o un `psql` sin
-- contexto de staff: al depurar un descuadre, los montos se consultan en el
-- ledger.
--
-- Esta migración cambia políticas; no cambia columnas ni datos.
-- =====================================================================
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- inventory_movements
--
-- `(SELECT app.has_permission(...))` y no `app.has_permission(...)` a secas: el
-- ledger es la tabla de alto volumen, y la función suelta se evalúa FILA POR
-- FILA (100.000 movimientos de un lote, leídos como depósito: 3,2 s), mientras
-- que la subconsulta la convierte en un InitPlan que se evalúa una vez por
-- sentencia (84 ms). Es una consulta de solo lectura, estable dentro de la
-- sentencia: el resultado es el mismo. Importa en los recorridos del ledger
-- entero (conciliación, `v_balance_drift`). `lots_read` y `po_lines_read` no se
-- tocan: son tablas chicas y ya están aplicadas.
-- ---------------------------------------------------------------------
DROP POLICY tenant_access_select ON app.inventory_movements;

CREATE POLICY movements_read ON app.inventory_movements
  FOR SELECT USING ((SELECT app.has_permission('inventory.stock:read')));

-- ---------------------------------------------------------------------
-- movement_cost_allocations
-- ---------------------------------------------------------------------
DROP POLICY tenant_access ON app.movement_cost_allocations;

CREATE POLICY allocations_read ON app.movement_cost_allocations
  FOR SELECT USING ((SELECT app.has_permission('inventory.stock:read')));
CREATE POLICY tenant_access_insert ON app.movement_cost_allocations
  FOR INSERT WITH CHECK (true);

-- ---------------------------------------------------------------------
-- El mensaje del disparador de las capas no dice el costo a quien no lo lee
--
-- Mismo cuerpo que 0018 (SECURITY DEFINER, falla cerrado, filtra por tenant,
-- `search_path` fijo); solo cambia el mensaje del último rechazo. CREATE OR
-- REPLACE conserva el disparador `trg_cost_allocation_matches` que la usa.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_cost_allocation_matches() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE
  v_declared app.pyg;
  v_alloc    numeric;
BEGIN
  PERFORM 1
     FROM app.inventory_lots l
    WHERE l.id = NEW.lot_id
      AND l.tenant_id = NEW.tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Lote % no encontrado en el tenant de la capa de costo: no se puede verificar la capa',
      NEW.lot_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT m.total_cost_pyg INTO v_declared
    FROM app.inventory_movements m
   WHERE m.id = NEW.movement_id
     AND m.tenant_id = NEW.tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Movimiento % no encontrado en el tenant de la capa de costo: no se puede verificar la capa',
      NEW.movement_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Solo las capas del mismo tenant: una capa de otro tenant colgada de
  -- este movimiento la rechaza su propio disparo de este trigger.
  SELECT COALESCE(sum(a.total_cost_pyg), 0) INTO v_alloc
    FROM app.movement_cost_allocations a
   WHERE a.movement_id = NEW.movement_id
     AND a.tenant_id = NEW.tenant_id;

  -- `total_cost_pyg` del movimiento es nullable por diseño (un movimiento
  -- sin costo declarado); el NULL acá es un dato, no falta de visibilidad:
  -- el movimiento ya se encontró arriba. Sin costo declarado, cualquier
  -- capa con costo descuadra.
  IF v_alloc <> COALESCE(abs(v_declared), 0) THEN
    -- Los montos son el costo del movimiento: solo para quien lo puede leer.
    -- Esta función ve el ledger con los privilegios del dueño; el mensaje
    -- no puede devolver lo que RLS le oculta a quien escribe.
    IF app.has_permission('inventory.stock:read') THEN
      RAISE EXCEPTION
        'Capas de costo del movimiento % no cuadran: asignado=% declarado=%',
        NEW.movement_id, v_alloc, COALESCE(abs(v_declared), 0)
        USING ERRCODE = 'check_violation';
    END IF;
    RAISE EXCEPTION
      'Capas de costo del movimiento % no cuadran con el costo del movimiento',
      NEW.movement_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
