-- =====================================================================
-- 0004_inventory.sql — Kardex append-only
--   inventory_lots  : la unidad física comprada, con su costo puesto acá
--   inventory_movements : LIBRO MAYOR. Inmutable. Fuente de verdad.
--   inventory_balances  : proyección mantenida por trigger + invariante >= 0
--   movement_cost_allocations : qué capa de costo consumió cada salida
-- =====================================================================
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- Lotes
-- ---------------------------------------------------------------------
CREATE TABLE inventory_lots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  variant_id          uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  lot_code            text,
  batch_code          text,                    -- lote del fabricante
  -- Apertura de frasco: el sellado sale como unidad y nace un lote hijo
  -- de granel medido en ml, que hereda el costo. Un lote tiene UNA unidad
  -- de medida; convertir dentro del mismo lote sería mezclar peras y ml.
  parent_lot_id       uuid REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  status              lot_status NOT NULL DEFAULT 'available',
  qty_initial         qty NOT NULL CHECK (qty_initial > 0),
  uom                 uom NOT NULL,

  -- Costo: moneda de compra + snapshot de FX + costo final en guaraníes.
  -- landed_cost_pyg incluye flete, impuestos y comisiones prorrateados.
  unit_cost_minor     minor_amount NOT NULL CHECK (unit_cost_minor >= 0),
  currency            currency_code NOT NULL,
  fx_rate_to_pyg      fx_rate NOT NULL,
  landed_cost_pyg     pyg NOT NULL CHECK (landed_cost_pyg >= 0),  -- del lote entero
  unit_landed_cost_pyg pyg NOT NULL CHECK (unit_landed_cost_pyg >= 0),

  goods_receipt_line_id uuid,                  -- FK agregada en 0005
  manufactured_at     date,
  expiry_at           date,
  opened_at           timestamptz,             -- cuándo se abrió para decantar
  received_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (expiry_at IS NULL OR manufactured_at IS NULL OR expiry_at > manufactured_at)
);
CREATE INDEX lots_variant_fifo ON inventory_lots (tenant_id, variant_id, received_at)
  WHERE status IN ('available', 'open_for_decant');
CREATE INDEX lots_variant_fefo ON inventory_lots (tenant_id, variant_id, expiry_at)
  WHERE status IN ('available', 'open_for_decant') AND expiry_at IS NOT NULL;

-- ---------------------------------------------------------------------
-- Unidades serializadas (relojes)
-- Un reloj de USD 800 no es "cantidad = 1".
-- ---------------------------------------------------------------------
CREATE TABLE serialized_units (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  variant_id     uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  lot_id         uuid REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  serial_number  text NOT NULL,
  status         serial_status NOT NULL DEFAULT 'available',
  warranty_until date,
  sold_order_line_id uuid,                     -- FK agregada en 0006
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, serial_number)
);
CREATE INDEX serials_variant_status ON serialized_units (tenant_id, variant_id, status);

-- ---------------------------------------------------------------------
-- LEDGER — append-only, inmutable
-- ---------------------------------------------------------------------
CREATE TABLE inventory_movements (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  lot_id         uuid NOT NULL REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  variant_id     uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  serial_unit_id uuid REFERENCES serialized_units(id) ON DELETE RESTRICT,
  qty            qty NOT NULL CHECK (qty <> 0),     -- con signo: + entrada, - salida
  uom            uom NOT NULL,
  movement_type  movement_type NOT NULL,
  total_cost_pyg pyg,                              -- costo consumido/incorporado
  reference_type text,                             -- 'sale_order' | 'goods_receipt' | ...
  reference_id   uuid,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES staff_users(id),
  note           text,
  -- Coherencia de signo por tipo de movimiento: las entradas suman, las
  -- salidas restan. Un 'sale' con qty positiva es un error de código.
  CONSTRAINT movement_sign_matches_type CHECK (
    (movement_type IN ('purchase_receipt','return_in','decant_yield',
                       'transfer_in') AND qty > 0)
    OR
    (movement_type IN ('sale','return_out','decant_consumption','bom_consumption',
                       'waste','transfer_out') AND qty < 0)
    OR
    (movement_type = 'adjustment')                 -- el ajuste puede ir en ambos sentidos
  )
);
CREATE INDEX mov_lot_time  ON inventory_movements (lot_id, occurred_at, id);
CREATE INDEX mov_variant   ON inventory_movements (tenant_id, variant_id, occurred_at DESC);
CREATE INDEX mov_reference ON inventory_movements (reference_type, reference_id);

-- ---------------------------------------------------------------------
-- Asignación de capas de costo (FIFO / promedio ponderado)
-- Una venta de 3 unidades puede consumir dos lotes con costos distintos.
-- Sin esto el COGS es una aproximación y no cierra contra contabilidad.
-- ---------------------------------------------------------------------
CREATE TABLE movement_cost_allocations (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  movement_id    bigint NOT NULL REFERENCES inventory_movements(id) ON DELETE RESTRICT,
  lot_id         uuid NOT NULL REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  qty            qty NOT NULL CHECK (qty > 0),
  unit_cost_pyg  pyg NOT NULL CHECK (unit_cost_pyg >= 0),
  total_cost_pyg pyg NOT NULL CHECK (total_cost_pyg >= 0)
);
CREATE INDEX mca_movement ON movement_cost_allocations (movement_id);

-- ---------------------------------------------------------------------
-- Proyección de saldos — derivada, verificable, con invariante no-negativo
-- ---------------------------------------------------------------------
CREATE TABLE inventory_balances (
  lot_id      uuid PRIMARY KEY REFERENCES inventory_lots(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL,
  variant_id  uuid NOT NULL,
  on_hand     qty NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- EL invariante. Un saldo negativo es un bug, y acá se corta.
  CONSTRAINT balance_non_negative CHECK (on_hand >= 0)
);
CREATE INDEX balances_variant ON inventory_balances (tenant_id, variant_id)
  WHERE on_hand > 0;

-- ---------------------------------------------------------------------
-- Reservas — separadas del ledger.
-- El carrito NO reserva: reservar al agregar al carrito permite que
-- cualquiera bloquee inventario de piezas únicas abriendo pestañas.
-- La reserva nace al iniciar checkout, con TTL según medio de pago.
-- ---------------------------------------------------------------------
CREATE TABLE stock_reservations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  variant_id     uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  lot_id         uuid REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  serial_unit_id uuid REFERENCES serialized_units(id) ON DELETE RESTRICT,
  qty            qty NOT NULL CHECK (qty > 0),
  reason         reservation_reason NOT NULL,
  reference_type text,
  reference_id   uuid,
  expires_at     timestamptz NOT NULL,
  released_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES staff_users(id)
);
CREATE INDEX reservations_live ON stock_reservations (tenant_id, variant_id)
  WHERE released_at IS NULL;
CREATE INDEX reservations_expiry ON stock_reservations (expires_at)
  WHERE released_at IS NULL;

-- ---------------------------------------------------------------------
-- Órdenes de fraccionamiento
-- El decant tiene DOS momentos: el compromiso comercial (checkout) y la
-- transformación física (alguien llena el vial). La merma real se conoce
-- recién en el segundo. Esta tabla es el puente entre ambos.
-- ---------------------------------------------------------------------
CREATE TABLE decant_work_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_lot_id    uuid NOT NULL REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  target_variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  sale_order_id    uuid,                        -- FK agregada en 0006
  qty_units        integer NOT NULL CHECK (qty_units > 0),
  ml_per_unit      numeric(10,3) NOT NULL CHECK (ml_per_unit > 0),
  ml_expected      numeric(10,3) NOT NULL CHECK (ml_expected > 0),
  waste_expected   numeric(10,3) NOT NULL CHECK (waste_expected >= 0),
  waste_actual     numeric(10,3) CHECK (waste_actual >= 0),
  status           decant_wo_status NOT NULL DEFAULT 'pending',
  executed_by      uuid REFERENCES staff_users(id),
  executed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES staff_users(id),
  -- Una orden ejecutada tiene que declarar merma real y ejecutor.
  CONSTRAINT decant_done_requires_actuals CHECK (
    status <> 'done'
    OR (waste_actual IS NOT NULL AND executed_at IS NOT NULL AND executed_by IS NOT NULL)
  )
);
CREATE INDEX decant_wo_pending ON decant_work_orders (tenant_id, status)
  WHERE status IN ('pending', 'in_progress');

CREATE TRIGGER trg_lots_updated    BEFORE UPDATE ON inventory_lots
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER trg_serials_updated BEFORE UPDATE ON serialized_units
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
