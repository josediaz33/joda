-- =====================================================================
-- 0008_fiscal.sql — frontera fiscal SIFEN / e-Kuatia
--
-- No construimos el integrador. Esta estructura es el puerto: el adaptador
-- 'manual' registra el CDC emitido en e-Kuatia'i; un adaptador de proveedor
-- homologado lo reemplaza sin tocar el resto del sistema.
--
-- Una venta puede generar 0, 1 o N documentos fiscales. Nunca colapsar
-- sale_order y factura en la misma tabla.
-- =====================================================================
SET search_path = app, public;

CREATE TABLE fiscal_config (
  tenant_id        uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  provider         text NOT NULL DEFAULT 'manual',   -- manual | <homologado>
  ruc              text NOT NULL,
  establishment    char(3) NOT NULL DEFAULT '001',
  expedition_point char(3) NOT NULL DEFAULT '001',
  timbrado         text,
  timbrado_from    date,
  timbrado_to      date,
  is_enabled       boolean NOT NULL DEFAULT false,
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fiscal_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sale_order_id uuid REFERENCES sale_orders(id) ON DELETE RESTRICT,
  doc_type      fiscal_doc_type NOT NULL,
  status        fiscal_status NOT NULL DEFAULT 'draft',
  provider      text NOT NULL DEFAULT 'manual',

  -- CDC: Código de Control del Documento, 44 dígitos.
  cdc           char(44),
  doc_number    text,                       -- 001-001-0000123
  security_code char(9),

  -- Desglose de IVA. En Paraguay el precio va con impuesto incluido:
  --   IVA 10% = gravado/11    IVA 5% = gravado/21
  -- El redondeo se resuelve a nivel de DOCUMENTO, que es lo que valida
  -- SIFEN, y la diferencia se imputa a la última línea.
  taxed_10_pyg  pyg NOT NULL DEFAULT 0 CHECK (taxed_10_pyg >= 0),
  taxed_5_pyg   pyg NOT NULL DEFAULT 0 CHECK (taxed_5_pyg >= 0),
  exempt_pyg    pyg NOT NULL DEFAULT 0 CHECK (exempt_pyg >= 0),
  vat_10_pyg    pyg NOT NULL DEFAULT 0 CHECK (vat_10_pyg >= 0),
  vat_5_pyg     pyg NOT NULL DEFAULT 0 CHECK (vat_5_pyg >= 0),
  total_pyg     pyg NOT NULL DEFAULT 0 CHECK (total_pyg >= 0),

  xml           text,
  kude_url      text,
  references_id uuid REFERENCES fiscal_documents(id),   -- NC/ND → doc original
  rejection_code text,
  rejection_msg  text,
  issued_at     timestamptz,
  approved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (cdc),
  CONSTRAINT fiscal_total_consistent CHECK (
    total_pyg = taxed_10_pyg + taxed_5_pyg + exempt_pyg
  ),
  -- Un documento aprobado tiene CDC. Sin excepciones.
  CONSTRAINT fiscal_approved_has_cdc CHECK (status <> 'approved' OR cdc IS NOT NULL),
  -- Una nota de crédito o débito referencia siempre un documento previo.
  CONSTRAINT fiscal_note_has_reference CHECK (
    doc_type NOT IN ('nota_credito', 'nota_debito') OR references_id IS NOT NULL
  )
);
CREATE INDEX fiscal_order  ON fiscal_documents (sale_order_id);
CREATE INDEX fiscal_status_idx ON fiscal_documents (tenant_id, status, issued_at DESC);

CREATE TABLE fiscal_document_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_document_id uuid NOT NULL REFERENCES fiscal_documents(id) ON DELETE CASCADE,
  sale_order_line_id uuid REFERENCES sale_order_lines(id) ON DELETE RESTRICT,
  description        text NOT NULL,
  qty                qty NOT NULL CHECK (qty > 0),
  unit_price_pyg     pyg NOT NULL CHECK (unit_price_pyg >= 0),
  vat_rate           vat_rate NOT NULL,
  gross_pyg          pyg NOT NULL CHECK (gross_pyg >= 0),
  vat_pyg            pyg NOT NULL DEFAULT 0 CHECK (vat_pyg >= 0),
  position           int NOT NULL DEFAULT 0
);

-- Bitácora de intercambio con SIFEN: envíos, respuestas, cancelaciones,
-- inutilizaciones y reintentos. Append-only.
CREATE TABLE fiscal_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fiscal_document_id uuid NOT NULL REFERENCES fiscal_documents(id) ON DELETE CASCADE,
  event_type         text NOT NULL,        -- submit | response | cancel | inutilize
  request_payload    jsonb,
  response_payload   jsonb,
  status_before      fiscal_status,
  status_after       fiscal_status,
  occurred_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_fiscal_updated BEFORE UPDATE ON fiscal_documents
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
