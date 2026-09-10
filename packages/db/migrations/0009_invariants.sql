-- =====================================================================
-- 0009_invariants.sql
--
-- LÍNEA DE DISEÑO: la base de datos hace cumplir INVARIANTES.
-- La aplicación calcula DECISIONES.
--
-- Nada de lógica de negocio en triggers: acá no se decide qué lote
-- consumir, ni cómo prorratear un flete, ni qué asiento generar. Eso vive
-- en packages/domain. Lo que sí vive acá es aquello que debe seguir siendo
-- cierto incluso si alguien abre psql a las dos de la mañana.
-- =====================================================================
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- 1. El ledger es inmutable
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_movements_immutable
  BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only();

CREATE TRIGGER trg_cost_alloc_immutable
  BEFORE UPDATE OR DELETE ON movement_cost_allocations
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only();

CREATE TRIGGER trg_audit_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only();

CREATE TRIGGER trg_fiscal_events_immutable
  BEFORE UPDATE OR DELETE ON fiscal_events
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only();

CREATE TRIGGER trg_po_transitions_immutable
  BEFORE UPDATE OR DELETE ON purchase_order_transitions
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only();

CREATE TRIGGER trg_so_transitions_immutable
  BEFORE UPDATE OR DELETE ON sale_order_transitions
  FOR EACH ROW EXECUTE FUNCTION app.guard_append_only();

-- Un asiento contabilizado no se toca. Se reversa con otro asiento.
CREATE OR REPLACE FUNCTION app.guard_posted_journal() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER trg_journal_lines_posted_guard
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION app.guard_posted_journal();

-- ---------------------------------------------------------------------
-- 2. Proyección de saldos por lote + invariante de no-negatividad
--
-- Esto NO es lógica de negocio: es la materialización de una suma, con la
-- garantía de que el saldo nunca cae por debajo de cero. El CHECK de
-- inventory_balances es lo que convierte una sobreventa en una excepción
-- de base de datos en vez de un número rojo descubierto tres meses después.
-- ---------------------------------------------------------------------
-- HALLAZGO DE IMPLEMENTACIÓN: no se puede usar
--   INSERT ... ON CONFLICT DO UPDATE SET on_hand = on_hand + excluded.on_hand
-- porque PostgreSQL evalúa los CHECK de la fila propuesta ANTES de detectar
-- el conflicto por índice único. La primera salida de un lote insertaría una
-- fila con on_hand negativo y el CHECK abortaría antes de que ON CONFLICT
-- llegara a sumar. La fila de saldo nace, entonces, junto con el lote, y la
-- proyección es siempre un UPDATE puro. Beneficio adicional: elimina la
-- carrera entre dos movimientos concurrentes creando la misma fila.

CREATE OR REPLACE FUNCTION app.init_lot_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO inventory_balances (lot_id, tenant_id, variant_id, on_hand)
  VALUES (NEW.id, NEW.tenant_id, NEW.variant_id, 0);
  RETURN NULL;
END $$;

CREATE TRIGGER trg_init_lot_balance
  AFTER INSERT ON inventory_lots
  FOR EACH ROW EXECUTE FUNCTION app.init_lot_balance();

CREATE OR REPLACE FUNCTION app.project_lot_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER trg_project_balance
  AFTER INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION app.project_lot_balance();

-- Coherencia de unidad: no se pueden mezclar ml y unidades en un lote.
CREATE OR REPLACE FUNCTION app.assert_movement_uom() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER trg_movement_uom
  BEFORE INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION app.assert_movement_uom();

-- ---------------------------------------------------------------------
-- 3. Las capas de costo asignadas cuadran con el costo del movimiento
--    (diferida: las asignaciones se insertan después del movimiento)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_cost_allocation_matches() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE CONSTRAINT TRIGGER trg_cost_allocation_matches
  AFTER INSERT ON movement_cost_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_cost_allocation_matches();

-- ---------------------------------------------------------------------
-- 4. Un lote abierto para decantar no se vende sellado
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_sealed_lot_not_open() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER trg_sealed_lot_guard
  BEFORE INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION app.assert_sealed_lot_not_open();

-- ---------------------------------------------------------------------
-- 5. Vistas derivadas
-- ---------------------------------------------------------------------

-- Disponible = saldo proyectado − reservas vivas.
CREATE VIEW v_stock_available AS
SELECT
  b.tenant_id,
  b.variant_id,
  sum(b.on_hand) AS on_hand,
  COALESCE(r.reserved, 0) AS reserved,
  sum(b.on_hand) - COALESCE(r.reserved, 0) AS available
FROM inventory_balances b
LEFT JOIN LATERAL (
  SELECT sum(sr.qty) AS reserved
    FROM stock_reservations sr
   WHERE sr.variant_id = b.variant_id
     AND sr.released_at IS NULL
     AND sr.expires_at > now()
) r ON true
GROUP BY b.tenant_id, b.variant_id, r.reserved;

-- Verificación de la proyección contra el ledger. La corre un job nocturno:
-- si devuelve filas, algo se escribió por fuera del flujo.
CREATE VIEW v_balance_drift AS
SELECT
  l.id AS lot_id,
  l.tenant_id,
  l.variant_id,
  COALESCE(b.on_hand, 0)      AS projected,
  COALESCE(m.ledger_sum, 0)   AS from_ledger,
  COALESCE(b.on_hand, 0) - COALESCE(m.ledger_sum, 0) AS drift
FROM inventory_lots l
LEFT JOIN inventory_balances b ON b.lot_id = l.id
LEFT JOIN LATERAL (
  SELECT sum(qty) AS ledger_sum FROM inventory_movements WHERE lot_id = l.id
) m ON true
WHERE COALESCE(b.on_hand, 0) <> COALESCE(m.ledger_sum, 0);

-- Rendimiento real de fraccionamiento: merma esperada vs. merma efectiva.
-- Después de unas semanas dice si el waste_factor del 2% era optimista.
CREATE VIEW v_decant_yield AS
SELECT
  wo.tenant_id,
  wo.target_variant_id,
  count(*)                        AS runs,
  sum(wo.ml_expected)             AS ml_expected,
  sum(wo.waste_expected)          AS waste_expected,
  sum(wo.waste_actual)            AS waste_actual,
  CASE WHEN sum(wo.waste_expected) > 0
       THEN round(sum(wo.waste_actual) / sum(wo.waste_expected), 4)
  END                             AS actual_over_expected
FROM decant_work_orders wo
WHERE wo.status = 'done'
GROUP BY wo.tenant_id, wo.target_variant_id;
