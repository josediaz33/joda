-- =====================================================================
-- 0001_foundation.sql — extensiones, dominios, enums y helpers
-- JODA Parfums · esquema v4
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;      -- slugs, SKUs, emails case-insensitive
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- exclusion constraints mixtas

CREATE SCHEMA IF NOT EXISTS app;
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- Dominios monetarios
-- ---------------------------------------------------------------------
-- El guaraní no tiene subdivisión operativa: bigint de unidades enteras.
-- Sin CHECK de no-negatividad en el dominio: los asientos contables y los
-- ajustes de inventario legítimamente llevan signo. La no-negatividad se
-- impone columna por columna donde corresponde.
CREATE DOMAIN pyg AS bigint;

-- Monedas extranjeras en unidades menores (centavos). Nunca float.
CREATE DOMAIN minor_amount AS bigint;

CREATE DOMAIN currency_code AS char(3)
  CHECK (VALUE ~ '^[A-Z]{3}$');

-- Tipo de cambio: 8 decimales, suficiente para PYG/USD/BRL/ARS.
CREATE DOMAIN fx_rate AS numeric(18,8)
  CHECK (VALUE > 0);

-- Cantidades de inventario: 3 decimales (mililitros con precisión de 0,001).
CREATE DOMAIN qty AS numeric(14,3);

-- ---------------------------------------------------------------------
-- Enums de dominio
-- ---------------------------------------------------------------------
CREATE TYPE product_kind AS ENUM ('perfume', 'watch', 'accessory');
CREATE TYPE product_status AS ENUM ('draft', 'active', 'archived');
CREATE TYPE uom AS ENUM ('unit', 'ml');
-- 'bulk' = líquido de un frasco abierto, medido en ml. No se vende directo:
-- es el origen de los decants. Nace cuando se abre un sellado.
CREATE TYPE variant_type AS ENUM
  ('sealed', 'decant', 'tester', 'unit', 'supply', 'bulk');

-- Cómo llega a existir el stock de una variante.
--   stocked        : se produce por anticipado (hay lotes propios)
--   made_to_order  : se produce al vender, consumiendo granel + BOM
CREATE TYPE production_mode AS ENUM ('stocked', 'made_to_order');

CREATE TYPE perfume_concentration AS ENUM
  ('parfum', 'extrait', 'edp', 'edt', 'edc', 'oil', 'attar');

CREATE TYPE watch_movement AS ENUM
  ('quartz', 'automatic', 'manual', 'solar', 'kinetic', 'spring_drive');

CREATE TYPE movement_type AS ENUM (
  'purchase_receipt',    -- entrada por recepción de compra
  'sale',                -- salida por venta
  'return_in',           -- devolución de cliente
  'return_out',          -- devolución a proveedor
  'decant_consumption',  -- líquido consumido del frasco fuente
  'decant_yield',        -- producto fraccionado resultante
  'bom_consumption',     -- insumo consumido (frasco, atomizador, etiqueta)
  'waste',               -- merma técnica (trasvase, residuo, evaporación)
  'adjustment',          -- ajuste de inventario (incluye saldo de apertura)
  'transfer_in',
  'transfer_out'
);

CREATE TYPE allocation_policy AS ENUM ('fifo', 'fefo', 'serial', 'manual');

CREATE TYPE lot_status AS ENUM
  ('available', 'open_for_decant', 'quarantine', 'damaged', 'depleted');

CREATE TYPE serial_status AS ENUM
  ('available', 'reserved', 'sold', 'quarantine', 'damaged', 'returned', 'refurbished');

CREATE TYPE reservation_reason AS ENUM
  ('checkout', 'order_pending_payment', 'deposit_hold', 'decant_hold', 'manual_hold');

CREATE TYPE po_status AS ENUM (
  'draft', 'pending_approval', 'approved', 'sent',
  'partially_received', 'received', 'cancelled'
);

CREATE TYPE receipt_status AS ENUM ('draft', 'posted', 'cancelled');

CREATE TYPE freight_allocation_method AS ENUM ('by_value', 'by_unit', 'by_volume', 'manual');

CREATE TYPE sale_order_status AS ENUM (
  'draft', 'awaiting_payment', 'paid', 'preparing',
  'ready', 'shipped', 'delivered', 'cancelled', 'refunded'
);

CREATE TYPE payment_status AS ENUM
  ('pending', 'authorized', 'captured', 'failed', 'refunded', 'chargeback');

CREATE TYPE payment_method AS ENUM
  ('card', 'transfer_sipap', 'cash', 'wallet', 'deposit_applied', 'other');

CREATE TYPE channel_stock_policy AS ENUM ('shared', 'allocated');

CREATE TYPE decant_wo_status AS ENUM ('pending', 'in_progress', 'done', 'cancelled');

CREATE TYPE account_type AS ENUM
  ('asset', 'liability', 'equity', 'revenue', 'expense');

CREATE TYPE journal_status AS ENUM ('draft', 'posted', 'reversed');

CREATE TYPE fiscal_doc_type AS ENUM
  ('factura', 'nota_credito', 'nota_debito', 'autofactura', 'nota_remision');

CREATE TYPE fiscal_status AS ENUM
  ('draft', 'queued', 'sent', 'approved', 'rejected', 'cancelled', 'contingency');

CREATE TYPE vat_rate AS ENUM ('iva_10', 'iva_5', 'exenta');

CREATE TYPE rma_status AS ENUM
  ('requested', 'received', 'inspection', 'approved', 'rejected', 'resolved');

CREATE TYPE rma_disposition AS ENUM
  ('restock_available', 'quarantine', 'open_box', 'refurbished', 'damaged', 'supplier_return');

CREATE TYPE actor_audience AS ENUM ('staff', 'customer', 'system');

-- ---------------------------------------------------------------------
-- Contexto de sesión
-- ---------------------------------------------------------------------
-- La API abre cada transacción con:
--   SELECT set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true);
-- El tercer parámetro `true` hace el valor local a la transacción, de modo
-- que no se filtra a otra request que reutilice la misma conexión del pool.

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_audience() RETURNS actor_audience
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('app.audience', true), ''), 'system')::actor_audience
$$;

-- ---------------------------------------------------------------------
-- Helpers genéricos
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Guarda de inmutabilidad para tablas append-only (ledger, asientos, eventos).
CREATE OR REPLACE FUNCTION app.guard_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'La tabla %.% es append-only; operación % rechazada',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

-- Redondeo de guaraníes: media unidad hacia arriba, en un solo lugar.
-- Toda regla de IVA e imputación de diferencias usa esta función.
CREATE OR REPLACE FUNCTION app.round_pyg(v numeric) RETURNS pyg
LANGUAGE sql IMMUTABLE AS $$
  SELECT round(v, 0)::bigint::pyg
$$;

-- IVA paraguayo sobre precio con impuesto incluido:
--   10% -> total/11    5% -> total/21    exenta -> 0
CREATE OR REPLACE FUNCTION app.vat_from_gross(gross pyg, rate vat_rate) RETURNS pyg
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE rate
    WHEN 'iva_10' THEN app.round_pyg(gross::numeric / 11)
    WHEN 'iva_5'  THEN app.round_pyg(gross::numeric / 21)
    ELSE 0::pyg
  END
$$;
