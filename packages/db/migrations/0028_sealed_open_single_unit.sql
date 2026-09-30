-- =====================================================================
-- 0028_sealed_open_single_unit.sql  (WP-C11)
--
-- DEFECTO · UN SELLADO ABIERTO DE VARIAS UNIDADES. RN-LOT-03 hace terminal
-- a un lote sellado en `open_for_decant`: no admite movimientos ni sale de
-- ese estado (0023). Si un lote nace con tres frascos y se marca abierto
-- entero, los otros dos quedan cerrados, con saldo y sin poder venderse: el
-- caso borde 21 de domain-rules.md. Además, el granel hereda el costo del
-- frasco (RN-LOT-02) y un lote de tres tiene el de tres: el costo por ml
-- sale triplicado y cada decant, con el margen equivocado, sin que nada
-- falle.
--
-- CORRECCIÓN · dos invariantes, los dos declarativos o de falla cerrada:
--
--   1. Un lote de variante SELLADA en `open_for_decant` tiene
--      `qty_initial` = 1. La apertura separa primero la unidad en su propio
--      lote de una unidad (RN-LOT-02, WP-C11) y abre ese. Es un invariante
--      sobre el contenido de una fila, no una transición: sería un CHECK si
--      `variant_type` estuviera en `inventory_lots`. No es una excepción de
--      ninguna regla (ADR-026). Se valida al INSERT y al UPDATE de `status`,
--      `qty_initial` y `variant_id`: nada de eso deja un sellado abierto de
--      varias unidades por el camino.
--      Como un CHECK no ve el tipo de la variante, es un trigger, y como
--      todo trigger de invariante (docs/data-model.md §4.2) es SECURITY
--      DEFINER, fija `search_path = app, pg_temp` y FALLA CERRADO: si no
--      encuentra la variante en el tenant del lote, rechaza. No depende de
--      que otro trigger haya corrido antes.
--
--   2. Un producto tiene A LO SUMO UNA variante de granel. Un producto es
--      un solo líquido aunque se venda en varios tamaños; la apertura
--      necesita saber a qué granel va el frasco, y esa decisión la impone
--      la base, no la búsqueda. Índice único parcial sobre
--      `product_variants (product_id) WHERE variant_type = 'bulk'`.
-- =====================================================================
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- 1. Un sellado abierto es de una sola unidad.
-- ---------------------------------------------------------------------
CREATE FUNCTION app.assert_open_sealed_lot_single_unit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE
  v_type app.variant_type;
BEGIN
  IF NEW.status <> 'open_for_decant' THEN
    RETURN NEW;
  END IF;

  -- La variante de la fila NUEVA, en su tenant: es la que decide si el lote
  -- es un sellado abierto. No encontrarla es motivo de rechazo.
  SELECT v.variant_type INTO v_type
    FROM app.product_variants v
   WHERE v.id = NEW.variant_id
     AND v.tenant_id = NEW.tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Variante del lote % no encontrada en su tenant: no se puede verificar que un sellado abierto sea de una sola unidad',
      NEW.id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_type = 'sealed' AND NEW.qty_initial <> 1 THEN
    RAISE EXCEPTION
      'El lote % es un sellado abierto de % unidades: un sellado abierto tiene una sola unidad (se separa la unidad que se abre)',
      NEW.id, NEW.qty_initial
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_sealed_open_single_unit
  BEFORE INSERT OR UPDATE OF status, qty_initial, variant_id ON app.inventory_lots
  FOR EACH ROW EXECUTE FUNCTION app.assert_open_sealed_lot_single_unit();

-- ---------------------------------------------------------------------
-- 2. Un producto, una variante de granel.
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX product_variants_one_bulk_per_product
  ON app.product_variants (product_id)
  WHERE variant_type = 'bulk';
