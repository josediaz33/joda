-- =====================================================================
-- 0023_cross_tenant_fks.sql  (WP-B08c)
--
-- DEFECTO 1 · UNA FK NO EVALÚA RLS. Hasta acá, toda FK entre dos tablas
-- con `tenant_id` verificaba que la fila apuntada EXISTE, no que sea del
-- mismo tenant. Reproducido en la revisión de B09: un staff del tenant A
-- creaba un lote suyo con `variant_id` o `parent_lot_id` del tenant B. El
-- inventario completo (103 FKs de una columna entre tablas con
-- `tenant_id`) sale de `pg_constraint`; la lista literal, con prueba de
-- completitud, vive en `test/integration/cross_tenant_fks.test.ts`.
--
-- CORRECCIÓN · FK COMPUESTAS. Cada una de esas FKs se REEMPLAZA por
-- `(col, tenant_id) REFERENCES destino (id, tenant_id)`, con el mismo
-- nombre y la misma acción ON DELETE. Declarativa, sin triggers y falla
-- cerrado por construcción: la fila apuntada tiene que existir EN EL
-- TENANT DE LA FILA. Con `col` NULL no se verifica nada (MATCH SIMPLE),
-- que es lo correcto: no hay referencia.
--   · Cada destino recibe `UNIQUE (id, tenant_id)`, que Postgres exige
--     para ser referenciado así. Es redundante con la PK, y cuesta un
--     índice por tabla destino.
--   · Se reemplazan en vez de agregarse al lado: con dos FKs entre el
--     mismo par de tablas, `prisma db pull` renombra los campos de
--     relación (`perfume_details_perfume_details_product_idToproducts`
--     es eso) y la API deja de compilar. Reemplazadas, cada par conserva
--     una sola relación y su nombre.
--   · ON DELETE SET NULL pasa a `SET NULL (col)` (PG15+): sin la lista de
--     columnas, borrar el destino pondría en NULL también `tenant_id`.
--   · Las FKs de varias columnas (`(product_id, kind)` de las tres tablas
--     de detalle) no se tocan: cada una tiene al lado su FK de una columna
--     sobre `product_id`, que sí se reemplaza.
--   · ON UPDATE queda NO ACTION: una fila apuntada no puede cambiar de
--     tenant mientras algo la referencie.
-- El invariante 67 falla si aparece una FK entre tablas con `tenant_id`
-- que no incluya `tenant_id`.
--
-- DEFECTO 2 · LA VARIANTE DE UN MOVIMIENTO ES LA QUE DECLARA QUIEN
-- INSERTA. Fue la puerta del bloqueante de B09: una venta sobre un lote
-- sellado abierto declarando la variante de granel. B09 lo cerró en el
-- trigger mirando las dos variantes; ahora además no pueden diferir.
-- CORRECCIÓN: la FK de `inventory_movements.lot_id` es
-- `(lot_id, variant_id, tenant_id) REFERENCES inventory_lots
-- (id, variant_id, tenant_id)`. Subsume la de tenant. Todos los
-- movimientos existentes (smoke, C10) ya usan la variante de su lote.
-- Efecto lateral buscado: un lote con movimientos ya no cambia de variante.
--
-- DEFECTO 3 · RN-LOT-03 RESTRINGÍA SOLO `sale`. Sobre un lote sellado
-- abierto con saldo, un `waste` o un `adjustment` sacaban frascos
-- sellados. Pregunta de la revisión de B09, decidida por José
-- (2026-09-25): un lote sellado en `open_for_decant` es TERMINAL.
-- CORRECCIÓN:
--   · `assert_sealed_lot_not_open` rechaza cualquier movimiento sobre un
--     lote sellado en `open_for_decant`, no solo `sale`. El granel hijo
--     también está en `open_for_decant`, pero no es sellado: se mueve.
--     La apertura (RN-LOT-02) saca la unidad ANTES de cambiar el estado,
--     así que no choca con esto.
--   · Trigger nuevo `trg_sealed_lot_terminal` sobre `inventory_lots`: un
--     lote sellado en `open_for_decant` no cambia de estado. Sin esto, la
--     regla de arriba se eludía con un UPDATE del estado a `available`
--     (hoy cualquier staff del tenant puede escribir `inventory_lots`,
--     hasta WP-B11). Es una transición impuesta en la base: ADR-017, tercera
--     excepción anotada, con su criterio (un frasco abierto no se
--     desabre; caso borde 5).
-- Las dos funciones son SECURITY DEFINER con `search_path = app, pg_temp`
-- y fallan cerrado, como las de 0018.
-- =====================================================================
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- 1. Inventario y reemplazo de las FKs entre tablas con tenant_id.
-- ---------------------------------------------------------------------
CREATE TEMP TABLE b08c_fks ON COMMIT DROP AS
SELECT c.conname,
       c.conrelid::regclass  AS child,
       c.confrelid::regclass AS target,
       tg.relname            AS target_name,
       a.attname             AS col,
       ra.attname            AS refcol,
       c.confdeltype
  FROM pg_constraint c
  JOIN pg_class ch     ON ch.oid = c.conrelid
  JOIN pg_class tg     ON tg.oid = c.confrelid
  JOIN pg_attribute a  ON a.attrelid  = c.conrelid  AND a.attnum  = c.conkey[1]
  JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = c.confkey[1]
 WHERE c.contype = 'f'
   AND c.connamespace = 'app'::regnamespace
   AND cardinality(c.conkey) = 1
   AND a.attname <> 'tenant_id'
   AND EXISTS (SELECT 1 FROM pg_attribute x
                WHERE x.attrelid = c.conrelid AND x.attname = 'tenant_id' AND NOT x.attisdropped)
   AND EXISTS (SELECT 1 FROM pg_attribute x
                WHERE x.attrelid = c.confrelid AND x.attname = 'tenant_id' AND NOT x.attisdropped);

-- Destino de la FK movimiento → lote con su variante (defecto 2).
ALTER TABLE app.inventory_lots
  ADD CONSTRAINT inventory_lots_id_variant_tenant_key UNIQUE (id, variant_id, tenant_id);

DO $$
DECLARE
  r        record;
  v_n      int;
  v_action text;
BEGIN
  SELECT count(*) INTO v_n FROM b08c_fks;
  -- El inventario escrito del test tiene 103. Si la cuenta cambia, alguien
  -- agregó una FK antes de esta migración sin actualizar el inventario.
  IF v_n <> 103 THEN
    RAISE EXCEPTION 'WP-B08c: se esperaban 103 FKs entre tablas con tenant_id, hay %', v_n;
  END IF;

  FOR r IN SELECT DISTINCT target, target_name, refcol FROM b08c_fks ORDER BY target_name LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I UNIQUE (%I, tenant_id)',
                   r.target, r.target_name || '_' || r.refcol || '_tenant_key', r.refcol);
  END LOOP;

  -- DROP + ADD con el mismo nombre dentro de la misma transacción: no hay
  -- ventana sin FK.
  FOR r IN SELECT * FROM b08c_fks ORDER BY child::text, col LOOP
    v_action := CASE r.confdeltype
                  WHEN 'c' THEN 'CASCADE'
                  WHEN 'r' THEN 'RESTRICT'
                  WHEN 'n' THEN format('SET NULL (%I)', r.col)
                  WHEN 'd' THEN format('SET DEFAULT (%I)', r.col)
                  ELSE 'NO ACTION'
                END;
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.child, r.conname);
    IF r.child = 'app.inventory_movements'::regclass AND r.col = 'lot_id' THEN
      -- Defecto 2: el lote y la variante del movimiento, juntos.
      EXECUTE format(
        'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (lot_id, variant_id, tenant_id)
           REFERENCES app.inventory_lots (id, variant_id, tenant_id) ON DELETE %s',
        r.child, r.conname, v_action);
    ELSE
      EXECUTE format(
        'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I, tenant_id)
           REFERENCES %s (%I, tenant_id) ON DELETE %s',
        r.child, r.conname, r.col, r.target, r.refcol, v_action);
    END IF;
  END LOOP;
END $$;

-- Las cuatro relaciones uno a uno (la PK de la tabla hija es la columna de
-- la FK: tablas de detalle e inventory_balances) hacen fallar
-- `prisma generate` con P1012. No se resuelve acá con un UNIQUE redundante,
-- que Prisma ignora por contener al @id, sino en
-- scripts/patch-prisma-schema.mjs (hallazgo 4 de packages/db/README.md).

-- ---------------------------------------------------------------------
-- 2. RN-LOT-03 extendida: un lote sellado abierto no admite movimientos.
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

  -- Desde 0023 la FK compuesta impide que un lote apunte a una variante
  -- ajena y que el movimiento declare otra variante que la del lote. Se
  -- sigue buscando la variante del lote por separado, en el tenant del
  -- movimiento, y fallando cerrado: el trigger corre ANTES que las FKs
  -- (que son AFTER), y no depende de ellas.
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

  -- RN-LOT-03 (extendida en WP-B08c): cualquier movimiento, no solo sale.
  IF v_status = 'open_for_decant'
     AND 'sealed' IN (v_lot_type, v_declared_type) THEN
    RAISE EXCEPTION
      'El lote % está abierto para decantar: un sellado abierto no admite movimientos',
      NEW.lot_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- 3. Un lote sellado en open_for_decant no cambia de estado.
-- ---------------------------------------------------------------------
CREATE FUNCTION app.guard_sealed_lot_terminal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE
  v_type app.variant_type;
BEGIN
  IF OLD.status <> 'open_for_decant' OR NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  -- La variante de la fila VIEJA, en su tenant: es la que decide si el
  -- lote era un sellado abierto.
  SELECT v.variant_type INTO v_type
    FROM app.product_variants v
   WHERE v.id = OLD.variant_id
     AND v.tenant_id = OLD.tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Variante del lote % no encontrada en su tenant: no se puede verificar el cambio de estado',
      OLD.id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_type = 'sealed' THEN
    RAISE EXCEPTION
      'El lote % es un sellado abierto para decantar: su estado es terminal',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_sealed_lot_terminal
  BEFORE UPDATE OF status ON app.inventory_lots
  FOR EACH ROW EXECUTE FUNCTION app.guard_sealed_lot_terminal();
