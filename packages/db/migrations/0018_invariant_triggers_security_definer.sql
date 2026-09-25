-- =====================================================================
-- 0018_invariant_triggers_security_definer.sql  (WP-B09)
--
-- Barrido de TODAS las funciones de disparador del esquema `app`. Hoy son
-- nueve; `guard_posted_journal` ya quedó convertida en 0017 y es el modelo
-- de esta migración. Las ocho restantes se convierten JUNTAS, en el mismo
-- paso: arreglarlas de a una destapa la siguiente (ver "La trampa").
--
-- DEFECTO. Desde 0016, `inventory_lots` exige `inventory.stock:read` para
-- leer, también dentro de un trigger que corre con los permisos de quien
-- inserta (SECURITY INVOKER). El vendedor no tiene ese permiso:
--   · `assert_movement_uom` leía el lote como inexistente, `v_lot_uom`
--     quedaba NULL, `NULL IS DISTINCT FROM 'ml'` es verdadero y RECHAZABA
--     todo movimiento del vendedor (prueba de comportamiento conocido en
--     `rls_isolation.test.ts`). Fallaba cerrado, pero por accidente.
--   · `assert_sealed_lot_not_open` leía el mismo lote y fallaba ABIERTO:
--     `v_type = 'sealed' AND v_status = 'open_for_decant'` con NULL no es
--     verdadero, y dejaba pasar la venta como sellado de un frasco abierto.
--
-- LA TRAMPA. Los dos son BEFORE INSERT sobre `inventory_movements`, y
-- Postgres los ejecuta en orden alfabético: `trg_movement_uom` corre antes
-- que `trg_sealed_lot_guard` y rechaza primero, así que la falla abierta
-- del segundo quedaba enmascarada. Convertir solo el primero a SECURITY
-- DEFINER (para que el vendedor pueda vender) destapaba el segundo: el
-- vendedor podía vender como sellado un frasco abierto. Por eso todas van
-- juntas y cada una falla cerrado por sí sola, sin depender del orden de
-- ejecución ni de lo que haya validado otro trigger antes.
--
-- CORRECCIÓN, en toda función que lee o escribe otra tabla:
--   1. SECURITY DEFINER. Verifica integridad o mantiene una proyección; no
--      expone datos. Tiene que ver el lote, el movimiento o el asiento sin
--      importar los permisos de quien dispara el trigger.
--   2. FALLA CERRADO. `IF NOT FOUND THEN RAISE` antes de comparar; nunca
--      una comparación contra un valor que podría ser NULL por falta de
--      visibilidad (docs/data-model.md §4.2).
--   3. TENANT. Con SECURITY DEFINER la función ve filas de TODOS los
--      tenants, y una FK no evalúa RLS (lección de B08). Cada búsqueda
--      filtra por el `tenant_id` de la fila que dispara el trigger: una
--      fila de otro tenant da el mismo rechazo que una inexistente, con el
--      mismo mensaje, sin nombrar su tenant (el mensaje no puede devolver
--      lo que solo esta función ve). Invariantes nuevos que salen de acá:
--        · el lote de un movimiento es del tenant del movimiento;
--        · la variante de un movimiento es del tenant del movimiento;
--        · la variante DEL LOTE de un movimiento es del tenant del
--          movimiento (un lote que apunta a una variante ajena no mueve);
--        · el movimiento y el lote de una capa de costo son del tenant de
--          la capa;
--        · la proyección de saldo solo se actualiza en el tenant del
--          movimiento.
--   4. `SET search_path = app, pg_temp` y nombres calificados con `app.`.
--      En una SECURITY DEFINER, `pg_temp` se busca PRIMERO si no se lo
--      nombra: quien dispara el trigger podría sombrear `inventory_lots`
--      con una tabla temporal. Nombrarlo al final lo impide (manual de
--      Postgres, "Writing SECURITY DEFINER Functions Safely").
--
-- Las dos funciones que no leen ninguna tabla (`set_updated_at`,
-- `guard_append_only`) quedan SECURITY INVOKER — no necesitan ver nada —
-- pero también reciben `search_path` fijo: el barrido es sobre toda
-- función de disparador, y así el invariante 28 no necesita excepciones.
--
-- DEPENDENCIA OPERATIVA. SECURITY DEFINER corre con los privilegios del
-- DUEÑO de la función: el rol que corre las migraciones. Si ese rol no
-- elude RLS (ni superusuario ni BYPASSRLS), las tablas con FORCE ROW LEVEL
-- SECURITY lo filtran igual que a `joda_api` y esta corrección no sirve.
-- El invariante 30 lo verifica.
-- =====================================================================
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- Sin lectura de tablas: solo search_path fijo.
-- ---------------------------------------------------------------------
ALTER FUNCTION app.set_updated_at()    SET search_path = app, pg_temp;
ALTER FUNCTION app.guard_append_only() SET search_path = app, pg_temp;

-- ---------------------------------------------------------------------
-- Proyección de saldos (ADR-017, excepción anotada). No es un invariante
-- en sí, pero es lo que hace efectivo el CHECK de no-negatividad: si
-- dependiera de los permisos de quien escribe el movimiento, una política
-- futura sobre `inventory_balances` rompería el ledger.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.init_lot_balance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
BEGIN
  -- Todo sale de NEW, que ya pasó el WITH CHECK de tenant de inventory_lots.
  INSERT INTO app.inventory_balances (lot_id, tenant_id, variant_id, on_hand)
  VALUES (NEW.id, NEW.tenant_id, NEW.variant_id, 0);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app.project_lot_balance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
BEGIN
  -- El filtro por tenant es defensa en profundidad: los BEFORE INSERT de
  -- abajo ya rechazan un lote de otro tenant. Esta función no puede
  -- depender de que hayan corrido (invariante 33 la prueba sola).
  UPDATE app.inventory_balances
     SET on_hand = on_hand + NEW.qty,
         updated_at = now()
   WHERE lot_id = NEW.lot_id
     AND tenant_id = NEW.tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe fila de saldo para el lote % en el tenant del movimiento',
      NEW.lot_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------
-- Coherencia de unidad (invariante 5) + lote del tenant del movimiento.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_movement_uom() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE v_lot_uom app.uom;
BEGIN
  SELECT l.uom INTO v_lot_uom
    FROM app.inventory_lots l
   WHERE l.id = NEW.lot_id
     AND l.tenant_id = NEW.tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Lote % no encontrado en el tenant del movimiento: no se puede verificar el movimiento',
      NEW.lot_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- `uom` es NOT NULL en ambas tablas y el "no encontrado" ya se rechazó:
  -- esta comparación nunca ve un NULL por falta de visibilidad.
  IF v_lot_uom <> NEW.uom THEN
    RAISE EXCEPTION
      'Unidad de medida incompatible: el lote está en % y el movimiento en %',
      v_lot_uom, NEW.uom
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- Un frasco abierto no se vende sellado (invariante 6, RN-LOT-03). Busca
-- el lote y las variantes SIEMPRE, no solo en ventas: la verificación de
-- tenant vale para todo movimiento, y este trigger no puede apoyarse en
-- que `trg_movement_uom` haya corrido antes (eso era la trampa).
--
-- Decide con la variante DEL LOTE, no solo con la que declara el
-- movimiento. La versión de 0009 miraba únicamente `NEW.variant_id`, un
-- dato que pone quien inserta, y nada exige que coincida con
-- `inventory_lots.variant_id`. Una venta sobre un lote sellado abierto que
-- declarara la variante de granel pasaba (hallazgo de la revisión cruzada
-- de B09, reproducido como `joda_api` con un lote de tres frascos y uno
-- abierto). Se rechaza si CUALQUIERA de las dos es sellada: nunca es más
-- permisivo que 0009. Si la variante del movimiento debe coincidir siempre
-- con la del lote es una regla aparte, sin escribir (docs/backlog.md, B09).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_sealed_lot_not_open() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE
  v_status        app.lot_status;
  v_lot_variant   uuid;
  v_lot_type      app.variant_type;
  v_declared_type app.variant_type;
BEGIN
  SELECT l.status, l.variant_id INTO v_status, v_lot_variant
    FROM app.inventory_lots l
   WHERE l.id = NEW.lot_id
     AND l.tenant_id = NEW.tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Lote % no encontrado en el tenant del movimiento: no se puede verificar el movimiento',
      NEW.lot_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT v.variant_type INTO v_declared_type
    FROM app.product_variants v
   WHERE v.id = NEW.variant_id
     AND v.tenant_id = NEW.tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Variante % no encontrada en el tenant del movimiento: no se puede verificar el movimiento',
      NEW.variant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- La FK `inventory_lots.variant_id` no evalúa RLS: hoy un lote puede
  -- apuntar a una variante de otro tenant (hallazgo de la revisión de B09,
  -- queda para WP-B08b). Ese lote es un dato corrupto, y falla cerrado:
  -- ningún movimiento suyo pasa. Sin el filtro, el rechazo de abajo
  -- revelaría si una variante ajena es sellada.
  SELECT v.variant_type INTO v_lot_type
    FROM app.product_variants v
   WHERE v.id = v_lot_variant
     AND v.tenant_id = NEW.tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Variante del lote % no encontrada en el tenant del movimiento: no se puede verificar el movimiento',
      NEW.lot_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- `status` y `variant_type` son NOT NULL y los tres "no encontrado" ya se
  -- rechazaron: la comparación nunca ve un NULL.
  IF NEW.movement_type = 'sale'
     AND v_status = 'open_for_decant'
     AND 'sealed' IN (v_lot_type, v_declared_type) THEN
    RAISE EXCEPTION
      'El lote % está abierto para decantar: no puede venderse como sellado',
      NEW.lot_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- Las capas de costo cuadran con el movimiento (invariante 13, diferida)
-- + movimiento y lote del tenant de la capa.
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
    RAISE EXCEPTION
      'Capas de costo del movimiento % no cuadran: asignado=% declarado=%',
      NEW.movement_id, v_alloc, COALESCE(abs(v_declared), 0)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------
-- Todo asiento cuadra (invariante 7, diferida).
--
-- No busca el asiento: la decisión (debe = haber) se toma solo sobre las
-- líneas, y con SECURITY DEFINER las ve todas. Es la única de estas
-- funciones que no filtra por tenant, a propósito: `entry_id` es un uuid
-- globalmente único, y `guard_posted_journal` (0017) ya impuso antes del
-- INSERT/UPDATE que toda línea sea del tenant de su asiento. Un filtro por
-- el tenant de la línea que dispara no agregaría nada. Que el asiento no exista
-- no es falta de visibilidad sino un borrado en cascada, donde las líneas
-- también se fueron y la suma da 0 = 0. Que una línea sea del tenant de
-- su asiento lo impone `guard_posted_journal` (0017) antes de insertarla.
--
-- Un UPDATE que cambia `entry_id` verifica los DOS asientos. La versión de
-- 0007 miraba `COALESCE(NEW.entry_id, OLD.entry_id)`, que en un UPDATE es
-- NEW: mover una línea de un borrador a otro dejaba descuadrado el de
-- origen sin que nada lo notara (mismo defecto que el punto 4 de 0017).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE
  v_entry  uuid;
  v_debit  numeric;
  v_credit numeric;
BEGIN
  FOR v_entry IN
    SELECT OLD.entry_id WHERE TG_OP <> 'INSERT'
    UNION
    SELECT NEW.entry_id WHERE TG_OP <> 'DELETE'
  LOOP
    SELECT COALESCE(sum(jl.debit_pyg), 0), COALESCE(sum(jl.credit_pyg), 0)
      INTO v_debit, v_credit
      FROM app.journal_lines jl
     WHERE jl.entry_id = v_entry;

    IF v_debit <> v_credit THEN
      RAISE EXCEPTION
        'Asiento % descuadrado: debe=% haber=% (diferencia %)',
        v_entry, v_debit, v_credit, v_debit - v_credit
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
