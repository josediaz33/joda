-- =====================================================================
-- 0002_identity_rbac.sql — tenants, identidades, RBAC, auditoría
-- =====================================================================
SET search_path = app, public;

CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          citext NOT NULL UNIQUE,
  legal_name    text NOT NULL,
  trade_name    text NOT NULL,
  ruc           text,                    -- RUC paraguayo, formato NNNNNNN-D
  base_currency currency_code NOT NULL DEFAULT 'PYG',
  timezone      text NOT NULL DEFAULT 'America/Asuncion',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Identidades: DOS tablas, deliberadamente.
-- Un cliente no puede escalar a staff porque no existe fila donde ponerle
-- el rol. Es un invariante de esquema, no una validación de runtime.
-- ---------------------------------------------------------------------
CREATE TABLE staff_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  auth_subject   text NOT NULL,          -- sub del proveedor de auth (Supabase/Clerk)
  email          citext NOT NULL,
  full_name      text NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  mfa_enrolled   boolean NOT NULL DEFAULT false,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email),
  UNIQUE (auth_subject)
);

CREATE TABLE customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  auth_subject  text UNIQUE,             -- NULL = cliente invitado / mostrador
  email         citext,
  full_name     text NOT NULL,
  phone         text,
  doc_type      text,                    -- CI | RUC | pasaporte
  doc_number    text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE customer_addresses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label        text,
  line1        text NOT NULL,
  line2        text,
  city         text NOT NULL,
  department   text,                     -- Itapúa, Central, Alto Paraná...
  country      char(2) NOT NULL DEFAULT 'PY',
  is_default   boolean NOT NULL DEFAULT false
);

-- ---------------------------------------------------------------------
-- RBAC
-- ---------------------------------------------------------------------
CREATE TABLE permissions (
  code        text PRIMARY KEY,          -- recurso.subrecurso:acción
  description text NOT NULL
);

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL,
  name        text NOT NULL,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE role_permissions (
  role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE staff_user_roles (
  staff_user_id uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  granted_by    uuid REFERENCES staff_users(id),
  PRIMARY KEY (staff_user_id, role_id)
);

-- Resolución de permisos del usuario en sesión. La API cachea esto en Redis
-- con TTL corto; las políticas RLS lo consultan como última línea de defensa.
CREATE OR REPLACE FUNCTION app.has_permission(p_code text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, public AS $$
  SELECT app.current_audience() = 'staff'
     AND EXISTS (
       SELECT 1
       FROM staff_user_roles sur
       JOIN role_permissions rp ON rp.role_id = sur.role_id
       WHERE sur.staff_user_id = app.current_user_id()
         AND rp.permission_code = p_code
     )
$$;

-- ---------------------------------------------------------------------
-- Auditoría — append-only
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  actor_id     uuid,
  audience     actor_audience NOT NULL,
  action       text NOT NULL,            -- 'sale.confirm', 'stock.adjust', ...
  entity       text NOT NULL,
  entity_id    uuid,
  before       jsonb,
  after        jsonb,
  ip           inet,
  user_agent   text,
  request_id   text,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_entity     ON audit_log (tenant_id, entity, entity_id, occurred_at DESC);
CREATE INDEX audit_log_actor_time ON audit_log (tenant_id, actor_id, occurred_at DESC);

-- ---------------------------------------------------------------------
-- Idempotencia general (webhooks de pago, mutaciones offline del admin)
-- ---------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope         text NOT NULL,           -- 'api' | 'webhook:bancard' | 'webhook:pagopar'
  key           text NOT NULL,
  request_hash  text NOT NULL,           -- detecta reuso de clave con payload distinto
  response      jsonb,
  status_code   int,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  UNIQUE (tenant_id, scope, key)
);

CREATE TRIGGER trg_tenants_updated      BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER trg_staff_users_updated  BEFORE UPDATE ON staff_users
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER trg_customers_updated    BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
