-- =====================================================================
-- 0012_fix_staff_login_lookup_param_type.sql
--
-- Corrige `app.find_staff_login_by_email` (0011_staff_sessions.sql): el
-- parámetro estaba declarado `citext`, y llamarla desde Prisma
-- ($queryRaw, sin un cast de tipo explícito) falla con 42883 ("function
-- ... does not exist") — Postgres no resuelve la sobrecarga `(citext)` a
-- partir de un parámetro que llega como `text` sin más. Castear en el sitio
-- de la consulta (`${email}::citext`) tampoco alcanza: `joda_api` no tiene
-- `USAGE` sobre el schema `public` (0010_security_rls.sql se lo da solo
-- sobre `app`), y nombrar `citext` en un cast requiere ese `USAGE` aunque no
-- se toque ninguna tabla de `public`.
--
-- `p_email text` en vez de `citext`: la comparación sigue siendo
-- case-insensitive porque `email = p_email` resuelve al operador
-- `citext = text` que la extensión ya define — no se pierde la semántica
-- del UNIQUE (tenant_id, email) de staff_users, la firma es lo único que
-- cambia. No se puede `CREATE OR REPLACE` de citext a text (distinta firma
-- de parámetros): hay que borrar la sobrecarga vieja primero.
-- =====================================================================
SET search_path = app, public;

DROP FUNCTION app.find_staff_login_by_email(citext);

CREATE FUNCTION app.find_staff_login_by_email(p_email text)
RETURNS TABLE (
  id            uuid,
  tenant_id     uuid,
  auth_subject  text,
  is_active     boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public AS $$
  SELECT id, tenant_id, auth_subject, is_active
    FROM staff_users
   WHERE email = p_email
$$;

REVOKE ALL ON FUNCTION app.find_staff_login_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.find_staff_login_by_email(text) TO joda_api;
