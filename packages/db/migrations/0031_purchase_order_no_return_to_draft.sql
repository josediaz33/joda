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
-- LOS DOS ESTADOS PREVIOS A LA APROBACIÓN. Guardar solo la entrada a `draft`
-- dejaba un rodeo de tres pasos: `sent → pending_approval → draft → DELETE`.
-- `pending_approval` es el otro estado en el que la orden todavía no se
-- aprobó, y desde él se llega a `draft`. Por eso la guarda cubre la entrada a
-- los dos: se entra a `draft` o a `pending_approval` solo desde `draft` o
-- `pending_approval`. Es lo que permite la máquina de A08 (a
-- `pending_approval` solo se llega desde `draft`; a `draft`, desde
-- `pending_approval`: una orden devuelta a corregir antes de aprobarse), más
-- las identidades `draft → draft` y `pending_approval → pending_approval`,
-- que un UPDATE que reenvía `status` necesita. La base no agrega ninguna
-- arista entre estados distintos, solo impide las que la máquina nunca tuvo.
-- De `approved` en adelante, rechaza.
--
-- QUÉ NO ES. No es la matriz de transiciones de la orden de compra, que
-- sigue en el dominio (`packages/domain/src/procurement/purchaseOrder.ts`,
-- WP-A08). No hace terminales a `received` y `cancelled`, que ADR-026 deja
-- allí, ni decide qué sigue a qué después de aprobarse. Solo impide volver a
-- los estados previos a la aprobación. Eso sí los alcanza, como
-- consecuencia: para la política de DELETE de 0030, `received → draft →
-- DELETE` desarma la premisa igual que `sent → draft` (invariantes 98 y 99).
--
-- FALLA CERRADO, POR LISTA BLANCA. Se entra a un estado previo a la
-- aprobación solo desde los dos que la guarda nombra; cualquier otro estado
-- de origen rechaza, incluido uno que se agregue al enum más adelante. Lee
-- solo OLD y NEW, ninguna otra tabla, así que no necesita SECURITY DEFINER ni
-- puede decidir sobre algo que RLS le oculte: corre con los privilegios de
-- quien edita y ve exactamente lo que necesita. Compara con `IS DISTINCT
-- FROM` y no con `<>`, que hoy da lo mismo (`status` es NOT NULL) y que
-- seguiría rechazando un NULL si la columna dejara de serlo. Fija
-- `search_path = app, pg_temp` como toda función de disparador de `app.*`
-- (invariante 28). El invariante 29, que exige SECURITY DEFINER a las que
-- leen tablas, la admite por nombre junto a `set_updated_at` y
-- `guard_append_only`: que solo lea OLD y NEW lo afirma este comentario, no
-- lo verifica el invariante.
--
-- `BEFORE UPDATE OF status` dispara aunque el UPDATE no traiga WHERE ni
-- RETURNING, y para toda fila que la política de UPDATE deje pasar: el
-- depósito (`:receive`, sin `:read`) con un `UPDATE purchase_orders SET
-- status = 'draft'` sin WHERE queda frenado en la primera fila que no sea un
-- borrador. Ese caso, con RLS de por medio, lo prueba
-- `write_permissions.test.ts` como `joda_api`. Los invariantes 95-103 corren
-- como superusuario y prueban el trigger en sí, por comportamiento.
-- =====================================================================
SET search_path = app, public;

CREATE FUNCTION app.guard_po_no_return_to_draft() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
BEGIN
  IF NEW.status IN ('draft', 'pending_approval')
     AND OLD.status IS DISTINCT FROM 'draft'
     AND OLD.status IS DISTINCT FROM 'pending_approval' THEN
    RAISE EXCEPTION
      'La orden de compra % está en % y no puede volver a % (un estado previo a la aprobación): antes de aprobarse solo se alterna entre draft y pending_approval',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_po_no_return_to_draft
  BEFORE UPDATE OF status ON app.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION app.guard_po_no_return_to_draft();
