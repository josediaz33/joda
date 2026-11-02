-- =====================================================================
-- 0041_stock_reservations_runtime.sql  (WP-C18b)
--
-- Lo que la API necesita en la base para que `stock_reservations` deje de
-- ser una tabla vacía: las decisiones de José del 2026-10-29 (RN-RES-02, 04,
-- 06 y 07 de `docs/domain-rules.md`, «Decisiones (C18)» en el backlog) y lo
-- que C18a (`0040`) dejó a propósito para este WP. Cinco cosas, todas
-- expand-safe: ninguna quita una columna ni cambia lo que la API ya lee, y la
-- tabla no tiene filas de la API todavía.
--
--   1. La configuración del TTL por tenant.
--   2. Una reserva sin liberar por unidad serializada, y de una sola unidad.
--   3. La función `SECURITY DEFINER` del job de liberación.
--   4. Los permisos de escritura de la tabla.
--   5. `app.list_decant_plan_lots` descuenta las reservas atadas al lote.
--
-- ---------------------------------------------------------------------
-- 1 · EL TTL POR TENANT
--
-- `tenants.reservation_ttl_hours`, un entero de 1 a 720 horas (30 días, el
-- tope de la retención manual de RN-RES-02), 24 por defecto. Es la duración de
-- la reserva que nace al pasar un pedido a `awaiting_payment` sin que el
-- sistema conozca el medio de pago (RN-RES-02; decisión de José del
-- 2026-10-29, interpretada en `docs/decisiones-provisionales.md`): el único
-- caso que la tabla de TTL por medio no cubre y el único que existe hoy,
-- porque todavía no hay pagos. Los TTL por medio (tarjeta 30 min,
-- transferencia 48 h, seña hasta su vencimiento) no se configuran.
--
-- Se eligió una columna y no una tabla de ajustes porque es lo más simple y lo
-- más fácil de deshacer (`DROP COLUMN` en dos despliegues, como siempre): un
-- solo valor, sin tabla ni política nuevas. Qué NO resuelve: `tenants` tiene
-- una única política, `tenant_self` (0014, FOR ALL, permisiva), así que
-- cualquier sesión del tenant podría escribir la columna por SQL. No hay
-- ningún procedimiento de la API que la escriba (se cambia con un UPDATE de
-- operaciones), pero la tabla entera, `legal_name` y `ruc` incluidos, sigue
-- escribible sin permiso: es anterior a este WP y queda anotado como WP-B21.
--
-- ---------------------------------------------------------------------
-- 2 · UNA RESERVA SIN LIBERAR POR UNIDAD SERIALIZADA
--
-- Dos borradores pueden elegir el mismo reloj (RN-VTA-06: al crear no se
-- reserva), y sin esto las dos reservas al pasar a `awaiting_payment` se
-- aceptarían: el mismo reloj prometido a dos clientes.
--
--   · `stock_reservations_one_open_per_serial_unit`: índice único parcial
--     sobre `serial_unit_id` donde la unidad no es nula y la reserva no se
--     liberó. Es «sin liberar» y no «viva» (`expires_at > now()`) a propósito:
--     un predicado de índice no puede depender de `now()`. Una reserva vencida
--     que el job todavía no liberó sigue ocupando la unidad; la API libera las
--     vencidas de las variantes que va a reservar antes de insertar, así que
--     no hay que esperar al job.
--   · `stock_reservations_serial_unit_qty_one`: una reserva de una unidad
--     serializada es de `qty = 1` (RN-VTA-04: una línea con `serial_unit_id`
--     mueve exactamente una unidad). Sin esto, una reserva de 3 sobre un reloj
--     descontaría 3 del disponible de la variante.
--
-- Con la tabla sin filas de la API no valida nada. Si hubiera una incoherente
-- (dos sin liberar sobre la misma unidad, o una unidad con `qty` distinta de
-- 1), la migración falla al crear el índice o la restricción, nombrándolo: se
-- corrige o se libera esa fila y se vuelve a correr.
--
-- ---------------------------------------------------------------------
-- 3 · LA FUNCIÓN DEL JOB DE LIBERACIÓN
--
-- `joda_api` ve un solo tenant por transacción (RLS), y el job de liberación
-- (RN-RES-04) tiene que recorrerlos todos. La decisión de José es que corra
-- como `joda_api`, NUNCA como `service_role`, y que descubra los tenants con
-- una función `SECURITY DEFINER` que devuelve SOLO ids. Esta:
--
--   `app.tenants_with_expired_reservations(p_as_of timestamptz)`
--     → los ids de los tenants con al menos una reserva sin liberar cuyo
--       `expires_at` es menor o igual a `p_as_of` (la definición provisional
--       de «tenant activo»: `docs/decisiones-provisionales.md`).
--
--   · Devuelve `SETOF uuid`: el id del tenant y nada más. No hay cantidad,
--     variante, pedido, cliente ni fecha en lo que sale.
--   · `p_as_of` lo pone el llamador (el reloj de la API) y no el `now()` de la
--     base, para que el job y la liberación que sigue usen el mismo instante y
--     la prueba pueda fijarlo. Un llamador que pasa una fecha futura solo
--     obtiene los ids de los tenants cuyas reservas vencen hasta entonces.
--   · FALLA CERRADO si hay un tenant en el contexto: la función lista a TODOS
--     los tenants, así que dentro de una transacción de un tenant (la de
--     cualquier petición) rechaza con 42501. Solo el job la llama, antes de
--     fijar un tenant. Es lo que impide que una sesión del tenant A averigüe
--     qué otros tenants tienen reservas vencidas.
--   · `search_path = app, pg_temp` y nombres calificados, `REVOKE` de `PUBLIC`
--     y `GRANT` solo a `joda_api` (como 0011 y 0039). Dependencia de B09
--     (0018): lee `stock_reservations` por encima de RLS, así que su dueño
--     tiene que eludirla; los invariantes 30 y 40 ya lo verifican.
--
-- Por cada id, el job abre una transacción con `set_config('app.tenant_id',
-- …, true)` y `app.audience = 'system'` y libera BAJO RLS. De ahí el punto 4.
--
-- ---------------------------------------------------------------------
-- 4 · LOS PERMISOS DE ESCRITURA DE LA TABLA
--
-- Desde 0010 la tabla solo exigía tenant para todo: cualquier sesión del
-- tenant creaba, editaba o liberaba reservas de cualquiera (el disponible de
-- una variante se podía agotar, o una promesa a un cliente deshacer, sin
-- permiso alguno). El patrón de B11 (0030, 0034): una política por comando,
-- nunca `FOR ALL`, que se combina con `tenant_isolation` (RESTRICTIVE) con
-- AND.
--
--   comando  quién
--   -------  ---------------------------------------------------------------
--   SELECT   tenant (sin cambio: el disponible lo ve todo el tenant, 0022)
--   INSERT   el permiso del `reason` de la reserva (tabla de abajo)
--   UPDATE   el mismo permiso sobre la fila que se libera, o el job
--   DELETE   nadie: una reserva liberada o vencida conserva su fila
--
--   reason                          permiso
--   ------------------------------  ----------------------------------------
--   checkout, order_pending_payment sales.order:write
--   decant_hold                     inventory.decant:plan o
--                                   inventory.decant:execute
--   deposit_hold, manual_hold       nadie, todavía
--
-- `deposit_hold` (la seña, WP-C20) y `manual_hold` (la retención del
-- personal, sin WP) no tienen código que las escriba: quedan sin permiso, y
-- el WP que las introduzca agrega su rama en una migración (la política falla
-- cerrado: un `reason` sin rama se rechaza). Es la opción más restrictiva y
-- se relaja sin tocar datos (`docs/decisiones-provisionales.md`).
--
-- El job es la excepción: libera con audiencia `system`, que no tiene sesión
-- de staff y por lo tanto ningún permiso (`has_permission` exige staff, 0019).
-- La política de UPDATE le abre una sola cosa: un UPDATE sobre una reserva sin
-- liberar cuya fila nueva queda liberada (USING exige `released_at IS NULL`,
-- WITH CHECK exige `released_at IS NOT NULL`). No inserta, no borra y no toca
-- una ya liberada: esta rama no la «reactiva». La audiencia `system` la fija
-- solo `withTenantTx`, desde una sesión resuelta y nunca desde la entrada del
-- cliente (`sessionContextAudit.test.ts`). Qué reserva se libera, y cuándo, lo
-- decide el job (`expires_at <= p_as_of`), no la política: ya está en el SQL de
-- la API, y repetir `expires_at <= now()` acá haría fallar al job cuando el
-- reloj de la API y el de la base difieren.
--
-- LO QUE LA POLÍTICA NO IMPIDE, ni en esta rama ni en la del permiso: limitar
-- QUÉ columnas cambia el UPDATE. En la rama `system`, el mismo UPDATE que
-- libera puede cambiar también `qty` o `expires_at`. En la del permiso del
-- `reason` se puede reescribir `qty` y `expires_at` y hasta poner
-- `released_at` en `NULL` (reactivar una liberada, que RN-RES-04 prohíbe).
-- «Una reserva se libera, no se edita» y «una liberada no se reactiva» son hoy
-- reglas del servicio, no de la base; un trigger de invariante las impondría
-- (solo `released_at` pasa de nulo a no nulo, una vez): WP-B21(2).
--
-- La trampa de la lectura no aplica: el SELECT es por tenant, así que ni
-- `INSERT ... RETURNING` ni `UPDATE ... WHERE` dependen de otro permiso.
--
-- ---------------------------------------------------------------------
-- 5 · `app.list_decant_plan_lots` DESCUENTA LAS RESERVAS
--
-- 0039 devolvía el saldo del lote sin descontar nada, y en cuanto un plan
-- reserva granel atado a su lote (RN-FRA-02, RN-RES-06), dos planes verían el
-- mismo granel disponible. `CREATE OR REPLACE` con la misma firma, las mismas
-- tres columnas y el mismo contrato de seguridad (SECURITY DEFINER,
-- `search_path` fijo, falla cerrado, sin costos, mismo `GRANT`): lo único que
-- cambia es que `available` es el saldo menos las reservas VIVAS atadas al
-- lote (`released_at IS NULL AND expires_at > now()`, la misma definición de
-- «viva» que `v_stock_available`) y que un lote sin nada libre ya no es
-- candidato. Las reservas sin lote (las de un insumo, que son por variante)
-- no se descuentan acá: quien planifica las descuenta del total de la variante
-- con `v_stock_available`, que el vendedor sí ve.
-- =====================================================================
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- 1 · TTL por tenant
-- ---------------------------------------------------------------------
ALTER TABLE app.tenants
  ADD COLUMN reservation_ttl_hours integer NOT NULL DEFAULT 24,
  ADD CONSTRAINT tenants_reservation_ttl_hours_range
    CHECK (reservation_ttl_hours BETWEEN 1 AND 720);

-- ---------------------------------------------------------------------
-- 2 · Una reserva sin liberar por unidad serializada, de a una unidad
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX stock_reservations_one_open_per_serial_unit
  ON app.stock_reservations (serial_unit_id)
  WHERE serial_unit_id IS NOT NULL AND released_at IS NULL;

ALTER TABLE app.stock_reservations
  ADD CONSTRAINT stock_reservations_serial_unit_qty_one
  CHECK (serial_unit_id IS NULL OR qty = 1);

-- Las dos búsquedas que hace la API al decidir: las reservas vivas atadas a un
-- lote (apertura de frasco, plan de decant) y las de un origen (soltar las de
-- un pedido o de una orden de fraccionamiento).
CREATE INDEX reservations_lot_live
  ON app.stock_reservations (lot_id)
  WHERE released_at IS NULL AND lot_id IS NOT NULL;

CREATE INDEX reservations_reference_live
  ON app.stock_reservations (reference_type, reference_id)
  WHERE released_at IS NULL AND reference_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 3 · Los tenants con reservas por liberar
-- ---------------------------------------------------------------------
CREATE FUNCTION app.tenants_with_expired_reservations(p_as_of timestamptz)
RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
BEGIN
  -- Lista a todos los tenants: solo tiene sentido sin un tenant en el contexto.
  IF app.current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'Esta función lista todos los tenants y no se puede llamar dentro del contexto de uno'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'Falta el instante hasta el que se buscan reservas vencidas'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  RETURN QUERY
  SELECT DISTINCT r.tenant_id
    FROM app.stock_reservations r
   WHERE r.released_at IS NULL
     AND r.expires_at <= p_as_of
   ORDER BY 1;
END $$;

REVOKE ALL ON FUNCTION app.tenants_with_expired_reservations(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenants_with_expired_reservations(timestamptz) TO joda_api;

-- ---------------------------------------------------------------------
-- 4 · Permisos de escritura de `stock_reservations`
--
-- El permiso del `reason` de una reserva. No es SECURITY DEFINER: se evalúa
-- con los privilegios de quien escribe, y `has_permission` ya lo es. Falla
-- cerrado: un `reason` sin rama (deposit_hold, manual_hold, o uno que se
-- agregue al enum) da falso.
-- ---------------------------------------------------------------------
CREATE FUNCTION app.can_write_stock_reservation(p_reason app.reservation_reason)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = app, pg_temp AS $$
  SELECT CASE p_reason
    WHEN 'checkout'              THEN app.has_permission('sales.order:write')
    WHEN 'order_pending_payment' THEN app.has_permission('sales.order:write')
    WHEN 'decant_hold'           THEN app.has_permission('inventory.decant:plan')
                                   OR app.has_permission('inventory.decant:execute')
    ELSE false
  END
$$;

REVOKE ALL ON FUNCTION app.can_write_stock_reservation(app.reservation_reason) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_write_stock_reservation(app.reservation_reason) TO joda_api;

-- `tenant_access` (0016, FOR ALL con `true`) se reemplaza por una política por
-- comando. `tenant_isolation` (RESTRICTIVE) sigue combinándose con AND.
DROP POLICY tenant_access ON app.stock_reservations;

CREATE POLICY tenant_access_select ON app.stock_reservations
  FOR SELECT USING (true);

CREATE POLICY reservations_insert ON app.stock_reservations
  FOR INSERT WITH CHECK (app.can_write_stock_reservation(reason));

-- El job libera con audiencia `system`: la fila tiene que estar sin liberar y
-- quedar liberada. NO limita qué otras columnas cambia ese mismo UPDATE, ni la
-- rama del permiso qué reescribe ni si reabre una reserva (WP-B21(2)).
-- La audiencia se lee del ajuste directamente y no con `app.current_audience()`: esa
-- función castea a `actor_audience` SIN calificar, y fuera de una SECURITY DEFINER
-- (la política corre con el `search_path` de la sesión, que en la API no incluye
-- `app`) el cast falla. Además es más estricta: `current_audience()` devuelve
-- `system` cuando el ajuste está vacío, y acá hay que decirlo a propósito.
CREATE POLICY reservations_update ON app.stock_reservations
  FOR UPDATE
  USING (
    app.can_write_stock_reservation(reason)
    OR (current_setting('app.audience', true) = 'system' AND released_at IS NULL)
  )
  WITH CHECK (
    app.can_write_stock_reservation(reason)
    OR (current_setting('app.audience', true) = 'system' AND released_at IS NOT NULL)
  );

-- Sin política de DELETE: una reserva liberada o vencida conserva su fila.

-- ---------------------------------------------------------------------
-- 5 · Los lotes candidatos de un decant, sin las reservas
--
-- Misma firma, mismas columnas y mismo contrato que en 0039; cambia
-- `available` y el filtro. `CREATE OR REPLACE` conserva el dueño y el GRANT.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.list_decant_plan_lots(p_variant_id uuid)
RETURNS TABLE (lot_id uuid, available app.qty, opened_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_type   app.variant_type;
  v_status app.lot_status;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'No hay tenant en el contexto de la sesión: no se pueden listar lotes para planificar'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- `has_permission` exige además sesión de staff viva del mismo usuario y
  -- tenant (0019): sin sesión da falso, y este rechazo es el de «sin sesión».
  IF NOT app.has_permission('inventory.decant:plan') THEN
    RAISE EXCEPTION 'Falta el permiso inventory.decant:plan, o no hay una sesión de personal vigente'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_variant_id IS NULL THEN
    RAISE EXCEPTION 'Falta la variante de los lotes a listar'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  SELECT v.variant_type INTO v_type
    FROM app.product_variants v
   WHERE v.id = p_variant_id
     AND v.tenant_id = v_tenant;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La variante % no existe en el tenant de la sesión', p_variant_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- El estado lo decide el tipo de la variante, no quien llama: el granel se
  -- sirve de lotes abiertos para fraccionar; un insumo, de lotes disponibles.
  v_status := CASE WHEN v_type = 'bulk' THEN 'open_for_decant'::app.lot_status
                   ELSE 'available'::app.lot_status END;

  RETURN QUERY
  SELECT l.id,
         (b.on_hand - COALESCE(r.reserved, 0))::app.qty,
         l.opened_at
    FROM app.inventory_lots l
    JOIN app.inventory_balances b
      ON b.lot_id = l.id
     AND b.tenant_id = l.tenant_id
    LEFT JOIN LATERAL (
      SELECT sum(sr.qty) AS reserved
        FROM app.stock_reservations sr
       WHERE sr.lot_id = l.id
         AND sr.tenant_id = v_tenant
         AND sr.released_at IS NULL
         AND sr.expires_at > now()
    ) r ON true
   WHERE l.variant_id = p_variant_id
     AND l.tenant_id = v_tenant
     AND l.status = v_status
     AND b.on_hand - COALESCE(r.reserved, 0) > 0
   ORDER BY l.opened_at, l.id;
END $$;
