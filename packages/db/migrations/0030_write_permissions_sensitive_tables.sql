-- =====================================================================
-- 0030_write_permissions_sensitive_tables.sql  (WP-B11)
--
-- DEFECTO. `suppliers`, `purchase_orders`, `inventory_lots`,
-- `chart_of_accounts` y `customer_deposits` exigen un permiso para LEER
-- (0010), pero para ESCRIBIR solo exigían tenant: 0016 les dejó las
-- permisivas base `tenant_access_insert/update/delete` con `true`, y con
-- eso cualquier staff del tenant, vendedor incluido, creaba un proveedor,
-- editaba una orden de compra, daba de alta un lote con el costo que
-- quisiera o tocaba el plan de cuentas. Las políticas de lectura protegían
-- lo que se ve; nada protegía lo que se cambia.
--
-- CORRECCIÓN. Esas tres permisivas se reemplazan, por comando, por otras
-- que exigen el permiso de escritura. `tenant_isolation` (RESTRICTIVE, 0016)
-- sigue combinándose con AND contra todas: el resultado es tenant Y permiso.
--
--   tabla               INSERT                   UPDATE                   DELETE
--   ------------------  -----------------------  -----------------------  ------------------
--   suppliers           market.supplier:write    market.supplier:write    nadie
--   purchase_orders     market.purchase_order    write, approve o         write, y solo en
--                       :write                   receive                  borrador
--   inventory_lots      receive, decant:execute, receive, decant:execute, nadie
--                       refund o adjust (*)      refund o adjust (*)
--   chart_of_accounts   accounting.journal:write accounting.journal:write nadie
--   customer_deposits   accounting.deposit:write accounting.deposit:write nadie
--
--   (*) market.purchase_order:receive, inventory.decant:execute,
--       sales.order:refund e inventory.stock:adjust. Es el mapeo que aprobó
--       José el 2026-09-25: recepción de compra, apertura de frasco y decant
--       por anticipado, devolución a cuarentena, y ajuste o saldo de
--       apertura. La base no sabe CUÁL de las cuatro operaciones está
--       haciendo quien escribe; eso lo impone la capa 2 (`requirePermission`
--       en cada procedimiento). Acá el piso es "algún permiso que crea o
--       mueve lotes".
--
-- Lo mismo vale para `purchase_orders`: en la capa 1 el UPDATE es la unión
-- de los tres permisos sobre la FILA ENTERA. Qué transición puede hacer
-- cada permiso (aprobar, recibir, cancelar) lo imponen la capa 2 y
-- `packages/domain`, no la base.
--
-- DELETE. Nadie borra lotes (son historial de costo y el ledger los
-- referencia), señas (son plata recibida: se devuelven o se aplican),
-- cuentas ni proveedores (tienen `is_active`: se desactivan). Sin política
-- permisiva de DELETE, Postgres lo deniega: afecta cero filas, sin error.
-- La única excepción es la orden de compra EN BORRADOR, con
-- `market.purchase_order:write`: el estado va en la política misma, así que
-- una orden enviada no se borra aunque quien lo intenta tenga el permiso.
-- Pasado el borrador, la orden se cancela por la máquina de estados.
--
-- LA TRAMPA DE LA LECTURA. Con RLS, `INSERT ... RETURNING` y
-- `UPDATE ... WHERE` también evalúan la política de LECTURA de la tabla.
-- Un rol con el permiso de escribir y sin el de leer no falla con un error
-- claro: su INSERT ... RETURNING (el que emite Prisma) es rechazado con
-- 42501, y su UPDATE ... WHERE o DELETE ... WHERE afecta cero filas, sin
-- error (la API lo ve como un 404). Por eso, en los roles sembrados, todo
-- permiso de escritura de estas tablas viene con el de lectura de la misma
-- tabla, salvo una excepción registrada: depósito, que recibe
-- (`market.purchase_order:receive`) sin poder leer órdenes de compra. Se
-- resuelve en WP-C15, no acá. El vendedor, que recibe señas
-- (`accounting.deposit:write`), gana `accounting.deposit:read` en el seed.
--
-- NUNCA `FOR ALL` EN UNA POLÍTICA DE PERMISO. Un `FOR ALL` permisivo
-- también cubre SELECT: quien tiene el permiso de escribir leería la tabla
-- entera aunque no tenga el de leer. Por eso hay una política por comando.
--
-- Esta migración no toca lo que ya está: SELECT (las políticas `*_read` de
-- 0010), `tenant_isolation` ni los triggers. No cambia el esquema de
-- ninguna tabla.
-- =====================================================================
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- suppliers
-- ---------------------------------------------------------------------
DROP POLICY tenant_access_insert ON app.suppliers;
DROP POLICY tenant_access_update ON app.suppliers;
DROP POLICY tenant_access_delete ON app.suppliers;

CREATE POLICY suppliers_insert ON app.suppliers
  FOR INSERT WITH CHECK (app.has_permission('market.supplier:write'));
CREATE POLICY suppliers_update ON app.suppliers
  FOR UPDATE USING (app.has_permission('market.supplier:write'))
  WITH CHECK (app.has_permission('market.supplier:write'));

-- ---------------------------------------------------------------------
-- purchase_orders
-- ---------------------------------------------------------------------
DROP POLICY tenant_access_insert ON app.purchase_orders;
DROP POLICY tenant_access_update ON app.purchase_orders;
DROP POLICY tenant_access_delete ON app.purchase_orders;

CREATE POLICY po_insert ON app.purchase_orders
  FOR INSERT WITH CHECK (app.has_permission('market.purchase_order:write'));
CREATE POLICY po_update ON app.purchase_orders
  FOR UPDATE USING (
    app.has_permission('market.purchase_order:write')
    OR app.has_permission('market.purchase_order:approve')
    OR app.has_permission('market.purchase_order:receive'))
  WITH CHECK (
    app.has_permission('market.purchase_order:write')
    OR app.has_permission('market.purchase_order:approve')
    OR app.has_permission('market.purchase_order:receive'));
CREATE POLICY po_delete ON app.purchase_orders
  FOR DELETE USING (
    app.has_permission('market.purchase_order:write') AND status = 'draft');

-- ---------------------------------------------------------------------
-- inventory_lots
-- ---------------------------------------------------------------------
DROP POLICY tenant_access_insert ON app.inventory_lots;
DROP POLICY tenant_access_update ON app.inventory_lots;
DROP POLICY tenant_access_delete ON app.inventory_lots;

CREATE POLICY lots_insert ON app.inventory_lots
  FOR INSERT WITH CHECK (
    app.has_permission('market.purchase_order:receive')
    OR app.has_permission('inventory.decant:execute')
    OR app.has_permission('sales.order:refund')
    OR app.has_permission('inventory.stock:adjust'));
CREATE POLICY lots_update ON app.inventory_lots
  FOR UPDATE USING (
    app.has_permission('market.purchase_order:receive')
    OR app.has_permission('inventory.decant:execute')
    OR app.has_permission('sales.order:refund')
    OR app.has_permission('inventory.stock:adjust'))
  WITH CHECK (
    app.has_permission('market.purchase_order:receive')
    OR app.has_permission('inventory.decant:execute')
    OR app.has_permission('sales.order:refund')
    OR app.has_permission('inventory.stock:adjust'));

-- ---------------------------------------------------------------------
-- chart_of_accounts
-- ---------------------------------------------------------------------
DROP POLICY tenant_access_insert ON app.chart_of_accounts;
DROP POLICY tenant_access_update ON app.chart_of_accounts;
DROP POLICY tenant_access_delete ON app.chart_of_accounts;

CREATE POLICY coa_insert ON app.chart_of_accounts
  FOR INSERT WITH CHECK (app.has_permission('accounting.journal:write'));
CREATE POLICY coa_update ON app.chart_of_accounts
  FOR UPDATE USING (app.has_permission('accounting.journal:write'))
  WITH CHECK (app.has_permission('accounting.journal:write'));

-- ---------------------------------------------------------------------
-- customer_deposits
-- ---------------------------------------------------------------------
DROP POLICY tenant_access_insert ON app.customer_deposits;
DROP POLICY tenant_access_update ON app.customer_deposits;
DROP POLICY tenant_access_delete ON app.customer_deposits;

CREATE POLICY deposits_insert ON app.customer_deposits
  FOR INSERT WITH CHECK (app.has_permission('accounting.deposit:write'));
CREATE POLICY deposits_update ON app.customer_deposits
  FOR UPDATE USING (app.has_permission('accounting.deposit:write'))
  WITH CHECK (app.has_permission('accounting.deposit:write'));
