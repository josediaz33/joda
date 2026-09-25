-- =====================================================================
-- 0016_rls_tenant_isolation_restrictive.sql  (WP-B10)
--
-- DEFECTO. Todas las políticas `tenant_isolation` (bucle de
-- 0010_security_rls.sql, repetido en 0014_rls_sweep.sql, más las dos de
-- 0011_staff_sessions.sql) se crearon PERMISSIVE — el default de
-- Postgres — y las políticas permisivas se combinan con OR. En las siete
-- tablas que además tienen una política de permiso (suppliers,
-- purchase_orders, journal_entries, chart_of_accounts, customer_deposits,
-- sourcing_scenarios, inventory_lots) la base evaluaba
--
--     tenant correcto  OR  tiene el permiso
--
-- donde ADR-016 pide "tenant correcto Y permiso". Demostrado conectado
-- como `joda_api` antes de escribir esta migración: un staff del tenant A
-- con `market.supplier:read` leía los proveedores del tenant B.
--
-- CORRECCIÓN. `tenant_isolation` pasa a RESTRICTIVE en TODA tabla que la
-- tenga (bucle, no tabla por tabla): una restrictiva se combina con AND
-- contra todas las demás, así que el tenant es condición necesaria
-- siempre. Las políticas de permiso quedan permisivas entre sí.
--
-- POR QUÉ HACE FALTA UNA PERMISIVA BASE. Postgres solo concede acceso si
-- al menos UNA política PERMISIVA lo habilita — las restrictivas solo
-- recortan. Convertir `tenant_isolation` sola dejaba a las tablas sin
-- política de permiso (casi todas) sin ninguna permisiva: probado sobre
-- `products`, `joda_api` pasaba a ver CERO filas de su propio tenant. Por
-- eso, para cada comando (SELECT/INSERT/UPDATE/DELETE) que no tenga
-- ninguna permisiva, se crea una con `true`. Ese `true` NO abre nada: la
-- fila igual tiene que pasar la restrictiva `tenant_isolation`, así que el
-- efecto neto es exactamente el aislamiento por tenant de antes.
--
--   · Tabla sin política de permiso → una sola `tenant_access` FOR ALL.
--     Resultado: tenant, igual que antes de esta migración.
--   · Tabla con política de permiso → solo los comandos que esa política
--     no cubre reciben `tenant_access_<comando>`. Ejemplo, suppliers:
--     SELECT = tenant AND market.supplier:read (lo que corrige este WP);
--     INSERT/UPDATE/DELETE = tenant, igual que antes. Exigir un permiso
--     también para escribir es otra decisión, fuera de este WP.
--
-- Los comandos que SÍ tienen política de permiso (SELECT en las siete;
-- INSERT en journal_entries y sourcing_scenarios) pasan de "tenant O
-- permiso" a "tenant Y permiso" — incluido el INSERT, que tenía el mismo
-- defecto.
--
-- Las expresiones USING / WITH CHECK de cada `tenant_isolation` se
-- copian tal cual de `pg_policy` (no se reescriben): el bucle cambia
-- solo el modo, no la condición.
--
-- `tenants` (política `tenant_self`, 0014) no se toca: es su única
-- política, permisiva, y no hay nada con qué combinarla con OR.
--
-- Toda tabla futura con `tenant_id` tiene que seguir este patrón
-- (restrictiva + permisiva). El invariante 23 de
-- `packages/db/tests/invariants.sql` falla si aparece una tabla con
-- `tenant_id` sin `tenant_isolation` RESTRICTIVE.
-- =====================================================================
SET search_path = app, public;

DO $$
DECLARE
  r       record;
  v_cmd   text;
  v_code  "char";
BEGIN
  FOR r IN
    SELECT c.oid AS relid,
           c.relname,
           pg_get_expr(p.polqual,      p.polrelid) AS using_expr,
           pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
      FROM pg_policy p
      JOIN pg_class c     ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'app'
       AND p.polname = 'tenant_isolation'
       AND p.polpermissive
     ORDER BY c.relname
  LOOP
    EXECUTE format('DROP POLICY tenant_isolation ON app.%I', r.relname);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I AS RESTRICTIVE FOR ALL USING (%s) WITH CHECK (%s)',
      r.relname, r.using_expr, r.check_expr);

    IF NOT EXISTS (SELECT 1 FROM pg_policy p
                    WHERE p.polrelid = r.relid AND p.polpermissive) THEN
      -- Permisiva base requerida por Postgres, que deniega todo si no hay
      -- ninguna permisiva. El filtrado lo hace tenant_isolation, que es
      -- RESTRICTIVE. Nunca uses esta política sin la restrictiva.
      EXECUTE format(
        'CREATE POLICY tenant_access ON app.%I FOR ALL USING (true) WITH CHECK (true)',
        r.relname);
    ELSE
      FOREACH v_cmd IN ARRAY ARRAY['select', 'insert', 'update', 'delete'] LOOP
        v_code := CASE v_cmd WHEN 'select' THEN 'r' WHEN 'insert' THEN 'a'
                             WHEN 'update' THEN 'w' ELSE 'd' END;
        CONTINUE WHEN EXISTS (SELECT 1 FROM pg_policy p
                               WHERE p.polrelid = r.relid
                                 AND p.polpermissive
                                 AND p.polcmd IN (v_code, '*'));
        -- Permisiva base requerida por Postgres, que deniega todo si no hay
        -- ninguna permisiva. El filtrado lo hace tenant_isolation, que es
        -- RESTRICTIVE. Nunca uses esta política sin la restrictiva.
        EXECUTE format('CREATE POLICY %I ON app.%I FOR %s %s',
          'tenant_access_' || v_cmd, r.relname, upper(v_cmd),
          CASE v_cmd
            WHEN 'select' THEN 'USING (true)'
            WHEN 'insert' THEN 'WITH CHECK (true)'
            WHEN 'update' THEN 'USING (true) WITH CHECK (true)'
            ELSE               'USING (true)'
          END);
      END LOOP;
    END IF;
  END LOOP;
END $$;
