-- =====================================================================
-- 0032_write_permissions_sourcing_scenarios.sql  (WP-B11b)
--
-- DEFECTO. `sourcing_scenarios` es la única tabla de permiso a medio hacer
-- que dejó B11: tenía política de INSERT (`sourcing_write`, 0010:
-- `market.sourcing:write`) y para UPDATE y DELETE solo exigía tenant. 0016
-- le dejó `tenant_access_update` y `tenant_access_delete` con `true`, y con
-- eso cualquier staff del tenant, vendedor y depósito incluidos (que no
-- tienen ni `market.sourcing:read`), editaba o borraba un escenario que no
-- podía ni crear ni ver.
--
-- CORRECCIÓN. Esas dos permisivas se reemplazan, por comando, por otras que
-- exigen `market.sourcing:write`. `tenant_isolation` (RESTRICTIVE, 0016)
-- sigue combinándose con AND contra todas: el resultado es tenant Y permiso.
-- Mismo patrón que 0030 (B11): una política por comando, nunca `FOR ALL`.
--
--   tabla                INSERT                 UPDATE                 DELETE
--   -------------------  ---------------------  ---------------------  ---------------------
--   sourcing_scenarios   market.sourcing:write  market.sourcing:write  market.sourcing:write
--
-- La política de INSERT es la de 0010 y no se toca. Se llama `sourcing_write`
-- por un nombre de 0010, que se escribió cuando era la única de escritura;
-- no cubre UPDATE ni DELETE. Renombrarla no corrige nada y no es de este WP.
--
-- DELETE SÍ SE PERMITE, a diferencia de las cinco tablas de B11. Un
-- escenario es una simulación (0005: "no toca inventario, ni caja, ni CxP"):
-- borrarlo no destruye historial de costo ni plata recibida, y no hay un
-- estado ni un `is_active` con el que desactivarlo. Borra también sus líneas
-- por la cascada de `sourcing_scenario_lines.scenario_id`, que no evalúa RLS;
-- como borrar el escenario exige el mismo permiso que escribirlas, no abre
-- nada. Quien tenga `:write` puede borrar también un escenario ya convertido
-- en orden de compra (`converted_to_po_id`); la FK apunta del escenario a la
-- orden, así que la orden no se ve afectada, pero pierde el rastro de su
-- origen. Si eso importa, es una regla de negocio que hoy no está escrita.
--
-- LA TRAMPA DE LA LECTURA (la misma de 0030). `INSERT ... RETURNING` y los
-- UPDATE o DELETE que LEEN columnas (con WHERE o RETURNING) evalúan también
-- la política de LECTURA (`sourcing_read`, `market.sourcing:read`). Un rol
-- con el permiso de escribir y sin el de leer no recibe un error claro: su
-- INSERT ... RETURNING se rechaza con 42501 y su UPDATE ... WHERE o DELETE
-- ... WHERE afecta cero filas. Un UPDATE o DELETE sin WHERE ni RETURNING no
-- lee nada y solo necesita el de escritura. Por eso todo permiso de
-- escritura de la tabla viene con el de lectura en los roles sembrados
-- (dueño y encargado tienen los dos; vendedor y depósito, ninguno). El
-- invariante 94 lo verifica.
--
-- QUÉ QUEDA FUERA. `sourcing_scenario_lines`, la tabla hija, sigue con una
-- única permisiva `tenant_access` FOR ALL con `true`: cualquier staff del
-- tenant lee y escribe las líneas (precios de proveedor, FX asumido, margen
-- proyectado) sin `market.sourcing:read` ni `:write`. Es el mismo defecto un
-- nivel más abajo y no está en el alcance de este WP; queda anotado en
-- `docs/backlog.md` para que José decida dónde va.
--
-- Esta migración no toca SELECT, `tenant_isolation` ni los triggers. No
-- cambia el esquema de ninguna tabla.
-- =====================================================================
SET search_path = app, public;

DROP POLICY tenant_access_update ON app.sourcing_scenarios;
DROP POLICY tenant_access_delete ON app.sourcing_scenarios;

CREATE POLICY sourcing_update ON app.sourcing_scenarios
  FOR UPDATE USING (app.has_permission('market.sourcing:write'))
  WITH CHECK (app.has_permission('market.sourcing:write'));
CREATE POLICY sourcing_delete ON app.sourcing_scenarios
  FOR DELETE USING (app.has_permission('market.sourcing:write'));
