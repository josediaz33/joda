-- =====================================================================
-- 0031_purchase_order_no_return_to_draft.sql  (WP-B11, ADR-026)
--
-- DEFECTO. La política de DELETE de `purchase_orders` (0030) lee
-- `status = 'draft'` como PREMISA: un borrador es una orden que nunca salió.
-- Esa premisa no la sostenía nada. La política de UPDATE no mira el estado,
-- así que un rol con `market.purchase_order:write` y `:read` devolvía una
-- orden `approved`, `sent` o `partially_received` a `draft` con un UPDATE y
-- la borraba en una segunda transacción. La revisión cruzada de B11 lo
-- reprodujo. Lo frenaban solo, y por casualidad, `purchase_order_transitions`
-- (append-only: una orden con su transición registrada no se borra) y la FK
-- RESTRICT de `goods_receipts`; una orden sin transición registrada se
-- borraba con sus líneas.
--
-- CRITERIO (ADR-026). La base impone la irreversibilidad de un estado
-- cuando volver atrás desarmaría OTROS invariantes de la base, porque se
-- apoyan en que ese estado no se abandone. Acá sí: la política de DELETE de
-- 0030 es un invariante de la base y se apoya en que `draft` signifique
-- "nunca enviada". Volver a `draft` desde `approved` en adelante la desarma.
-- B11 creó la barrera, y la necesidad de protegerla.
--
-- QUÉ NO ES. No es la matriz de transiciones de la orden de compra, que
-- sigue en el dominio (`packages/domain/src/procurement/purchaseOrder.ts`,
-- WP-A08), ni toca los terminales `received` y `cancelled`, que ADR-026
-- deja allí. Solo guarda la ENTRADA a `draft`: `NEW.status = 'draft'` es
-- válido solo si `OLD.status` es `draft` o `pending_approval`. La segunda
-- arista es la que la máquina de A08 permite: una orden devuelta a corregir
-- antes de aprobarse. De `approved` en adelante, rechaza.
--
-- FALLA CERRADO. Un `OLD.status` que no sea ninguno de los dos valores
-- permitidos (incluido NULL) rechaza: la comparación es `IS DISTINCT FROM`,
-- no `<>`. Lee solo OLD y NEW, ninguna otra tabla, así que no necesita
-- SECURITY DEFINER ni puede decidir sobre algo que RLS le oculte: corre con
-- los privilegios de quien edita y ve exactamente lo que necesita. Fija
-- `search_path = app, pg_temp` como toda función de disparador de `app.*`
-- (invariante 28). El invariante 29, que exige SECURITY DEFINER a las que
-- leen tablas, la admite junto a `set_updated_at` y `guard_append_only`.
--
-- `BEFORE UPDATE OF status` dispara aunque el UPDATE no traiga WHERE ni
-- RETURNING, y para toda fila que la política de UPDATE deje pasar: el
-- depósito (`:receive`, sin `:read`) con un `UPDATE purchase_orders SET
-- status = 'draft'` sin WHERE queda frenado en la primera fila que no sea un
-- borrador. Los invariantes 95-100 lo prueban por comportamiento.
-- =====================================================================
SET search_path = app, public;

CREATE FUNCTION app.guard_po_no_return_to_draft() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
BEGIN
  IF NEW.status = 'draft'
     AND OLD.status IS DISTINCT FROM 'draft'
     AND OLD.status IS DISTINCT FROM 'pending_approval' THEN
    RAISE EXCEPTION
      'La orden de compra % está en % y no puede volver a borrador: solo se vuelve a borrador desde pending_approval',
      OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_po_no_return_to_draft
  BEFORE UPDATE OF status ON app.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION app.guard_po_no_return_to_draft();
