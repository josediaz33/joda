-- =====================================================================
-- 0013_staff_mfa.sql — segundo factor (TOTP) obligatorio para personal
--
-- WP-C04 (docs/security-spec.md §4.3): un usuario de personal sin segundo
-- factor inscripto se autentica con contraseña, pero esa sesión no autoriza
-- nada hasta que complete la inscripción. Un usuario YA inscripto también
-- necesita satisfacer el desafío TOTP en CADA sesión nueva (login) — si no,
-- "obligatorio" describiría solo la primera vez, y cualquiera con la
-- contraseña entraría para siempre sin el segundo factor.
--
-- `staff_users.mfa_secret_encrypted`: el secreto TOTP, cifrado (AES-256-GCM,
-- apps/api/src/adapters/mfaSecretCipher.ts) con una clave que vive fuera de
-- esta base (MFA_ENCRYPTION_KEY). A diferencia del secreto de refresco
-- (`staff_refresh_tokens.token_hash`, SHA-256 de un solo sentido: solo hace
-- falta COMPARAR), el secreto TOTP hay que poder RECUPERARLO para calcular
-- el código vigente — un hash no sirve, tiene que ser cifrado reversible.
-- Nunca en texto plano, ni acá ni en una bitácora (docs/security-spec.md §6,
-- "tratalo con el mismo cuidado que un password").
--
-- El CHECK es asimétrico a propósito: exige el secreto cuando `mfa_enrolled`
-- es verdadero, pero NO exige que esté ausente cuando es falso — el flujo de
-- inscripción genera y guarda el secreto ANTES de confirmarlo con el primer
-- código (auth.mfa.enroll), y en ese punto intermedio `mfa_enrolled` sigue
-- en `false`. La bicondicional estricta (como la de `staff_sessions.revoked_at`
-- / `revoked_reason`, invariante 19/20) rompería ese estado transitorio.
--
-- `staff_sessions.mfa_verified_at`: por SESIÓN (familia de refresco), no por
-- usuario — cada login nuevo nace con este campo en NULL y lo satisface
-- `auth.mfa.verify` (o `auth.mfa.confirmEnroll`, la primera vez). Vive en
-- `staff_sessions` y no en `staff_users` porque es el estado de ESTA sesión,
-- exactamente igual que `revoked_at`/`last_used_at` ya viven ahí.
-- =====================================================================
SET search_path = app, public;

ALTER TABLE staff_users
  ADD COLUMN mfa_secret_encrypted text;

ALTER TABLE staff_users
  ADD CONSTRAINT staff_users_mfa_secret_required_when_enrolled
  CHECK (mfa_enrolled = false OR mfa_secret_encrypted IS NOT NULL);

ALTER TABLE staff_sessions
  ADD COLUMN mfa_verified_at timestamptz;

-- ---------------------------------------------------------------------
-- `find_staff_login_by_email` y `find_staff_refresh_token`
-- (0011_staff_sessions.sql, corregida en 0012) corren SECURITY DEFINER
-- ANTES de que exista `tenant_id` en contexto (mismo motivo que
-- 0011_staff_sessions.sql documenta). Login necesita saber si el usuario ya
-- está inscripto para dejar la sesión nueva en el estado correcto desde el
-- vamos; resolver el contexto de un request (resolveRequestSession, camino
-- lento) necesita lo mismo más `mfa_verified_at` de la sesión, para no
-- pagar una segunda consulta fuera de esta función SECURITY DEFINER.
--
-- No se puede `CREATE OR REPLACE` con un `RETURNS TABLE` distinto —
-- Postgres lo rechaza ("cannot change return type of existing function"),
-- mismo motivo que forzó el DROP+CREATE de 0012. `REVOKE`/`GRANT` no
-- sobreviven al DROP: hay que repetirlos.
-- ---------------------------------------------------------------------
DROP FUNCTION app.find_staff_login_by_email(text);

CREATE FUNCTION app.find_staff_login_by_email(p_email text)
RETURNS TABLE (
  id            uuid,
  tenant_id     uuid,
  auth_subject  text,
  is_active     boolean,
  mfa_enrolled  boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public AS $$
  SELECT id, tenant_id, auth_subject, is_active, mfa_enrolled
    FROM staff_users
   WHERE email = p_email
$$;

REVOKE ALL ON FUNCTION app.find_staff_login_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.find_staff_login_by_email(text) TO joda_api;

DROP FUNCTION app.find_staff_refresh_token(text);

CREATE FUNCTION app.find_staff_refresh_token(p_token_hash text)
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
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public AS $$
  SELECT t.id, t.tenant_id, t.session_id, t.consumed_at,
         s.staff_user_id, s.revoked_at, s.expires_at, s.mfa_verified_at,
         su.mfa_enrolled
    FROM staff_refresh_tokens t
    JOIN staff_sessions s ON s.id = t.session_id
    JOIN staff_users su ON su.id = s.staff_user_id
   WHERE t.token_hash = p_token_hash
$$;

REVOKE ALL ON FUNCTION app.find_staff_refresh_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.find_staff_refresh_token(text) TO joda_api;
