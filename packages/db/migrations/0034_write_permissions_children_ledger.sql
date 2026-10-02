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
-- con `true` (0014): escribir pedía solo tenant.
--
-- CORRECCIÓN. Esa permisiva se reemplaza, en cada tabla, por una política por
-- comando (nunca `FOR ALL`). El SELECT sigue por tenant (`tenant_access_select`
-- con `true`, combinada con la restrictiva `tenant_isolation` de 0016): esta
-- migración no cambia quién lee. `has_permission` exige sesión de staff, así
-- que una audiencia `system` (un webhook de pago) no escribe en estas tablas
-- por esta vía; ver "QUÉ QUEDA FUERA".
--
--   tabla                    INSERT                 UPDATE                  DELETE
--   -----------------------  ---------------------  ----------------------  ---------------------
--   inventory_movements      según `movement_type`  nadie (ledger)          nadie (ledger)
--   purchase_order_lines     purchase_order:write   write, approve, receive purchase_order:write
--   goods_receipts           purchase_order:receive purchase_order:receive  nadie
--   goods_receipt_lines      purchase_order:receive purchase_order:receive  nadie
--   sale_orders              solo tenant (*)        solo tenant (*)         sales.order:write, y
--                                                                           solo en borrador
--
--   (*) Ver "QUÉ QUEDA FUERA".
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
-- purchase_order_lines. Con los permisos de `purchase_orders` (0030): INSERT
-- y DELETE con `:write`; UPDATE con `:write`, `:approve` o `:receive`, porque
-- la recepción actualiza `qty_received`. Como en 0030, la base pone el piso:
-- qué puede hacer cada permiso sobre una orden en cada estado lo imponen la
-- capa 2 y `packages/domain`. A diferencia de la orden, borrar una línea no
-- exige borrador: la política de DELETE de la orden lee `draft` como "nunca
-- enviada" y por eso necesita la guarda de 0031; una línea no tiene estado.
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
-- LA TRAMPA DE LA LECTURA no aplica a estas tablas: su SELECT es por tenant, y
-- ni `INSERT ... RETURNING` ni `UPDATE ... WHERE` dependen de otro permiso.
-- Quien escribe siempre puede leer. Si un WP futuro cierra la lectura de una
-- de ellas (por ejemplo, las líneas de órdenes, que hoy muestran el precio de
-- compra a todo el staff), el invariante 94 tiene que sumar el par.
--
-- QUÉ QUEDA FUERA. (1) INSERT y UPDATE de `sale_orders` siguen solo por
-- tenant: un pago confirmado por un webhook (audiencia `system`) los escribe,
-- y `has_permission` exige staff; hay que definir primero ese camino (WP-G13).
-- Lo mismo vale ahora para los movimientos `sale` que genera esa confirmación:
-- con esta migración un contexto `system` no los inserta. (2) Las demás tablas
-- de la venta (`sale_order_lines`, `payments`, ...) y `movement_cost_allocations`
-- siguen solo por tenant. (3) La lectura de las líneas de órdenes de compra.
-- Los tres quedan anotados en `docs/backlog.md`.
--
-- Esta migración agrega un CHECK y un trigger; no cambia columnas.
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

CREATE POLICY tenant_access_select ON app.purchase_order_lines
  FOR SELECT USING (true);
CREATE POLICY pol_insert ON app.purchase_order_lines
  FOR INSERT WITH CHECK (app.has_permission('market.purchase_order:write'));
CREATE POLICY pol_update ON app.purchase_order_lines
  FOR UPDATE USING (
    app.has_permission('market.purchase_order:write')
    OR app.has_permission('market.purchase_order:approve')
    OR app.has_permission('market.purchase_order:receive'))
  WITH CHECK (
    app.has_permission('market.purchase_order:write')
    OR app.has_permission('market.purchase_order:approve')
    OR app.has_permission('market.purchase_order:receive'));
CREATE POLICY pol_delete ON app.purchase_order_lines
  FOR DELETE USING (app.has_permission('market.purchase_order:write'));

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
