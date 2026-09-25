-- =====================================================================
-- 0019_has_permission_session_bound.sql  (WP-B13)
--
-- MODELO DE CONFIANZA (ADR-016, sección agregada por este WP). RLS protege
-- contra errores de la aplicación, no contra un proceso de API
-- comprometido: quien ejecuta SQL arbitrario como `joda_api` puede fijar
-- cualquier `app.user_id`. Este WP no cambia eso. Lo que cambia es cuánto
-- tiene que salir mal en la aplicación para que la base conceda un
-- permiso que no corresponde.
--
-- 1. `has_permission` exige una SESIÓN VÁLIDA. Hasta acá le alcanzaba con
--    `app.user_id`: un error de la aplicación que fijara el `user_id`
--    equivocado (un id tomado de la entrada del cliente, un contexto
--    mezclado entre requests) heredaba en silencio los permisos de ese
--    usuario. Ahora `app.session_id` tiene que nombrar una fila de
--    `staff_sessions` que sea:
--      · del mismo `app.user_id`,
--      · del mismo `app.tenant_id`,
--      · no revocada (`revoked_at IS NULL`),
--      · no vencida (`expires_at > now()`).
--    Un `user_id` equivocado ya no alcanza: habría que fabricar además una
--    sesión viva de ese usuario. Sin `app.session_id`, la respuesta es
--    `false`: falla cerrado.
--
--    Deliberadamente NO se exige `mfa_verified_at`. El segundo factor lo
--    impone `enforceMfaGate` (apps/api/src/trpc/trpc.ts, WP-C04) antes de
--    cualquier procedimiento de negocio, y ninguna regla escrita pide que
--    la base lo repita. Agregarlo es una decisión aparte, no de este WP.
--
-- 2. `SET search_path = app, pg_temp` y nombres calificados con `app.` en
--    TODA función SECURITY DEFINER de `app.*` que no lo tuviera ya:
--    `has_permission`, `find_staff_login_by_email` y
--    `find_staff_refresh_token`. Con `search_path = app, public`, `pg_temp`
--    se busca PRIMERO. Verificado como `joda_api` en WP-B10: con tablas
--    temporales `staff_user_roles`/`role_permissions` falsas,
--    `has_permission('accounting.journal:read')` pasaba de `f` a `t`. Es
--    prerrequisito del punto 1, porque sin esto la verificación de sesión
--    también se sombrearía con una `staff_sessions` temporal. Las funciones
--    de disparador ya quedaron así en 0017/0018.
--
-- `REVOKE TEMPORARY ON DATABASE ... FROM PUBLIC` (evaluado, NO aplicado).
-- Con `pg_temp` último en toda SECURITY DEFINER y nombres calificados, una
-- tabla temporal no tiene de dónde sombrear nada, y `pg_temp` nunca se
-- busca para funciones ni operadores. Revocar TEMPORARY a PUBLIC afectaría
-- a todos los roles de la base, y el nombre de la base cambia por entorno.
-- El invariante 40 verifica en cambio la propiedad que importa: ninguna
-- SECURITY DEFINER de `app.*` deja `pg_temp` en otra posición que la última.
-- =====================================================================
SET search_path = app, public;

-- Mismo patrón que current_user_id()/current_tenant_id() (0001): lee un
-- valor de sesión fijado por withTenantTx con set_config(..., true).
CREATE OR REPLACE FUNCTION app.current_session_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = app, pg_temp AS $$
  SELECT nullif(current_setting('app.session_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.has_permission(p_code text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT app.current_audience() = 'staff'
     AND EXISTS (
       SELECT 1
         FROM app.staff_sessions s
        WHERE s.id = app.current_session_id()
          AND s.staff_user_id = app.current_user_id()
          AND s.tenant_id = app.current_tenant_id()
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
     )
     AND EXISTS (
       SELECT 1
         FROM app.staff_user_roles sur
         JOIN app.role_permissions rp ON rp.role_id = sur.role_id
        WHERE sur.staff_user_id = app.current_user_id()
          AND rp.permission_code = p_code
     )
$$;

-- Mismas firmas y columnas que 0013. Solo cambian el search_path y los
-- nombres calificados, así que alcanza con CREATE OR REPLACE y los
-- GRANT/REVOKE de 0013 siguen vigentes.
CREATE OR REPLACE FUNCTION app.find_staff_login_by_email(p_email text)
RETURNS TABLE (
  id            uuid,
  tenant_id     uuid,
  auth_subject  text,
  is_active     boolean,
  mfa_enrolled  boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT su.id, su.tenant_id, su.auth_subject, su.is_active, su.mfa_enrolled
    FROM app.staff_users su
   WHERE su.email = p_email
$$;

CREATE OR REPLACE FUNCTION app.find_staff_refresh_token(p_token_hash text)
RETURNS TABLE (
  token_id                 uuid,
  tenant_id                uuid,
  session_id               uuid,
  consumed_at              timestamptz,
  staff_user_id            uuid,
  session_revoked_at       timestamptz,
  session_expires_at       timestamptz,
  session_mfa_verified_at  timestamptz,
  mfa_enrolled             boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT t.id, t.tenant_id, t.session_id, t.consumed_at,
         s.staff_user_id, s.revoked_at, s.expires_at, s.mfa_verified_at,
         su.mfa_enrolled
    FROM app.staff_refresh_tokens t
    JOIN app.staff_sessions s ON s.id = t.session_id
    JOIN app.staff_users su ON su.id = s.staff_user_id
   WHERE t.token_hash = p_token_hash
$$;
