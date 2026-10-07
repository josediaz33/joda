-- =====================================================================
-- 0036_purchase_order_line_no_reparent.sql  (revisión cruzada de WP-B11d, ADR-026)
--
-- DEFECTO. Las políticas de INSERT y DELETE de `purchase_order_lines` (0034)
-- exigen que la orden padre esté en `draft`: sin eso, quien tiene
-- `market.purchase_order:write` vaciaba una orden ya enviada borrándole las
-- líneas. La de UPDATE (`po_lines_update`) no mira el estado de la orden y no
-- limita las columnas: queda abierta a propósito, porque la recepción
-- actualiza `qty_received` y el precio y la cantidad pedida los decide WP-C15.
-- Pero un UPDATE puede cambiar `purchase_order_id`, y con eso se hace lo que el
-- INSERT y el DELETE prohíben: mover la línea de una orden enviada a un
-- borrador la deja VACÍA, y mover una línea de un borrador a una orden enviada
-- le AGREGA una. La revisión cruzada de B11b/c/d lo reprodujo como `joda_api`
-- con los roles `:write`, `:approve`, `:receive` y con el dueño. Ni las
-- pruebas ni los invariantes ejercitaban el cambio de `purchase_order_id`.
--
-- CORRECCIÓN. Una línea pertenece a la orden en la que nació: `purchase_order_id`
-- no cambia. Es una guarda de invariante (ADR-026), no lógica de negocio: la
-- política de INSERT y DELETE de 0034 se apoya en que una línea no cambie de
-- orden, y una política de UPDATE no puede comparar OLD con NEW (su WITH CHECK
-- solo ve la fila nueva). Un trigger sí. Lee solo OLD y NEW, ninguna otra
-- tabla, así que no necesita SECURITY DEFINER ni puede decidir sobre algo que
-- RLS le oculte; fija `search_path = app, pg_temp` como toda función de
-- disparador de `app.*` (invariante 28). El invariante 29 la admite por nombre
-- junto a las demás guardas: que solo lea OLD y NEW lo afirma este comentario,
-- no lo verifica el invariante. Compara con `IS DISTINCT FROM`, y `BEFORE UPDATE
-- OF purchase_order_id` no dispara en los UPDATE que no tocan esa columna (el
-- `qty_received` de la recepción pasa sin costo).
--
-- Vale para toda conexión, incluido el ETL (`service_role`): una línea no se
-- re-parenta, ni siquiera al migrar. No toca `tenant_id`: `tenant_isolation`
-- (RESTRICTIVE, 0016) ya impide mover una línea a otro tenant.
--
-- NOTA SOBRE 0034. El comentario de 0034 y los documentos dicen que la API
-- traduce el 23503 del borrado de un pedido con seña a un mensaje que lo dice.
-- Con el cliente tipado de Prisma eso era falso: el error llegaba como P2003 y
-- `mapPrismaError` no tenía rama para él, así que salía un 500. Se corrige en
-- `errorMapper.ts`, en el mismo PR, con una prueba que borra un pedido de
-- verdad contra Postgres (`errorMapper.integration.test.ts`). 0034 ya está
-- aplicada y no se edita, ni siquiera un comentario.
-- =====================================================================
SET search_path = app, public;

CREATE FUNCTION app.guard_po_line_no_reparent() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
BEGIN
  IF NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id THEN
    RAISE EXCEPTION
      'La línea % pertenece a la orden de compra % y no puede pasar a la orden %: una línea no cambia de orden',
      OLD.id, OLD.purchase_order_id, NEW.purchase_order_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_po_line_no_reparent
  BEFORE UPDATE OF purchase_order_id ON app.purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION app.guard_po_line_no_reparent();
