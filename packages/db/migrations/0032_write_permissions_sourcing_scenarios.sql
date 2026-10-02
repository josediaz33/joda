-- =====================================================================
-- 0032_write_permissions_sourcing_scenarios.sql  (WP-B11b)
--
-- DEFECTO, en dos tablas.
--
-- 1. `sourcing_scenarios` es la única tabla de permiso a medio hacer que dejó
--    B11: tenía política de INSERT (`sourcing_write`, 0010:
--    `market.sourcing:write`) y para UPDATE y DELETE solo exigía tenant. 0016
--    le dejó `tenant_access_update` y `tenant_access_delete` con `true`, y con
--    eso cualquier staff del tenant, vendedor y depósito incluidos (que no
--    tienen ni `market.sourcing:read`), editaba o borraba un escenario que no
--    podía ni crear ni ver.
--
-- 2. `sourcing_scenario_lines`, su tabla hija, nunca tuvo permiso de nada:
--    una única permisiva `tenant_access` FOR ALL con `true` (0014). Cualquier
--    staff del tenant leía, editaba y borraba las líneas, que llevan precios
--    de proveedor, FX asumido y margen proyectado: justo lo que el vendedor
--    no tiene que ver (el seed lo dice: "ni lo que te cuesta cada frasco").
--    Es el mismo defecto un nivel más abajo, con la lectura abierta además de
--    la escritura. Lo encontró la revisión de B11b y José decidió cerrarlo
--    acá (2026-10-02).
--
-- CORRECCIÓN. Las permisivas con `true` se reemplazan por otras que exigen el
-- permiso. `tenant_isolation` (RESTRICTIVE, 0016) sigue combinándose con AND
-- contra todas: el resultado es tenant Y permiso. Mismo patrón que 0030
-- (B11): una política por comando, nunca `FOR ALL`.
--
--   tabla                      SELECT                INSERT                 UPDATE                 DELETE
--   -------------------------  --------------------  ---------------------  ---------------------  ---------------------
--   sourcing_scenarios         market.sourcing:read  market.sourcing:write  market.sourcing:write  market.sourcing:write
--   sourcing_scenario_lines    market.sourcing:read  market.sourcing:write  market.sourcing:write  market.sourcing:write
--
-- Las políticas de SELECT y de INSERT de `sourcing_scenarios` son las de 0010
-- (`sourcing_read`, `sourcing_write`) y no se tocan. `sourcing_write` se llama
-- así por un nombre de 0010, que se escribió cuando era la única de escritura;
-- no cubre UPDATE ni DELETE. Renombrarla no corrige nada y no es de este WP.
--
-- DELETE SÍ SE PERMITE, a diferencia de las cinco tablas de B11. Un
-- escenario es una simulación (0005: "no toca inventario, ni caja, ni CxP"):
-- borrarlo no destruye historial de costo ni plata recibida, y no hay un
-- estado ni un `is_active` con el que desactivarlo. Borra también sus líneas
-- por la cascada de `sourcing_scenario_lines.scenario_id`, que no evalúa RLS;
-- como borrar el escenario exige el mismo permiso que borrarlas, no abre
-- nada. Quien tenga `:write` puede borrar también un escenario ya convertido
-- en orden de compra (`converted_to_po_id`); la FK apunta del escenario a la
-- orden, así que la orden no se ve afectada, pero pierde el rastro de su
-- origen. Si eso importa, es una regla de negocio que hoy no está escrita.
--
-- LA TRAMPA DE LA LECTURA (la misma de 0030). `INSERT ... RETURNING` y los
-- UPDATE o DELETE que LEEN columnas (con WHERE o RETURNING) evalúan también
-- la política de LECTURA de la tabla (`market.sourcing:read`). Un rol con el
-- permiso de escribir y sin el de leer no recibe un error claro: su
-- INSERT ... RETURNING se rechaza con 42501 y su UPDATE ... WHERE o DELETE
-- ... WHERE afecta cero filas. Un UPDATE o DELETE sin WHERE ni RETURNING no
-- lee nada y solo necesita el de escritura. Por eso todo permiso de
-- escritura de las dos tablas viene con el de lectura en los roles sembrados
-- (dueño y encargado tienen los dos; vendedor y depósito, ninguno). El
-- invariante 94 lo verifica, y el 91 verifica que la lectura de las líneas
-- exija el permiso.
--
-- Esta migración no toca `tenant_isolation` ni los triggers. No cambia el
-- esquema de ninguna tabla.
-- =====================================================================
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- sourcing_scenarios (SELECT e INSERT ya exigían permiso desde 0010)
-- ---------------------------------------------------------------------
DROP POLICY tenant_access_update ON app.sourcing_scenarios;
DROP POLICY tenant_access_delete ON app.sourcing_scenarios;

CREATE POLICY sourcing_update ON app.sourcing_scenarios
  FOR UPDATE USING (app.has_permission('market.sourcing:write'))
  WITH CHECK (app.has_permission('market.sourcing:write'));
CREATE POLICY sourcing_delete ON app.sourcing_scenarios
  FOR DELETE USING (app.has_permission('market.sourcing:write'));

-- ---------------------------------------------------------------------
-- sourcing_scenario_lines (nada exigía permiso: ni leer ni escribir)
-- ---------------------------------------------------------------------
DROP POLICY tenant_access ON app.sourcing_scenario_lines;

CREATE POLICY sourcing_lines_read ON app.sourcing_scenario_lines
  FOR SELECT USING (app.has_permission('market.sourcing:read'));
CREATE POLICY sourcing_lines_insert ON app.sourcing_scenario_lines
  FOR INSERT WITH CHECK (app.has_permission('market.sourcing:write'));
CREATE POLICY sourcing_lines_update ON app.sourcing_scenario_lines
  FOR UPDATE USING (app.has_permission('market.sourcing:write'))
  WITH CHECK (app.has_permission('market.sourcing:write'));
CREATE POLICY sourcing_lines_delete ON app.sourcing_scenario_lines
  FOR DELETE USING (app.has_permission('market.sourcing:write'));
