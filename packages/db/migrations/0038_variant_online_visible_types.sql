-- =====================================================================
-- 0038_variant_online_visible_types.sql  (WP-B17, RN-CAT-02)
--
-- DEFECTO. `product_variants.online_visible` es un boolean sin relación con
-- `variant_type`: nada impedía publicar en la tienda un granel (que «no se
-- vende directo», GLOSARIO.md), un insumo o un tester. La única defensa era
-- una normalización de la API (WP-E05): `updateVariant` apagaba el flag de una
-- variante `bulk` cuando alguien la actualizaba. Cubría un tipo de tres, y
-- solo si pasaba por ese procedimiento; un UPDATE directo, el ETL o el
-- procedimiento de publicación que todavía no existe (WP-C08g) lo saltaban.
--
-- CORRECCIÓN. La regla de José (RN-CAT-02): `online_visible` solo en
-- `sealed`, `decant` y `unit`. Es un CHECK sobre el contenido de una fila de
-- una sola tabla, sin lectura de otra: declarativo, no un trigger. AGENTS.md y
-- .claude/rules/database.md reservan los triggers para invariantes; este es de
-- una sola fila, y un CHECK no falla abierto ni se deshabilita (ni con
-- `DISABLE TRIGGER` ni con `session_replication_role`). Se escribe como lista
-- blanca de lo que se puede publicar, no como lista negra de lo que no: un tipo
-- que se agregue al enum `variant_type` queda sin poder publicarse hasta que
-- alguien decida lo contrario. Es el mismo criterio de falla cerrada de los
-- triggers de invariante.
--
-- DATOS ANTERIORES. Antes de agregar el CHECK se apaga el flag en las filas
-- que ya lo violan; si no, `ADD CONSTRAINT` falla y la migración no aplica.
-- No hay camino de la API que las produzca (`onlineVisible` no es un campo de
-- `createVariant` ni de `updateVariant`), pero un UPDATE manual sí pudo
-- dejarlas, y la dirección es la segura: apagar el flag saca la variante de
-- `v_catalog_variants`, no la expone. Es el mismo arreglo que la API hacía al
-- actualizar un granel, ahora para los tres tipos. Se avisa con un NOTICE que
-- lista tenant y SKU de cada variante apagada, para que quien migra pueda
-- reponerlas: `db:migrate` lo imprime (applyMigrations escucha los NOTICE).
-- Corre con la credencial de migraciones, que no evalúa RLS (BYPASSRLS o
-- superusuario), como el retrocompletado de `tenant_id` de 0014. Con un dueño
-- sujeto a FORCE RLS el UPDATE no afectaría filas y el ADD CONSTRAINT abortaría
-- con «violated by some row»: falla ruidosa y la migración entera hace
-- rollback, nunca una fila inválida.
--
-- Qué NO hace: no decide quién ni cuándo publica una variante (RF-CAT-09,
-- WP-C08g); es el techo de lo que ese procedimiento podrá encender.
-- =====================================================================
SET search_path = app, public;

DO $$
DECLARE
  v_apagadas bigint;
  v_detalle  text;
BEGIN
  WITH apagadas AS (
    UPDATE app.product_variants
       SET online_visible = false
     WHERE online_visible
       AND variant_type NOT IN ('sealed', 'decant', 'unit')
    RETURNING tenant_id, sku
  )
  SELECT count(*),
         string_agg(tenant_id::text || '/' || sku::text, ', ' ORDER BY tenant_id, sku)
    INTO v_apagadas, v_detalle
    FROM apagadas;
  IF v_apagadas > 0 THEN
    RAISE NOTICE '0038: % variante(s) tester, supply o bulk tenían online_visible = true y quedaron en false (RN-CAT-02): %',
      v_apagadas, v_detalle;
  END IF;
END $$;

ALTER TABLE app.product_variants
  ADD CONSTRAINT product_variants_online_visible_type_check
  CHECK (NOT online_visible OR variant_type IN ('sealed', 'decant', 'unit'));
