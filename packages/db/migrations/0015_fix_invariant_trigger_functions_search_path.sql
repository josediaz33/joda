-- =====================================================================
-- 0015_fix_invariant_trigger_functions_search_path.sql
--
-- Mismo defecto que 0012_fix_staff_login_lookup_param_type.sql: `joda_api`
-- no tiene `app` en su `search_path` por defecto (solo `"$user", public"`;
-- cada migración lo fija con `SET search_path = app, public;` para SU
-- PROPIA sesión, pero eso no persiste para la conexión real de la API).
--
-- Acá el síntoma es distinto: las seis funciones de disparador de
-- 0009_invariants.sql (todas `LANGUAGE plpgsql`, ninguna con
-- `SET search_path` propio) referencian tablas y un enum del esquema `app`
-- SIN calificar (`inventory_balances`, `inventory_lots`,
-- `movement_cost_allocations`, `inventory_movements`, `journal_entries`,
-- el tipo `uom`, `lot_status`, `variant_type`, `journal_status`). Postgres
-- compila el cuerpo de una función plpgsql la PRIMERA vez que corre en
-- cada sesión/conexión, resolviendo esos nombres con el `search_path` de
-- ESA conexión — para `joda_api` eso falla con `type "uom" does not
-- exist` (42704) o `relation "inventory_balances" does not exist`
-- (42P01) en cuanto el disparador corre de verdad por primera vez, sin
-- importar qué tan bien calificada esté la sentencia que lo dispara
-- (probado: ni casteando el valor al enum en el INSERT, ni evitando el
-- cast del todo, ni pasando `uom` por sub-SELECT desde una columna ya
-- tipada correctamente, cambia nada — el fallo está adentro del cuerpo de
-- la función, no en la sentencia que la invoca).
--
-- `packages/db/tests/invariants.sql` nunca lo detectó porque ese script
-- fija su propio `search_path = app, public` al principio (línea 6), así
-- que el compilado ahí SIEMPRE ve `app` — solo la conexión real de la
-- API, que nunca hace ese `SET`, lo sufre. Encontrado al escribir la
-- integración de WP-C10 (RF-INV-04): un ajuste de inventario no lograba
-- insertar el movimiento porque `assert_movement_uom` (dispara en TODO
-- INSERT sobre `inventory_movements`, valida RN-LOT-01) nunca llegaba a
-- ejecutar su lógica real; despejado ese, `project_lot_balance` (la
-- proyección del saldo, ADR-007) fallaba con el mismo patrón.
--
-- Fix, igual que 0012: `SET search_path = app, public` en la firma de
-- cada función — la vuelve independiente del search_path de quien la
-- invoque. Corregidas las SEIS funciones de 0009_invariants.sql en el
-- mismo paso, no solo las dos que bloqueaban a esta sesión: mismo archivo,
-- mismo patrón exacto, mismo fix mecánico — dejar la mitad ya diagnosticada
-- esperando a que WP-C11/C13/C19/C22 la redescubra desde cero (son,
-- respectivamente, quienes primero insertan un lote, ejecutan un
-- fraccionamiento, confirman una venta o contabilizan un asiento a través
-- de `joda_api` real) es peor que corregirla ahora que ya está a la vista.
-- No se tocó ninguna función fuera de este archivo (por ejemplo
-- `assert_entry_balanced` de 0007_accounting.sql tiene la misma forma) —
-- esas quedan señaladas en el PR de WP-C10, no corregidas de paso: esta
-- migración es específicamente el radio de 0009_invariants.sql.
-- =====================================================================
SET search_path = app, public;

CREATE OR REPLACE FUNCTION app.guard_posted_journal() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, public AS $$
DECLARE v_status journal_status;
BEGIN
  SELECT status INTO v_status
    FROM journal_entries WHERE id = COALESCE(NEW.entry_id, OLD.entry_id);
  IF v_status = 'posted' THEN
    RAISE EXCEPTION
      'El asiento ya está contabilizado: no se modifica, se reversa'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION app.init_lot_balance() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, public AS $$
BEGIN
  INSERT INTO inventory_balances (lot_id, tenant_id, variant_id, on_hand)
  VALUES (NEW.id, NEW.tenant_id, NEW.variant_id, 0);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app.project_lot_balance() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, public AS $$
BEGIN
  UPDATE inventory_balances
     SET on_hand = on_hand + NEW.qty,
         updated_at = now()
   WHERE lot_id = NEW.lot_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe fila de saldo para el lote %', NEW.lot_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app.assert_movement_uom() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, public AS $$
DECLARE v_lot_uom uom;
BEGIN
  SELECT uom INTO v_lot_uom FROM inventory_lots WHERE id = NEW.lot_id;
  IF v_lot_uom IS DISTINCT FROM NEW.uom THEN
    RAISE EXCEPTION
      'Unidad de medida incompatible: el lote está en % y el movimiento en %',
      v_lot_uom, NEW.uom
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.assert_cost_allocation_matches() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, public AS $$
DECLARE
  v_mov     bigint := NEW.movement_id;
  v_alloc   bigint;
  v_declared bigint;
BEGIN
  SELECT COALESCE(sum(total_cost_pyg), 0) INTO v_alloc
    FROM movement_cost_allocations WHERE movement_id = v_mov;
  SELECT COALESCE(abs(total_cost_pyg), 0) INTO v_declared
    FROM inventory_movements WHERE id = v_mov;

  IF v_alloc <> v_declared THEN
    RAISE EXCEPTION
      'Capas de costo del movimiento % no cuadran: asignado=% declarado=%',
      v_mov, v_alloc, v_declared
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app.assert_sealed_lot_not_open() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, public AS $$
DECLARE
  v_status lot_status;
  v_type   variant_type;
BEGIN
  IF NEW.movement_type <> 'sale' THEN RETURN NEW; END IF;

  SELECT l.status, v.variant_type INTO v_status, v_type
    FROM inventory_lots l
    JOIN product_variants v ON v.id = NEW.variant_id
   WHERE l.id = NEW.lot_id;

  IF v_type = 'sealed' AND v_status = 'open_for_decant' THEN
    RAISE EXCEPTION
      'El lote % está abierto para decantar: no puede venderse como sellado',
      NEW.lot_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
