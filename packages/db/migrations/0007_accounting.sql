-- =====================================================================
-- 0007_accounting.sql — partida doble
--
-- Principio rector: los asientos NO se cargan a mano. Se DERIVAN de
-- eventos de negocio mediante reglas de posteo. El operador confirma una
-- venta; el sistema genera el asiento. Un ERP que exige saber contabilidad
-- para operar es un ERP que no se usa.
-- =====================================================================
SET search_path = app, public;

CREATE TABLE chart_of_accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code         text NOT NULL,              -- '1.1.01.001'
  name         text NOT NULL,
  account_type account_type NOT NULL,
  parent_id    uuid REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  -- Solo las cuentas imputables reciben asientos; las de agrupación no.
  is_postable  boolean NOT NULL DEFAULT true,
  currency     currency_code,              -- NULL = multimoneda valuada en PYG
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX coa_type ON chart_of_accounts (tenant_id, account_type, code);

CREATE TABLE accounting_periods (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code       text NOT NULL,                -- '2026-09'
  starts_on  date NOT NULL,
  ends_on    date NOT NULL,
  is_closed  boolean NOT NULL DEFAULT false,
  closed_at  timestamptz,
  closed_by  uuid REFERENCES staff_users(id),
  UNIQUE (tenant_id, code),
  CHECK (ends_on >= starts_on)
);

CREATE TABLE journal_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_id     uuid NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  entry_no      bigint NOT NULL,
  entry_date    date NOT NULL,
  status        journal_status NOT NULL DEFAULT 'draft',
  memo          text NOT NULL,
  -- Trazabilidad al hecho económico que lo originó.
  source_type   text,                      -- 'sale_order' | 'goods_receipt' | ...
  source_id     uuid,
  posting_rule  text,
  reverses_id   uuid REFERENCES journal_entries(id),
  posted_at     timestamptz,
  created_by    uuid REFERENCES staff_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entry_no),
  CONSTRAINT je_posted_has_timestamp CHECK (status <> 'posted' OR posted_at IS NOT NULL)
);
CREATE INDEX je_source ON journal_entries (source_type, source_id);
CREATE INDEX je_period ON journal_entries (tenant_id, period_id, entry_date);

CREATE TABLE journal_lines (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id       uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id     uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  debit_pyg      pyg NOT NULL DEFAULT 0 CHECK (debit_pyg >= 0),
  credit_pyg     pyg NOT NULL DEFAULT 0 CHECK (credit_pyg >= 0),
  -- Importe en moneda de origen, cuando la operación fue en USD/BRL.
  amount_minor   minor_amount,
  currency       currency_code,
  fx_rate_to_pyg fx_rate,
  memo           text,
  position       int NOT NULL DEFAULT 0,
  -- Una línea es débito o crédito, nunca ambos, nunca ninguno.
  CONSTRAINT line_is_debit_xor_credit CHECK (
    (debit_pyg > 0 AND credit_pyg = 0) OR (credit_pyg > 0 AND debit_pyg = 0)
  )
);
CREATE INDEX jl_entry   ON journal_lines (entry_id, position);
CREATE INDEX jl_account ON journal_lines (account_id);

-- ---------------------------------------------------------------------
-- Motor de posteo
-- ---------------------------------------------------------------------
CREATE TABLE posting_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL,               -- 'sale.confirmed', 'receipt.posted'
  description text NOT NULL,
  -- Plantilla declarativa: [{leg:'debit', account:'1.1.01.001', source:'total_pyg'}, ...]
  template    jsonb NOT NULL,
  is_enabled  boolean NOT NULL DEFAULT false,   -- se encienden de a una
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

-- Bandeja de eventos sin postear. Mientras una regla esté apagada, el
-- evento cae acá: visible y reprocesable, nunca silenciosamente perdido.
CREATE TABLE unposted_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_code  text NOT NULL,
  source_type text NOT NULL,
  source_id   uuid NOT NULL,
  payload     jsonb NOT NULL,
  reason      text NOT NULL,               -- 'rule_disabled' | 'rule_missing' | 'error'
  occurred_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  entry_id    uuid REFERENCES journal_entries(id)
);
CREATE INDEX unposted_open ON unposted_events (tenant_id, occurred_at)
  WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------
-- Invariante: todo asiento cuadra. Constraint DIFERIDA, porque se valida
-- al COMMIT, cuando ya están insertadas todas las líneas.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry uuid := COALESCE(NEW.entry_id, OLD.entry_id);
  v_debit  bigint;
  v_credit bigint;
BEGIN
  SELECT COALESCE(sum(debit_pyg), 0), COALESCE(sum(credit_pyg), 0)
    INTO v_debit, v_credit
    FROM journal_lines WHERE entry_id = v_entry;

  IF v_debit <> v_credit THEN
    RAISE EXCEPTION
      'Asiento % descuadrado: debe=% haber=% (diferencia %)',
      v_entry, v_debit, v_credit, v_debit - v_credit
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_journal_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_entry_balanced();

-- Mayor y balance de sumas y saldos, derivados. Sin tablas de saldos que
-- se puedan desincronizar.
CREATE VIEW v_trial_balance AS
SELECT
  je.tenant_id,
  je.period_id,
  coa.id           AS account_id,
  coa.code         AS account_code,
  coa.name         AS account_name,
  coa.account_type,
  sum(jl.debit_pyg)  AS total_debit_pyg,
  sum(jl.credit_pyg) AS total_credit_pyg,
  CASE WHEN coa.account_type IN ('asset', 'expense')
       THEN sum(jl.debit_pyg) - sum(jl.credit_pyg)
       ELSE sum(jl.credit_pyg) - sum(jl.debit_pyg)
  END AS balance_pyg
FROM journal_lines jl
JOIN journal_entries je   ON je.id = jl.entry_id AND je.status = 'posted'
JOIN chart_of_accounts coa ON coa.id = jl.account_id
GROUP BY je.tenant_id, je.period_id, coa.id, coa.code, coa.name, coa.account_type;
