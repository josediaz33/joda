-- =====================================================================
-- 0006_sales.sql — canales, ventas, pagos, señas, devoluciones
-- =====================================================================
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- Canales de venta
-- ---------------------------------------------------------------------
CREATE TABLE sales_channels (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code         citext NOT NULL,            -- web | presencial | instagram | whatsapp
  name         text NOT NULL,
  stock_policy channel_stock_policy NOT NULL DEFAULT 'shared',
  price_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active    boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);

CREATE TABLE channel_listings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id         uuid NOT NULL REFERENCES sales_channels(id) ON DELETE CASCADE,
  variant_id         uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  price_override_pyg pyg CHECK (price_override_pyg IS NULL OR price_override_pyg >= 0),
  allocated_qty      qty CHECK (allocated_qty IS NULL OR allocated_qty >= 0),
  is_published       boolean NOT NULL DEFAULT false,
  UNIQUE (channel_id, variant_id)
);

-- ---------------------------------------------------------------------
-- Pedidos
-- ---------------------------------------------------------------------
CREATE TABLE sale_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id      uuid NOT NULL REFERENCES sales_channels(id) ON DELETE RESTRICT,
  customer_id     uuid REFERENCES customers(id) ON DELETE RESTRICT,
  code            text NOT NULL,
  status          sale_order_status NOT NULL DEFAULT 'draft',

  subtotal_pyg    pyg NOT NULL DEFAULT 0 CHECK (subtotal_pyg >= 0),
  discount_pyg    pyg NOT NULL DEFAULT 0 CHECK (discount_pyg >= 0),
  shipping_pyg    pyg NOT NULL DEFAULT 0 CHECK (shipping_pyg >= 0),
  total_pyg       pyg NOT NULL DEFAULT 0 CHECK (total_pyg >= 0),
  -- IVA incluido en el total (régimen paraguayo). Se guarda desglosado
  -- porque es lo que el documento fiscal tiene que declarar.
  vat_10_pyg      pyg NOT NULL DEFAULT 0 CHECK (vat_10_pyg >= 0),
  vat_5_pyg       pyg NOT NULL DEFAULT 0 CHECK (vat_5_pyg >= 0),
  exempt_pyg      pyg NOT NULL DEFAULT 0 CHECK (exempt_pyg >= 0),

  cogs_pyg        pyg NOT NULL DEFAULT 0,     -- costo de lo vendido, al confirmar
  shipping_address jsonb,
  notes           text,
  placed_at       timestamptz,
  confirmed_at    timestamptz,
  cancelled_at    timestamptz,
  created_by      uuid REFERENCES staff_users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CONSTRAINT order_total_consistent CHECK (
    total_pyg = subtotal_pyg - discount_pyg + shipping_pyg
  )
);
CREATE INDEX so_status  ON sale_orders (tenant_id, status, placed_at DESC);
CREATE INDEX so_customer ON sale_orders (tenant_id, customer_id, placed_at DESC);

CREATE TABLE sale_order_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_order_id  uuid NOT NULL REFERENCES sale_orders(id) ON DELETE CASCADE,
  variant_id     uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  serial_unit_id uuid REFERENCES serialized_units(id) ON DELETE RESTRICT,
  qty            qty NOT NULL CHECK (qty > 0),
  uom            uom NOT NULL,
  unit_price_pyg pyg NOT NULL CHECK (unit_price_pyg >= 0),
  discount_pyg   pyg NOT NULL DEFAULT 0 CHECK (discount_pyg >= 0),
  line_total_pyg pyg NOT NULL CHECK (line_total_pyg >= 0),
  vat_rate       vat_rate NOT NULL DEFAULT 'iva_10',
  vat_pyg        pyg NOT NULL DEFAULT 0 CHECK (vat_pyg >= 0),
  cogs_pyg       pyg NOT NULL DEFAULT 0,
  position       int NOT NULL DEFAULT 0,
  -- Una línea serializada mueve exactamente una unidad.
  CONSTRAINT serial_line_is_single CHECK (serial_unit_id IS NULL OR qty = 1)
);
CREATE INDEX sol_order ON sale_order_lines (sale_order_id, position);

ALTER TABLE serialized_units
  ADD CONSTRAINT serials_sold_line_fk
  FOREIGN KEY (sold_order_line_id) REFERENCES sale_order_lines(id);

ALTER TABLE decant_work_orders
  ADD CONSTRAINT decant_wo_order_fk
  FOREIGN KEY (sale_order_id) REFERENCES sale_orders(id);

CREATE TABLE sale_order_transitions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sale_order_id uuid NOT NULL REFERENCES sale_orders(id) ON DELETE CASCADE,
  from_status   sale_order_status,
  to_status     sale_order_status NOT NULL,
  actor_id      uuid,
  audience      actor_audience NOT NULL DEFAULT 'staff',
  reason        text,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shipments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sale_order_id uuid NOT NULL REFERENCES sale_orders(id) ON DELETE RESTRICT,
  carrier       text,
  tracking_code text,
  status        text NOT NULL DEFAULT 'pending',
  shipped_at    timestamptz,
  delivered_at  timestamptz
);

-- ---------------------------------------------------------------------
-- Pagos e idempotencia de webhooks
-- ---------------------------------------------------------------------
CREATE TABLE payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sale_order_id     uuid REFERENCES sale_orders(id) ON DELETE RESTRICT,
  method            payment_method NOT NULL,
  provider          text,                       -- bancard | pagopar | NULL
  provider_ref      text,                       -- id de transacción del proveedor
  status            payment_status NOT NULL DEFAULT 'pending',
  amount_pyg        pyg NOT NULL CHECK (amount_pyg > 0),
  -- El PAN NUNCA pasa por acá. Checkout hospedado: solo guardamos los
  -- últimos 4 dígitos y la marca, que no son datos de tarjeta bajo PCI.
  card_last4        char(4),
  card_brand        text,
  authorized_at     timestamptz,
  captured_at       timestamptz,
  failed_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);
CREATE INDEX payments_order ON payments (sale_order_id, status);

-- Bancard y Pagopar reintentan. Sin esta unicidad, un reintento confirma
-- dos veces la misma venta y descuenta el stock dos veces.
CREATE TABLE payment_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider          text NOT NULL,
  external_event_id text NOT NULL,
  payment_id        uuid REFERENCES payments(id) ON DELETE SET NULL,
  payload           jsonb NOT NULL,
  signature_valid   boolean,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  result            jsonb,
  UNIQUE (provider, external_event_id)
);

-- ---------------------------------------------------------------------
-- Señas: es plata que DEBÉS, no que ganaste.
-- ---------------------------------------------------------------------
CREATE TABLE customer_deposits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  sale_order_id uuid REFERENCES sale_orders(id) ON DELETE SET NULL,
  amount_pyg    pyg NOT NULL CHECK (amount_pyg > 0),
  applied_pyg   pyg NOT NULL DEFAULT 0 CHECK (applied_pyg >= 0),
  refunded_pyg  pyg NOT NULL DEFAULT 0 CHECK (refunded_pyg >= 0),
  payment_id    uuid REFERENCES payments(id),
  expires_at    date,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES staff_users(id),
  -- No se puede aplicar ni devolver más de lo que se recibió.
  CONSTRAINT deposit_not_over_applied CHECK (applied_pyg + refunded_pyg <= amount_pyg)
);
CREATE INDEX deposits_open ON customer_deposits (tenant_id, customer_id)
  WHERE applied_pyg + refunded_pyg < amount_pyg;

CREATE TABLE customer_deposit_applications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id    uuid NOT NULL REFERENCES customer_deposits(id) ON DELETE RESTRICT,
  sale_order_id uuid NOT NULL REFERENCES sale_orders(id) ON DELETE RESTRICT,
  amount_pyg    pyg NOT NULL CHECK (amount_pyg > 0),
  applied_at    timestamptz NOT NULL DEFAULT now(),
  applied_by    uuid REFERENCES staff_users(id)
);

-- ---------------------------------------------------------------------
-- Devoluciones y garantías
-- ---------------------------------------------------------------------
CREATE TABLE returns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sale_order_id uuid NOT NULL REFERENCES sale_orders(id) ON DELETE RESTRICT,
  customer_id   uuid REFERENCES customers(id) ON DELETE RESTRICT,
  code          text NOT NULL,
  status        rma_status NOT NULL DEFAULT 'requested',
  reason        text NOT NULL,
  is_warranty   boolean NOT NULL DEFAULT false,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  UNIQUE (tenant_id, code)
);

CREATE TABLE return_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id          uuid NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  sale_order_line_id uuid NOT NULL REFERENCES sale_order_lines(id) ON DELETE RESTRICT,
  serial_unit_id     uuid REFERENCES serialized_units(id) ON DELETE RESTRICT,
  qty                qty NOT NULL CHECK (qty > 0),
  disposition        rma_disposition,
  inspection_notes   text,
  refund_pyg         pyg NOT NULL DEFAULT 0 CHECK (refund_pyg >= 0)
);

CREATE TRIGGER trg_so_updated       BEFORE UPDATE ON sale_orders
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER trg_payments_updated BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
