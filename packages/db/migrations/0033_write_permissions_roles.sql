-- =====================================================================
-- 0033_write_permissions_roles.sql  (WP-B11c)
--
-- DEFECTO. `roles`, `role_permissions` y `staff_user_roles` solo exigían
-- tenant para escribir: 0014 les dejó una única permisiva `tenant_access`
-- FOR ALL con `true`. Eso anulaba B11 desde abajo: quien ejecuta SQL como
-- `joda_api`, o un endpoint de gestión de roles con un error en la capa 2,
-- se asigna un permiso (`INSERT INTO role_permissions`) o un rol
-- (`INSERT INTO staff_user_roles`) y en la misma transacción escribe en las
-- cinco tablas de B11. Un error de capa 2 en ese endpoint era la única falla
-- necesaria. Verificado como vendedor: `DELETE FROM app.roles WHERE code =
-- 'deposito'` borró la fila y, por la cascada (que no evalúa RLS), las
-- `role_permissions` del rol.
--
-- Y el catálogo `permissions`, que no tiene RLS ni `tenant_id` por diseño
-- (0014), conservaba el GRANT general de 0010 (`INSERT, UPDATE, DELETE`) a
-- `joda_api`. Lo encontró la revisión cruzada: un vendedor del tenant A
-- borró un código y las `role_permissions` de AMBOS tenants que lo tenían
-- pasaron de 3 y 3 a 0, por la cascada de `role_permissions.permission_code`,
-- que no evalúa RLS.
--
-- CORRECCIÓN, en cuatro partes.
--
-- 1. RLS. `tenant_access` FOR ALL se reemplaza, en las tres tablas, por una
--    política por comando: INSERT, UPDATE y DELETE exigen
--    `settings.user:write`. `tenant_isolation` (RESTRICTIVE, 0016) sigue
--    combinándose con AND contra todas: tenant Y permiso. Mismo patrón que
--    0030: nunca `FOR ALL` en una política de permiso.
--
-- 2. Roles de sistema: no se borran ni se renombran, por nadie. Los roles
--    `is_system` (dueño, encargado, vendedor y depósito, los que siembra
--    `seed_roles`) no se borran ni cambian de nombre: sin eso, quien pueda
--    borrar roles puede borrar el de dueño. Lo impone un trigger y no una
--    política, porque "por nadie" incluye a quien eludiría la política: el
--    superusuario de una migración, `service_role` en el ETL. El trigger
--    también congela `is_system` (en los dos sentidos) y la política de INSERT
--    exige `NOT is_system`: sin eso, bajar la marca a un rol de sistema y
--    borrarlo eran dos pasos, el mismo rodeo que la revisión de B11 encontró
--    con `draft`, y un administrador podría fabricar roles que nadie puede
--    borrar después. `seed_roles` inserta como dueño de las tablas (elude
--    RLS) y no se ve afectada.
--
-- 3. Roles de sistema: sus permisos no se modifican en tiempo de ejecución.
--    `role_permissions` de un rol `is_system` no admite INSERT, UPDATE ni
--    DELETE por `joda_api`: las tres políticas de escritura de esa tabla
--    exigen, además del permiso, que el rol no sea de sistema (y el UPDATE, que
--    no se mueva una fila hacia uno). Esos permisos son la matriz de
--    `docs/security-spec.md` §2.1 y se cambian por el seed. Sin esto, el
--    dueño se vacía su propio rol con un `DELETE` y queda tan bloqueado como
--    si lo hubiera borrado: lo encontró la revisión cruzada (27 permisos del
--    rol dueño borrados en una sentencia, y `has_permission('settings.user:
--    write')` pasa a `false`). Decisión de José, 2026-10-02. Es solo RLS y no un
--    trigger: la regla es sobre la API, y el seed y el ETL (`service_role`,
--    que elude RLS) siguen siendo el camino para cambiarlos. No cubre
--    `staff_user_roles`: quitarle a alguien el rol de dueño es la regla del
--    último dueño, criterio de WP-C24.
--
-- 4. `permissions`: `REVOKE INSERT, UPDATE, DELETE FROM joda_api`. El catálogo
--    es global y lo carga el seed (superusuario): ninguna sesión de la API lo
--    escribe, y un vendedor de un tenant no puede vaciar los roles de todos.
--    Conserva SELECT. El invariante 111 lo verifica (incluye los privilegios
--    de columna y los heredados de PUBLIC).
--
-- LECTURA, SIN CAMBIOS. El SELECT de las tres tablas sigue siendo por tenant:
-- `tenant_access_select`, `USING (true)`, combinada con la restrictiva. No es
-- un descuido. `getGrantedPermissionCodes` (apps/api/src/modules/auth/
-- repository.ts) lee `role_permissions` y `staff_user_roles` como `joda_api`,
-- bajo RLS, para resolver los permisos de CADA sesión, vendedor incluido,
-- que no tiene `settings.user:read`. Exigirlo para leer rompería el login de
-- todos. Por eso acá no existe la trampa de la lectura de 0030: quien escribe
-- estas tablas siempre puede leerlas, y `INSERT ... RETURNING` y `UPDATE ...
-- WHERE` no dependen de otro permiso. El par de `settings.user:write` en el
-- invariante 94 es `settings.user:read`: no por la trampa, sino porque quien
-- administra usuarios y roles tiene que ver la pantalla que los lista.
--
-- `has_permission` es SECURITY DEFINER y lee `staff_user_roles` y
-- `role_permissions` para resolver permisos. Estas políticas la llaman: no
-- se rompe esa lectura porque corre como el dueño de las tablas, que elude
-- RLS (invariante 30); una política que consultara la misma tabla con los
-- privilegios de quien escribe recursaría. Las de `role_permissions` consultan
-- `roles` (otra tabla, de SELECT por tenant), así que no recursan.
--
-- Esta migración no cambia el esquema de ninguna tabla.
-- =====================================================================
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- roles
-- ---------------------------------------------------------------------
DROP POLICY tenant_access ON app.roles;

CREATE POLICY tenant_access_select ON app.roles
  FOR SELECT USING (true);
CREATE POLICY roles_insert ON app.roles
  FOR INSERT WITH CHECK (app.has_permission('settings.user:write') AND NOT is_system);
CREATE POLICY roles_update ON app.roles
  FOR UPDATE USING (app.has_permission('settings.user:write'))
  WITH CHECK (app.has_permission('settings.user:write'));
CREATE POLICY roles_delete ON app.roles
  FOR DELETE USING (app.has_permission('settings.user:write'));

-- ---------------------------------------------------------------------
-- role_permissions: los permisos de un rol de sistema no se tocan
-- ---------------------------------------------------------------------
DROP POLICY tenant_access ON app.role_permissions;

CREATE POLICY tenant_access_select ON app.role_permissions
  FOR SELECT USING (true);
CREATE POLICY role_permissions_insert ON app.role_permissions
  FOR INSERT WITH CHECK (
    app.has_permission('settings.user:write')
    AND NOT EXISTS (SELECT 1 FROM app.roles r
                     WHERE r.id = role_permissions.role_id AND r.is_system));
CREATE POLICY role_permissions_update ON app.role_permissions
  FOR UPDATE USING (
    app.has_permission('settings.user:write')
    AND NOT EXISTS (SELECT 1 FROM app.roles r
                     WHERE r.id = role_permissions.role_id AND r.is_system))
  WITH CHECK (
    app.has_permission('settings.user:write')
    AND NOT EXISTS (SELECT 1 FROM app.roles r
                     WHERE r.id = role_permissions.role_id AND r.is_system));
CREATE POLICY role_permissions_delete ON app.role_permissions
  FOR DELETE USING (
    app.has_permission('settings.user:write')
    AND NOT EXISTS (SELECT 1 FROM app.roles r
                     WHERE r.id = role_permissions.role_id AND r.is_system));

-- ---------------------------------------------------------------------
-- staff_user_roles
-- ---------------------------------------------------------------------
DROP POLICY tenant_access ON app.staff_user_roles;

CREATE POLICY tenant_access_select ON app.staff_user_roles
  FOR SELECT USING (true);
CREATE POLICY staff_user_roles_insert ON app.staff_user_roles
  FOR INSERT WITH CHECK (app.has_permission('settings.user:write'));
CREATE POLICY staff_user_roles_update ON app.staff_user_roles
  FOR UPDATE USING (app.has_permission('settings.user:write'))
  WITH CHECK (app.has_permission('settings.user:write'));
CREATE POLICY staff_user_roles_delete ON app.staff_user_roles
  FOR DELETE USING (app.has_permission('settings.user:write'));

-- ---------------------------------------------------------------------
-- permissions: el catálogo global lo carga el seed, no la API
-- ---------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON app.permissions FROM joda_api;

-- ---------------------------------------------------------------------
-- Los roles de sistema no se borran ni se renombran, por nadie.
--
-- Lee solo OLD y NEW, ninguna otra tabla: no es SECURITY DEFINER y no
-- puede decidir sobre algo que RLS le oculte (el invariante 29 la admite por
-- nombre). Compara con `IS DISTINCT FROM`. Fija `search_path = app,
-- pg_temp` (invariante 28).
--
-- Borrar un tenant borraría por cascada sus roles de sistema y este trigger
-- lo rechaza. No hay un camino de producto que borre un tenant (la FK de
-- `staff_users` es RESTRICT), y quien lo necesite tiene que deshabilitar el
-- trigger a propósito.
-- ---------------------------------------------------------------------
CREATE FUNCTION app.guard_system_roles() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system THEN
      RAISE EXCEPTION
        'El rol de sistema "%" (%) no se puede borrar',
        OLD.name, OLD.code
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.is_system IS DISTINCT FROM OLD.is_system THEN
    RAISE EXCEPTION
      'La marca is_system del rol "%" (%) no se puede cambiar',
      OLD.name, OLD.code
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.is_system
     AND (NEW.code IS DISTINCT FROM OLD.code OR NEW.name IS DISTINCT FROM OLD.name) THEN
    RAISE EXCEPTION
      'El rol de sistema "%" (%) no se puede renombrar',
      OLD.name, OLD.code
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_system_roles_guard
  BEFORE UPDATE OR DELETE ON app.roles
  FOR EACH ROW EXECUTE FUNCTION app.guard_system_roles();
