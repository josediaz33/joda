-- =====================================================================
-- 0034_write_permissions_children_ledger.sql  (WP-B11d)
--
-- DEFECTO. B11 puso permiso de escritura en las tablas de cabecera, pero
-- dejó sin él a las que cuelgan de ellas y al ledger. Como vendedor, hoy
-- funcionan: `UPDATE purchase_order_lines SET unit_price_minor = 1`; un
-- `INSERT` de tipo `adjustment` de +5 sobre un lote en `inventory_movements`
-- (el libro de stock, con un permiso que el vendedor no tiene); y borrar una
-- venta, que desengancha su seña (`customer_deposits.sale_order_id ON DELETE
-- SET NULL`). Cada tabla tenía una única permisiva `tenant_access` FOR ALL
-- con `true` (0014): escribir pedía solo tenant. Y `purchase_order_lines`
-- se podía LEER sin permiso: el vendedor veía los precios de compra, aunque
-- `purchase_orders` exige `market.purchase_order:read` (revisión cruzada).
--
-- CORRECCIÓN. Esa permisiva se reemplaza, en cada tabla, por una política por
-- comando (nunca `FOR ALL`). `tenant_isolation` (RESTRICTIVE, 0016) sigue
-- combinándose con AND contra todas: tenant Y permiso. El SELECT sigue por
-- tenant (`tenant_access_select` con `true`) salvo en `purchase_order_lines`,
-- que desde esta migración exige `market.purchase_order:read`. `has_permission`
-- exige sesión de staff, así que una audiencia `system` (un webhook de pago)
-- no escribe en estas tablas por esta vía; ver "QUÉ QUEDA FUERA".
--
--   tabla                  SELECT      INSERT                  UPDATE                   DELETE
--   ---------------------  ----------  ----------------------  -----------------------  ------------------------
--   inventory_movements    tenant      según `movement_type`   nadie (ledger)           nadie (ledger)
--   purchase_order_lines   po:read     po:write, orden draft   po:write, approve        po:write, orden draft
--                                                              o receive
--   goods_receipts         tenant      po:receive              po:receive               nadie
--   goods_receipt_lines    tenant      po:receive              po:receive               nadie
--   sale_orders            tenant      solo tenant (*)         solo tenant (*)          sales.order:write y draft
--
--   po = market.purchase_order. (*) Ver "QUÉ QUEDA FUERA".
--
-- inventory_movements. La política de INSERT mira `movement_type`, que es lo
-- único que distingue qué operación está haciendo quien escribe (los
-- permisos son por operación, ADR-016):
--
--   sale                                      sales.order:write
--   adjustment                                inventory.stock:adjust
--   decant_consumption, decant_yield,
--     bom_consumption, waste                  inventory.decant:execute
--   transfer_in, transfer_out                 inventory.decant:execute
--   purchase_receipt                          market.purchase_order:receive
--   return_in                                 sales.order:refund
--   return_out                                market.purchase_order:write
--
-- Decisiones de José (2026-10-01) sobre los dos casos que el mapeo dejaba
-- abiertos. (1) `return_out` es la devolución a un proveedor: es compras y
-- genera un crédito, no ventas, así que va con `market.purchase_order:write` y
-- no con `sales.order:refund`. (2) Los `transfer_*` son los de la apertura de
-- frasco y de la separación previa (WP-C11) y van con `inventory.decant:execute`.
-- No se distinguen por `movement_type` sino por `reference_type`, que es texto
-- libre: si la política dependiera de él, alcanzaría con escribir otro texto.
-- Por eso el CHECK `movement_transfer_reference_type`: en un `transfer_*`,
-- `reference_type` solo puede ser `lot_separation` o `lot_opening`. El día que
-- exista otro tipo de transferencia, se agrega a propósito, con una migración.
-- El CHECK rechaza también un `reference_type` NULL (falla cerrado: un `IN`
-- con NULL da NULL y el CHECK lo dejaría pasar).
--
-- La política falla cerrado: un valor de `movement_type` que se agregue al enum
-- y no figure acá no coincide con ninguna rama y se rechaza hasta que se lo
-- mapee a propósito. UPDATE y DELETE no tienen política: el ledger es
-- append-only y `joda_api` ya no tiene esos privilegios (0010, 0009).
--
-- purchase_order_lines. Con los permisos de `purchase_orders` (0030):
--   · SELECT con `market.purchase_order:read`.
--   · INSERT y DELETE con `:write` Y con la orden padre en `draft`
--     (EXISTS sobre `purchase_orders`). Es la misma premisa que la política de
--     DELETE de la orden ("nunca enviada", sostenida por `trg_po_no_return_to_
--     draft`, 0031): sin ella, quien tenía `:write` borraba las líneas de una
--     orden ya enviada y dejaba una orden vacía, lo que el DELETE de la
--     cabecera no permite (revisión cruzada). Una vez enviada, las líneas no
--     se agregan ni se quitan.
--   · UPDATE con `:write`, `:approve` o `:receive`, porque la recepción
--     actualiza `qty_received`; queda abierto en cualquier estado. Si el
--     precio o la cantidad pedida pueden cambiar después de enviar la orden,
--     es una decisión de WP-C15 (anotada en su fila): la base pone el piso.
-- El EXISTS lee `purchase_orders` bajo RLS, así que exige que quien escribe
-- pueda leer la orden (`market.purchase_order:read`): es la trampa de la
-- lectura, y el invariante 94 la verifica para los roles sembrados.
--
-- goods_receipts y goods_receipt_lines. `market.purchase_order:receive` para
-- INSERT y UPDATE. SIN DELETE, igual que los lotes: son documentos con costos
-- reales (flete, aduana) de los que cuelgan lotes y asientos. Una recepción
-- se cancela con su estado (`receipt_status` tiene `cancelled`). Esta decisión
-- no estaba escrita en la fila de WP-B11d; es la más conservadora y se
-- relaja con una migración si C15 la necesita.
--
-- sale_orders. DELETE solo con `sales.order:write` y solo en borrador, con el
-- estado dentro de la política. Que `draft` signifique "nunca confirmada" lo
-- sostiene `trg_so_no_return_to_draft`, `BEFORE UPDATE OF status`: se entra a
-- `draft` solo desde `draft`. Es el mismo criterio de ADR-026 que la guarda de
-- la orden de compra (0031): la política de DELETE lee `draft` como premisa, y
-- volver a ese estado desde `paid` o `cancelled` la desarmaría (un UPDATE a
-- `draft` y un DELETE borrarían una venta cobrada y desengancharían su seña).
-- `SALE_ORDER_TRANSITIONS` (`packages/domain/src/sales/order.ts`) no tiene
-- ninguna arista hacia `draft`, y `awaiting_payment` solo se alcanza desde
-- `draft`, así que a diferencia de la orden de compra no hay un análogo de
-- `pending_approval` que cubrir: la guarda es "entrar a `draft` solo desde
-- `draft`" y no agrega ninguna arista entre estados distintos. Una venta se
-- anula por reversión (RN-VTA-03), no se borra. Lee solo OLD y NEW, falla
-- cerrado por lista blanca, no es SECURITY DEFINER (el invariante 29 la admite
-- por nombre) y fija `search_path = app, pg_temp`.
--
-- customer_deposits.sale_order_id. Pasa de `ON DELETE SET NULL` a `ON DELETE
-- RESTRICT`. Una seña existe ANTES del cobro (la FK es opcional justamente
-- para atarla a un pedido), así que un borrador puede tener una enganchada, y
-- borrarlo la desengancha en silencio: el mismo defecto que esta migración
-- cierra para las ventas cobradas, en el caso que la premisa "un borrador no
-- tiene seña" no cubría (revisión cruzada). Con RESTRICT, para borrar el
-- borrador hay que desvincular la seña a propósito; el DELETE da 23503, y la
-- API lo traduce a un mensaje que lo dice (`errorMapper.ts`). Es la única FK
-- hacia `sale_orders` con SET NULL; las demás ya son RESTRICT o CASCADE hacia
-- tablas que no tienen plata.
--
-- LA TRAMPA DE LA LECTURA no aplica a las tablas cuyo SELECT es por tenant:
-- ni `INSERT ... RETURNING` ni `UPDATE ... WHERE` dependen de otro permiso. Sí
-- aplica a `purchase_order_lines`, cuya lectura ahora exige
-- `market.purchase_order:read`: quien escribe líneas sin poder leerlas recibe
-- 42501 en el INSERT ... RETURNING y cero filas en un UPDATE o DELETE con
-- WHERE. En los roles sembrados, todo permiso de escritura de las líneas
-- viene con ese de lectura, con una excepción registrada: el depósito
-- (`:receive` sin `:read`), que desde esta migración deja de ver las líneas de
-- la orden que recibe. Cómo recibe sin ver precios es de WP-C15, que ya tenía
-- la excepción anotada (invariante 94).
--
-- QUÉ QUEDA FUERA, cada uno con su destino en `docs/backlog.md`.
-- (1) INSERT y UPDATE de `sale_orders` siguen solo por tenant: un pago
-- confirmado por un webhook (audiencia `system`) los escribe, y
-- `has_permission` exige staff; hay que definir primero ese camino (WP-G13).
-- Lo mismo vale ahora para los movimientos `sale` que genera esa confirmación:
-- con esta migración un contexto `system` no los inserta. (2) Las demás tablas
-- de la venta (`sale_order_lines`, `payments`, ...) siguen solo por tenant
-- (WP-G13). (3) `movement_cost_allocations`, las capas de costo de cada salida,
-- sigue solo por tenant en INSERT: WP-B11e. (4) La lectura de
-- `goods_receipt_lines` (precio unitario y flete prorrateado) sigue por tenant:
-- WP-C15, que define qué ve el depósito al recibir.
--
-- Esta migración agrega un CHECK y un trigger y cambia la acción de una FK;
-- no cambia columnas.
-- =====================================================================
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- inventory_movements
-- ---------------------------------------------------------------------
ALTER TABLE app.inventory_movements
  ADD CONSTRAINT movement_transfer_reference_type CHECK (
    movement_type NOT IN ('transfer_in', 'transfer_out')
    OR (reference_type IS NOT NULL
        AND reference_type IN ('lot_separation', 'lot_opening'))
  );

DROP POLICY tenant_access ON app.inventory_movements;

CREATE POLICY tenant_access_select ON app.inventory_movements
  FOR SELECT USING (true);
CREATE POLICY movements_insert ON app.inventory_movements
  FOR INSERT WITH CHECK (
    (movement_type = 'sale'
       AND app.has_permission('sales.order:write'))
    OR (movement_type = 'adjustment'
       AND app.has_permission('inventory.stock:adjust'))
    OR (movement_type IN ('decant_consumption', 'decant_yield', 'bom_consumption',
                          'waste', 'transfer_in', 'transfer_out')
       AND app.has_permission('inventory.decant:execute'))
    OR (movement_type = 'purchase_receipt'
       AND app.has_permission('market.purchase_order:receive'))
    OR (movement_type = 'return_in'
       AND app.has_permission('sales.order:refund'))
    OR (movement_type = 'return_out'
       AND app.has_permission('market.purchase_order:write')));

-- ---------------------------------------------------------------------
-- purchase_order_lines
-- ---------------------------------------------------------------------
DROP POLICY tenant_access ON app.purchase_order_lines;

CREATE POLICY po_lines_read ON app.purchase_order_lines
  FOR SELECT USING (app.has_permission('market.purchase_order:read'));
CREATE POLICY po_lines_insert ON app.purchase_order_lines
  FOR INSERT WITH CHECK (
    app.has_permission('market.purchase_order:write')
    AND EXISTS (SELECT 1 FROM app.purchase_orders po
                 WHERE po.id = purchase_order_lines.purchase_order_id
                   AND po.status = 'draft'));
CREATE POLICY po_lines_update ON app.purchase_order_lines
  FOR UPDATE USING (
    app.has_permission('market.purchase_order:write')
    OR app.has_permission('market.purchase_order:approve')
    OR app.has_permission('market.purchase_order:receive'))
  WITH CHECK (
    app.has_permission('market.purchase_order:write')
    OR app.has_permission('market.purchase_order:approve')
    OR app.has_permission('market.purchase_order:receive'));
CREATE POLICY po_lines_delete ON app.purchase_order_lines
  FOR DELETE USING (
    app.has_permission('market.purchase_order:write')
    AND EXISTS (SELECT 1 FROM app.purchase_orders po
                 WHERE po.id = purchase_order_lines.purchase_order_id
                   AND po.status = 'draft'));

-- ---------------------------------------------------------------------
-- goods_receipts y goods_receipt_lines
-- ---------------------------------------------------------------------
DROP POLICY tenant_access ON app.goods_receipts;

CREATE POLICY tenant_access_select ON app.goods_receipts
  FOR SELECT USING (true);
CREATE POLICY receipts_insert ON app.goods_receipts
  FOR INSERT WITH CHECK (app.has_permission('market.purchase_order:receive'));
CREATE POLICY receipts_update ON app.goods_receipts
  FOR UPDATE USING (app.has_permission('market.purchase_order:receive'))
  WITH CHECK (app.has_permission('market.purchase_order:receive'));

DROP POLICY tenant_access ON app.goods_receipt_lines;

CREATE POLICY tenant_access_select ON app.goods_receipt_lines
  FOR SELECT USING (true);
CREATE POLICY receipt_lines_insert ON app.goods_receipt_lines
  FOR INSERT WITH CHECK (app.has_permission('market.purchase_order:receive'));
CREATE POLICY receipt_lines_update ON app.goods_receipt_lines
  FOR UPDATE USING (app.has_permission('market.purchase_order:receive'))
  WITH CHECK (app.has_permission('market.purchase_order:receive'));

-- ---------------------------------------------------------------------
-- sale_orders
-- ---------------------------------------------------------------------
DROP POLICY tenant_access ON app.sale_orders;

CREATE POLICY tenant_access_select ON app.sale_orders
  FOR SELECT USING (true);
CREATE POLICY tenant_access_insert ON app.sale_orders
  FOR INSERT WITH CHECK (true);
CREATE POLICY tenant_access_update ON app.sale_orders
  FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY sales_delete ON app.sale_orders
  FOR DELETE USING (app.has_permission('sales.order:write') AND status = 'draft');

-- La seña existe antes del cobro: borrar un borrador no la desengancha en
-- silencio. Misma FK compuesta de 0023, con otra acción.
ALTER TABLE app.customer_deposits
  DROP CONSTRAINT customer_deposits_sale_order_id_fkey;
ALTER TABLE app.customer_deposits
  ADD CONSTRAINT customer_deposits_sale_order_id_fkey
  FOREIGN KEY (sale_order_id, tenant_id) REFERENCES app.sale_orders (id, tenant_id)
  ON DELETE RESTRICT;

CREATE FUNCTION app.guard_so_no_return_to_draft() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
BEGIN
  IF NEW.status = 'draft' AND OLD.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION
      'El pedido % está en % y no puede volver a draft (un estado previo a la confirmación): un pedido borrador es uno que nunca se confirmó',
      OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_so_no_return_to_draft
  BEFORE UPDATE OF status ON app.sale_orders
  FOR EACH ROW EXECUTE FUNCTION app.guard_so_no_return_to_draft();
