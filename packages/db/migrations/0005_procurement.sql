-- =====================================================================
-- 0005_procurement.sql — Market: proveedores, compras, recepciones, sourcing
-- =====================================================================
SET search_path = app, public;

CREATE TABLE suppliers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code              citext NOT NULL,
  name              text NOT NULL,
  country           char(2),
  default_currency  currency_code NOT NULL DEFAULT 'USD',
  payment_terms_days int NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0),
  lead_time_days    int CHECK (lead_time_days >= 0),
  is_active         boolean NOT NULL DEFAULT true,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE supplier_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  name        text NOT NULL,
  role        text,
  email       citext,
  phone       text,
  is_primary  boolean NOT NULL DEFAULT false
);

-- ---------------------------------------------------------------------
-- Órdenes de compra
-- ---------------------------------------------------------------------
CREATE TABLE purchase_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  supplier_id       uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  code              text NOT NULL,
  status            po_status NOT NULL DEFAULT 'draft',
  currency          currency_code NOT NULL,
  fx_rate_to_pyg    fx_rate,                    -- estimado; el real se fija al recibir
  freight_minor     minor_amount NOT NULL DEFAULT 0 CHECK (freight_minor >= 0),
  customs_minor     minor_amount NOT NULL DEFAULT 0 CHECK (customs_minor >= 0),
  other_costs_minor minor_amount NOT NULL DEFAULT 0 CHECK (other_costs_minor >= 0),
  freight_method    freight_allocation_method NOT NULL DEFAULT 'by_value',
  expected_at       date,
  notes             text,
  created_by        uuid NOT NULL REFERENCES staff_users(id),
  approved_by       uuid REFERENCES staff_users(id),
  approved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  -- Estados posteriores a la aprobación exigen constancia de quién aprobó.
  CONSTRAINT po_approved_has_approver CHECK (
    status NOT IN ('approved','sent','partially_received','received')
    OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
);
CREATE INDEX po_supplier_status ON purchase_orders (tenant_id, supplier_id, status);

CREATE TABLE purchase_order_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  variant_id        uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  qty_ordered       qty NOT NULL CHECK (qty_ordered > 0),
  qty_received      qty NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  uom               uom NOT NULL,
  unit_price_minor  minor_amount NOT NULL CHECK (unit_price_minor >= 0),
  destination       text,                       -- venta | reposición | encargo
  position          int NOT NULL DEFAULT 0,
  CHECK (qty_received <= qty_ordered)
);
CREATE INDEX pol_order ON purchase_order_lines (purchase_order_id, position);

-- Historial de transiciones: la máquina de estados vive en packages/domain,
-- pero su recorrido queda registrado acá para auditoría.
CREATE TABLE purchase_order_transitions (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  from_status       po_status,
  to_status         po_status NOT NULL,
  actor_id          uuid REFERENCES staff_users(id),
  reason            text,
  occurred_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Recepciones — entidad propia.
-- Una PO puede llegar en tres tandas, con tres fletes distintos.
-- Nunca "po.status = received; stock += qty".
-- ---------------------------------------------------------------------
CREATE TABLE goods_receipts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  code              text NOT NULL,
  status            receipt_status NOT NULL DEFAULT 'draft',
  -- FX y costos REALES de esta recepción concreta, no los estimados de la PO.
  fx_rate_to_pyg    fx_rate NOT NULL,
  freight_minor     minor_amount NOT NULL DEFAULT 0 CHECK (freight_minor >= 0),
  customs_minor     minor_amount NOT NULL DEFAULT 0 CHECK (customs_minor >= 0),
  other_costs_minor minor_amount NOT NULL DEFAULT 0 CHECK (other_costs_minor >= 0),
  freight_method    freight_allocation_method NOT NULL DEFAULT 'by_value',
  received_at       timestamptz NOT NULL DEFAULT now(),
  received_by       uuid NOT NULL REFERENCES staff_users(id),
  posted_at         timestamptz,
  notes             text,
  UNIQUE (tenant_id, code),
  CONSTRAINT receipt_posted_has_timestamp CHECK (
    status <> 'posted' OR posted_at IS NOT NULL
  )
);

CREATE TABLE goods_receipt_lines (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_receipt_id       uuid NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  purchase_order_line_id uuid NOT NULL REFERENCES purchase_order_lines(id) ON DELETE RESTRICT,
  variant_id             uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  qty_received           qty NOT NULL CHECK (qty_received > 0),
  uom                    uom NOT NULL,
  unit_price_minor       minor_amount NOT NULL CHECK (unit_price_minor >= 0),
  allocated_freight_pyg  pyg NOT NULL DEFAULT 0 CHECK (allocated_freight_pyg >= 0),
  lot_id                 uuid REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  batch_code             text,
  expiry_at              date
);
CREATE INDEX grl_receipt ON goods_receipt_lines (goods_receipt_id);

ALTER TABLE inventory_lots
  ADD CONSTRAINT lots_receipt_line_fk
  FOREIGN KEY (goods_receipt_line_id) REFERENCES goods_receipt_lines(id);

-- ---------------------------------------------------------------------
-- Sourcing: simulación pura. No toca inventario, ni caja, ni CxP.
-- ---------------------------------------------------------------------
CREATE TABLE sourcing_scenarios (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  assumptions jsonb NOT NULL DEFAULT '{}'::jsonb,   -- fx asumido, flete, aranceles
  converted_to_po_id uuid REFERENCES purchase_orders(id),
  created_by  uuid NOT NULL REFERENCES staff_users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sourcing_scenario_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id          uuid NOT NULL REFERENCES sourcing_scenarios(id) ON DELETE CASCADE,
  supplier_id          uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  variant_id           uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  qty                  qty NOT NULL CHECK (qty > 0),
  unit_price_minor     minor_amount NOT NULL CHECK (unit_price_minor >= 0),
  currency             currency_code NOT NULL,
  fx_assumed           fx_rate NOT NULL,
  lead_time_days       int CHECK (lead_time_days >= 0),
  projected_landed_pyg pyg NOT NULL DEFAULT 0,
  projected_price_pyg  pyg NOT NULL DEFAULT 0,
  projected_margin_pct numeric(7,3),
  variant_label        text                        -- 'A' | 'B' para comparar escenarios
);

CREATE TRIGGER trg_suppliers_updated BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER trg_po_updated        BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
