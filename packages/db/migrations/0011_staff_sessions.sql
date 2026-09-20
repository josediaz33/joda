-- =====================================================================
-- 0011_staff_sessions.sql — sesión de personal, tokens de refresco
--
-- WP-C03 (docs/security-spec.md §4): cookie __Host-joda_a, token de acceso
-- de 15 min cacheado en Redis (fuera de esta base), token de refresco de
-- 8 h rotativo con detección de reúso.
--
-- staff_sessions es la "familia" — el ID que agrupa toda la cadena de
-- rotación de un login. staff_refresh_tokens tiene UNA fila por rotación:
-- nunca se actualiza el token en su lugar, se inserta uno nuevo y se marca
-- `consumed_at` en el anterior. Eso es lo que permite reconocer un reúso:
-- si el token presentado ya tiene `consumed_at`, alguien está usando una
-- copia vieja — y ahí se revoca la sesión entera (`staff_sessions.revoked_at`),
-- no solo ese token.
--
-- El secreto del token nunca se guarda en texto plano: `token_hash` es el
-- SHA-256 del valor opaco que viaja en la cookie (apps/api/src/adapters/
-- secureToken.ts). Si esta tabla se filtra, no alcanza para reconstruir
-- ninguna sesión activa.
-- =====================================================================
SET search_path = app, public;

CREATE TYPE staff_session_revocation_reason AS ENUM ('logout', 'reuse_detected');

CREATE TABLE staff_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_user_id   uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Ventana absoluta de 8 h (docs/security-spec.md §1, fila "Token de
  -- refresco"): NO se extiende con cada rotación. A las 8 h de login, el
  -- personal reautentica sin importar cuánto usó el sistema en el medio.
  expires_at      timestamptz NOT NULL,
  last_used_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  revoked_reason  staff_session_revocation_reason,
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE INDEX staff_sessions_user ON staff_sessions (tenant_id, staff_user_id);

CREATE TABLE staff_refresh_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id    uuid NOT NULL REFERENCES staff_sessions(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  consumed_at   timestamptz,
  replaced_by   uuid REFERENCES staff_refresh_tokens(id)
);

CREATE INDEX staff_refresh_tokens_session ON staff_refresh_tokens (session_id);

ALTER TABLE staff_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_sessions
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE staff_refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_refresh_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_refresh_tokens
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- ---------------------------------------------------------------------
-- Lecturas previas a la sesión — el mismo problema que resuelve
-- `has_permission()` (0002_identity_rbac.sql): la política tenant_isolation
-- de arriba exige `app.tenant_id` en el contexto, pero el login y el
-- refresco son EXACTAMENTE los dos momentos en los que ese contexto
-- todavía no existe — es lo que estas funciones están resolviendo.
--
-- SECURITY DEFINER las corre con los privilegios de quien las creó, no de
-- `joda_api`, así que sí pueden leer sin `tenant_id` en contexto. A
-- propósito devuelven el mínimo necesario para que la API decida qué hacer
-- en TypeScript (packages/domain/src/security/refreshToken.ts) — ninguna
-- decisión de negocio (¿es un reúso? ¿venció la sesión?) vive acá
-- (.claude/rules/database.md: "triggers solo para invariantes", el mismo
-- criterio aplica a cualquier función con SECURITY DEFINER). Una vez que la
-- API conoce el tenant_id, hace el UPDATE/INSERT real a través de
-- withTenantTx, con RLS evaluando normalmente.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.find_staff_login_by_email(p_email citext)
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

REVOKE ALL ON FUNCTION app.find_staff_login_by_email(citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.find_staff_login_by_email(citext) TO joda_api;

CREATE OR REPLACE FUNCTION app.find_staff_refresh_token(p_token_hash text)
RETURNS TABLE (
  token_id            uuid,
  tenant_id           uuid,
  session_id          uuid,
  consumed_at         timestamptz,
  staff_user_id       uuid,
  session_revoked_at  timestamptz,
  session_expires_at  timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public AS $$
  SELECT t.id, t.tenant_id, t.session_id, t.consumed_at,
         s.staff_user_id, s.revoked_at, s.expires_at
    FROM staff_refresh_tokens t
    JOIN staff_sessions s ON s.id = t.session_id
   WHERE t.token_hash = p_token_hash
$$;

REVOKE ALL ON FUNCTION app.find_staff_refresh_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.find_staff_refresh_token(text) TO joda_api;
