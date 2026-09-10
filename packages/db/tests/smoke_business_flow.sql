-- =====================================================================
-- smoke_business_flow.sql
-- Operación real de punta a punta, con los números de un frasco de nicho:
--   compra en USD → recepción con flete → apertura para decantar →
--   fraccionamiento con merma → venta del decant → asiento contable
-- y verificación de que los invariantes efectivamente disparan.
-- =====================================================================
\set ON_ERROR_STOP on
SET search_path = app, public;

\echo '=============================================================='
\echo ' 1. Tenant, usuario y datos maestros'
\echo '=============================================================='

INSERT INTO tenants (id, slug, legal_name, trade_name, ruc)
VALUES ('11111111-1111-1111-1111-111111111111', 'joda',
        'JODA Parfums SRL', 'JODA Parfums', '80012345-6');

SELECT app.seed_chart_of_accounts('11111111-1111-1111-1111-111111111111');
SELECT app.seed_roles('11111111-1111-1111-1111-111111111111');
SELECT app.seed_posting_rules('11111111-1111-1111-1111-111111111111');

INSERT INTO staff_users (id, tenant_id, auth_subject, email, full_name, mfa_enrolled)
VALUES ('22222222-2222-2222-2222-222222222222',
        '11111111-1111-1111-1111-111111111111',
        'auth|jose', 'jose@jodaparfums.com', 'José', true);

INSERT INTO staff_user_roles (staff_user_id, role_id)
SELECT '22222222-2222-2222-2222-222222222222', id
  FROM roles WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND code = 'owner';

INSERT INTO brands (id, tenant_id, slug, name, country)
VALUES ('33333333-3333-3333-3333-333333333333',
        '11111111-1111-1111-1111-111111111111', 'parfums-de-marly',
        'Parfums de Marly', 'FR');

INSERT INTO categories (id, tenant_id, slug, name, path) VALUES
  ('c0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'perfumeria', 'Perfumería', 'perfumeria'),
  ('c0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'nicho', 'Perfumes de Nicho', 'perfumeria/nicho'),
  ('c0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
   'decants', 'Decants', 'perfumeria/decants');
UPDATE categories SET parent_id = 'c0000000-0000-0000-0000-000000000001'
 WHERE id IN ('c0000000-0000-0000-0000-000000000002',
              'c0000000-0000-0000-0000-000000000003');

\echo '--- Producto perfume (CTI: products + perfume_details)'
INSERT INTO products (id, tenant_id, kind, brand_id, slug, name, status, published_at, facets)
VALUES ('44444444-4444-4444-4444-444444444444',
        '11111111-1111-1111-1111-111111111111', 'perfume',
        '33333333-3333-3333-3333-333333333333', 'layton', 'Layton',
        'active', now(),
        '{"familia":"ambar-vainilla","genero":"unisex","temporada":["otono","invierno"]}');

INSERT INTO perfume_details (product_id, concentration, nominal_volume_ml,
                             olfactory_family, notes_top, notes_heart, notes_base,
                             waste_factor, unusable_residue_ml)
VALUES ('44444444-4444-4444-4444-444444444444', 'edp', 125,
        'Ámbar Vainilla', '{bergamota,manzana,lavanda}', '{jazmín,violeta,geranio}',
        '{vainilla,sándalo,pachulí}', 0.02, 2.5);

-- Un producto vive en varias categorías comerciales a la vez.
INSERT INTO product_categories (product_id, category_id, is_primary) VALUES
  ('44444444-4444-4444-4444-444444444444', 'c0000000-0000-0000-0000-000000000002', true),
  ('44444444-4444-4444-4444-444444444444', 'c0000000-0000-0000-0000-000000000003', false);

\echo '--- Variantes: sellado 125ml, granel, decant 10ml (bajo pedido), insumos'
INSERT INTO product_variants (id, tenant_id, product_id, sku, variant_type, uom,
                              size_ml, price_pyg, online_visible, production_mode)
VALUES ('55555555-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
        '44444444-4444-4444-4444-444444444444', 'LAY-125-SEALED', 'sealed', 'unit',
        125, 2450000, true, 'stocked'),
       ('55555555-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
        '44444444-4444-4444-4444-444444444444', 'LAY-BULK', 'bulk', 'ml',
        NULL, 0, false, 'stocked');

-- El decant se produce al vender, consumiendo granel + insumos.
INSERT INTO product_variants (id, tenant_id, product_id, sku, variant_type, uom,
                              size_ml, price_pyg, online_visible,
                              production_mode, source_variant_id)
VALUES ('55555555-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
        '44444444-4444-4444-4444-444444444444', 'LAY-DEC-10', 'decant', 'ml',
        10, 245000, true, 'made_to_order', '55555555-0000-0000-0000-000000000002');

-- Insumos: su propio producto, sus propias variantes, su propio stock.
INSERT INTO products (id, tenant_id, kind, slug, name, status)
VALUES ('44444444-0000-0000-0000-00000000aaaa',
        '11111111-1111-1111-1111-111111111111', 'accessory', 'insumos-decant',
        'Insumos de fraccionamiento', 'active');
INSERT INTO accessory_details (product_id, material) VALUES
  ('44444444-0000-0000-0000-00000000aaaa', 'vidrio/plástico');

INSERT INTO product_variants (id, tenant_id, product_id, sku, variant_type, uom,
                              price_pyg, online_visible) VALUES
  ('55555555-0000-0000-0000-00000000a001', '11111111-1111-1111-1111-111111111111',
   '44444444-0000-0000-0000-00000000aaaa', 'SUP-VIAL-10', 'supply', 'unit', 0, false),
  ('55555555-0000-0000-0000-00000000a002', '11111111-1111-1111-1111-111111111111',
   '44444444-0000-0000-0000-00000000aaaa', 'SUP-ATOM', 'supply', 'unit', 0, false),
  ('55555555-0000-0000-0000-00000000a003', '11111111-1111-1111-1111-111111111111',
   '44444444-0000-0000-0000-00000000aaaa', 'SUP-ETIQ', 'supply', 'unit', 0, false);

\echo '--- BOM del decant de 10 ml'
INSERT INTO bom_components (tenant_id, parent_variant_id, component_variant_id,
                            qty_per_unit, uom) VALUES
  ('11111111-1111-1111-1111-111111111111', '55555555-0000-0000-0000-000000000003',
   '55555555-0000-0000-0000-00000000a001', 1, 'unit'),
  ('11111111-1111-1111-1111-111111111111', '55555555-0000-0000-0000-000000000003',
   '55555555-0000-0000-0000-00000000a002', 1, 'unit'),
  ('11111111-1111-1111-1111-111111111111', '55555555-0000-0000-0000-000000000003',
   '55555555-0000-0000-0000-00000000a003', 1, 'unit');

\echo ''
\echo '=============================================================='
\echo ' 2. Compra en USD con flete → costo puesto en Encarnación'
\echo '=============================================================='
-- 1 frasco a USD 190, flete y despacho USD 15, dólar a 7.300 Gs.
-- landed = (190 + 15) * 7300 = 1.496.500 Gs.

INSERT INTO suppliers (id, tenant_id, code, name, country, default_currency)
VALUES ('66666666-6666-6666-6666-666666666666',
        '11111111-1111-1111-1111-111111111111', 'PROV-BR', 'Distribuidora São Paulo',
        'BR', 'USD');

INSERT INTO purchase_orders (id, tenant_id, supplier_id, code, status, currency,
                             fx_rate_to_pyg, freight_minor, created_by,
                             approved_by, approved_at)
VALUES ('77777777-7777-7777-7777-777777777777',
        '11111111-1111-1111-1111-111111111111', '66666666-6666-6666-6666-666666666666',
        'OC-2026-001', 'approved', 'USD', 7300.00000000, 1500,
        '22222222-2222-2222-2222-222222222222',
        '22222222-2222-2222-2222-222222222222', now());

INSERT INTO purchase_order_lines (id, purchase_order_id, variant_id, qty_ordered,
                                  uom, unit_price_minor)
VALUES ('77777777-0000-0000-0000-000000000001',
        '77777777-7777-7777-7777-777777777777',
        '55555555-0000-0000-0000-000000000001', 1, 'unit', 19000);

INSERT INTO goods_receipts (id, tenant_id, purchase_order_id, code, status,
                            fx_rate_to_pyg, freight_minor, received_by, posted_at)
VALUES ('88888888-8888-8888-8888-888888888888',
        '11111111-1111-1111-1111-111111111111', '77777777-7777-7777-7777-777777777777',
        'REC-2026-001', 'posted', 7300.00000000, 1500,
        '22222222-2222-2222-2222-222222222222', now());

INSERT INTO goods_receipt_lines (id, goods_receipt_id, purchase_order_line_id,
                                 variant_id, qty_received, uom, unit_price_minor,
                                 allocated_freight_pyg, batch_code)
VALUES ('88888888-0000-0000-0000-000000000001',
        '88888888-8888-8888-8888-888888888888', '77777777-0000-0000-0000-000000000001',
        '55555555-0000-0000-0000-000000000001', 1, 'unit', 19000, 109500, 'B2601');

INSERT INTO inventory_lots (id, tenant_id, variant_id, lot_code, batch_code,
                            qty_initial, uom, unit_cost_minor, currency,
                            fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg,
                            goods_receipt_line_id)
VALUES ('99999999-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111', '55555555-0000-0000-0000-000000000001',
        'LOT-LAY-001', 'B2601', 1, 'unit', 19000, 'USD', 7300.00000000,
        1496500, 1496500, '88888888-0000-0000-0000-000000000001');

INSERT INTO inventory_movements (tenant_id, lot_id, variant_id, qty, uom,
                                 movement_type, total_cost_pyg, reference_type,
                                 reference_id, created_by)
VALUES ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000001',
        '55555555-0000-0000-0000-000000000001', 1, 'unit', 'purchase_receipt',
        1496500, 'goods_receipt', '88888888-8888-8888-8888-888888888888',
        '22222222-2222-2222-2222-222222222222');

-- Insumos, comprados aparte y mucho más baratos.
INSERT INTO inventory_lots (id, tenant_id, variant_id, qty_initial, uom,
                            unit_cost_minor, currency, fx_rate_to_pyg,
                            landed_cost_pyg, unit_landed_cost_pyg) VALUES
  ('99999999-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111',
   '55555555-0000-0000-0000-00000000a001', 100, 'unit', 0, 'PYG', 1, 450000, 4500),
  ('99999999-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111',
   '55555555-0000-0000-0000-00000000a002', 100, 'unit', 0, 'PYG', 1, 250000, 2500),
  ('99999999-0000-0000-0000-0000000000a3', '11111111-1111-1111-1111-111111111111',
   '55555555-0000-0000-0000-00000000a003', 200, 'unit', 0, 'PYG', 1,  60000,  300);

INSERT INTO inventory_movements (tenant_id, lot_id, variant_id, qty, uom,
                                 movement_type, total_cost_pyg, created_by) VALUES
  ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-0000000000a1',
   '55555555-0000-0000-0000-00000000a001', 100, 'unit', 'purchase_receipt', 450000,
   '22222222-2222-2222-2222-222222222222'),
  ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-0000000000a2',
   '55555555-0000-0000-0000-00000000a002', 100, 'unit', 'purchase_receipt', 250000,
   '22222222-2222-2222-2222-222222222222'),
  ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-0000000000a3',
   '55555555-0000-0000-0000-00000000a003', 200, 'unit', 'purchase_receipt', 60000,
   '22222222-2222-2222-2222-222222222222');

\echo ''
\echo '=============================================================='
\echo ' 3. Apertura del frasco: el sellado sale, nace el granel en ml'
\echo '=============================================================='
-- Un lote tiene UNA unidad de medida. Restar mililitros de un lote medido
-- en unidades sería mezclar peras con ml. La apertura es una conversión:
-- sale 1 unidad del lote sellado y nace un lote hijo de 125 ml que hereda
-- el costo íntegro.

BEGIN;

INSERT INTO inventory_movements (tenant_id, lot_id, variant_id, qty, uom,
                                 movement_type, total_cost_pyg, reference_type,
                                 created_by)
VALUES ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000001',
        '55555555-0000-0000-0000-000000000001', -1, 'unit', 'transfer_out',
        1496500, 'lot_opening', '22222222-2222-2222-2222-222222222222');

UPDATE inventory_lots
   SET status = 'open_for_decant', opened_at = now()
 WHERE id = '99999999-0000-0000-0000-000000000001';

INSERT INTO inventory_lots (id, tenant_id, variant_id, parent_lot_id, lot_code,
                            qty_initial, uom, unit_cost_minor, currency,
                            fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg,
                            status, opened_at)
VALUES ('99999999-0000-0000-0000-000000000002',
        '11111111-1111-1111-1111-111111111111', '55555555-0000-0000-0000-000000000002',
        '99999999-0000-0000-0000-000000000001', 'LOT-LAY-001-BULK',
        125, 'ml', 19000, 'USD', 7300.00000000, 1496500,
        -- 1.496.500 / 125 ml = 11.972 Gs. por ml
        11972, 'open_for_decant', now());

INSERT INTO inventory_movements (tenant_id, lot_id, variant_id, qty, uom,
                                 movement_type, total_cost_pyg, reference_type,
                                 created_by)
VALUES ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000002',
        '55555555-0000-0000-0000-000000000002', 125, 'ml', 'transfer_in',
        1496500, 'lot_opening', '22222222-2222-2222-2222-222222222222');

COMMIT;

\echo ''
\echo '=============================================================='
\echo ' 4. Venta de un decant de 10 ml — dos momentos'
\echo '=============================================================='

INSERT INTO customers (id, tenant_id, full_name, email, phone)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111', 'Cliente Encarnación',
        'cliente@example.com', '+595 985 000000');

INSERT INTO sales_channels (id, tenant_id, code, name)
VALUES ('bbbbbbbb-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111', 'web', 'Tienda online');

\echo '--- 4.a Momento 1: compromiso comercial (checkout). Reserva, no consumo.'
INSERT INTO sale_orders (id, tenant_id, channel_id, customer_id, code, status,
                         subtotal_pyg, shipping_pyg, total_pyg, vat_10_pyg, placed_at)
VALUES ('cccccccc-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-000000000001', 'VTA-2026-0001', 'awaiting_payment',
        245000, 0, 245000, app.vat_from_gross(245000, 'iva_10'), now());

INSERT INTO sale_order_lines (id, sale_order_id, variant_id, qty, uom,
                              unit_price_pyg, line_total_pyg, vat_rate, vat_pyg)
VALUES ('cccccccc-0000-0000-0000-00000000000a',
        'cccccccc-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000003',
        1, 'ml', 245000, 245000, 'iva_10', app.vat_from_gross(245000, 'iva_10'));

-- Reserva de granel: 10 ml vendidos + 2% de merma esperada = 10,20 ml.
-- TTL corto porque el pago es con tarjeta.
INSERT INTO stock_reservations (tenant_id, variant_id, lot_id, qty, reason,
                                reference_type, reference_id, expires_at)
VALUES ('11111111-1111-1111-1111-111111111111', '55555555-0000-0000-0000-000000000002',
        '99999999-0000-0000-0000-000000000002', 10.200, 'order_pending_payment',
        'sale_order', 'cccccccc-0000-0000-0000-000000000001', now() + interval '30 minutes');

INSERT INTO decant_work_orders (id, tenant_id, source_lot_id, target_variant_id,
                                sale_order_id, qty_units, ml_per_unit,
                                ml_expected, waste_expected, created_by)
VALUES ('dddddddd-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000002',
        '55555555-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000001',
        1, 10.000, 10.000, 0.200, '22222222-2222-2222-2222-222222222222');

\echo '--- 4.b Pago con webhook idempotente'
INSERT INTO payments (id, tenant_id, sale_order_id, method, provider, provider_ref,
                      status, amount_pyg, card_last4, card_brand, captured_at)
VALUES ('eeeeeeee-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111', 'cccccccc-0000-0000-0000-000000000001',
        'card', 'bancard', 'TRX-889231', 'captured', 245000, '4417', 'visa', now());

INSERT INTO payment_events (tenant_id, provider, external_event_id, payment_id,
                            payload, signature_valid, processed_at)
VALUES ('11111111-1111-1111-1111-111111111111', 'bancard', 'EVT-889231-01',
        'eeeeeeee-0000-0000-0000-000000000001',
        '{"status":"success","amount":245000}', true, now());

\echo '--- 4.c Momento 2: transformación física. Acá se conoce la merma REAL.'
-- Se derramó un poco: 0,35 ml en vez de los 0,200 esperados.
BEGIN;

UPDATE decant_work_orders
   SET status = 'done', waste_actual = 0.350,
       executed_by = '22222222-2222-2222-2222-222222222222', executed_at = now()
 WHERE id = 'dddddddd-0000-0000-0000-000000000001';

-- Líquido efectivamente extraído: 10 ml al vial + 0,35 ml de merma.
INSERT INTO inventory_movements (tenant_id, lot_id, variant_id, qty, uom,
                                 movement_type, total_cost_pyg, reference_type,
                                 reference_id, created_by)
VALUES ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000002',
        '55555555-0000-0000-0000-000000000002', -10.000, 'ml', 'decant_consumption',
        119720, 'decant_work_order', 'dddddddd-0000-0000-0000-000000000001',
        '22222222-2222-2222-2222-222222222222'),
       ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000002',
        '55555555-0000-0000-0000-000000000002', -0.350, 'ml', 'waste',
        4190, 'decant_work_order', 'dddddddd-0000-0000-0000-000000000001',
        '22222222-2222-2222-2222-222222222222');

-- Consumo de BOM: vial, atomizador y etiqueta.
INSERT INTO inventory_movements (tenant_id, lot_id, variant_id, qty, uom,
                                 movement_type, total_cost_pyg, reference_type,
                                 reference_id, created_by) VALUES
  ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-0000000000a1',
   '55555555-0000-0000-0000-00000000a001', -1, 'unit', 'bom_consumption', 4500,
   'decant_work_order', 'dddddddd-0000-0000-0000-000000000001',
   '22222222-2222-2222-2222-222222222222'),
  ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-0000000000a2',
   '55555555-0000-0000-0000-00000000a002', -1, 'unit', 'bom_consumption', 2500,
   'decant_work_order', 'dddddddd-0000-0000-0000-000000000001',
   '22222222-2222-2222-2222-222222222222'),
  ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-0000000000a3',
   '55555555-0000-0000-0000-00000000a003', -1, 'unit', 'bom_consumption', 300,
   'decant_work_order', 'dddddddd-0000-0000-0000-000000000001',
   '22222222-2222-2222-2222-222222222222');

-- COGS real del decant: líquido + merma + insumos = 131.210 Gs.
UPDATE sale_order_lines SET cogs_pyg = 131210
 WHERE id = 'cccccccc-0000-0000-0000-00000000000a';
UPDATE sale_orders SET cogs_pyg = 131210, status = 'paid', confirmed_at = now()
 WHERE id = 'cccccccc-0000-0000-0000-000000000001';

UPDATE stock_reservations SET released_at = now()
 WHERE reference_id = 'cccccccc-0000-0000-0000-000000000001';

COMMIT;

\echo ''
\echo '=============================================================='
\echo ' 5. Asiento contable derivado del evento (partida doble)'
\echo '=============================================================='

INSERT INTO accounting_periods (id, tenant_id, code, starts_on, ends_on)
VALUES ('ffffffff-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111', '2026-09', '2026-09-01', '2026-09-30');

BEGIN;
INSERT INTO journal_entries (id, tenant_id, period_id, entry_no, entry_date, status,
                             memo, source_type, source_id, posting_rule, posted_at,
                             created_by)
VALUES ('f0000000-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111', 'ffffffff-0000-0000-0000-000000000001',
        1, current_date, 'posted', 'Venta VTA-2026-0001 — decant Layton 10ml',
        'sale_order', 'cccccccc-0000-0000-0000-000000000001', 'sale.confirmed',
        now(), '22222222-2222-2222-2222-222222222222');

-- IVA 10% sobre precio con impuesto incluido: 245.000 / 11 = 22.273 Gs.
INSERT INTO journal_lines (entry_id, account_id, debit_pyg, credit_pyg, memo, position)
SELECT 'f0000000-0000-0000-0000-000000000001', id, 245000, 0, 'Cobro tarjeta', 1
  FROM chart_of_accounts WHERE tenant_id = '11111111-1111-1111-1111-111111111111'
   AND code = '1.1.01.020';
INSERT INTO journal_lines (entry_id, account_id, debit_pyg, credit_pyg, memo, position)
SELECT 'f0000000-0000-0000-0000-000000000001', id, 0,
       245000 - app.vat_from_gross(245000, 'iva_10'), 'Venta neta', 2
  FROM chart_of_accounts WHERE tenant_id = '11111111-1111-1111-1111-111111111111'
   AND code = '4.1.01.001';
INSERT INTO journal_lines (entry_id, account_id, debit_pyg, credit_pyg, memo, position)
SELECT 'f0000000-0000-0000-0000-000000000001', id, 0,
       app.vat_from_gross(245000, 'iva_10'), 'IVA débito 10%', 3
  FROM chart_of_accounts WHERE tenant_id = '11111111-1111-1111-1111-111111111111'
   AND code = '2.1.03.001';
COMMIT;

\echo ''
\echo '=============================================================='
\echo ' RESULTADOS'
\echo '=============================================================='

\echo '--- Saldos de inventario'
SELECT v.sku,
       b.on_hand,
       v.uom
  FROM inventory_balances b
  JOIN product_variants v ON v.id = b.variant_id
 ORDER BY v.sku;

\echo '--- Deriva entre proyección y ledger (debe estar VACÍO)'
SELECT count(*) AS filas_con_deriva FROM v_balance_drift;

\echo '--- Rendimiento del fraccionamiento: esperado vs. real'
SELECT ml_expected, waste_expected, waste_actual, actual_over_expected
  FROM v_decant_yield;

\echo '--- Margen real del decant (con insumos y merma incluidos)'
SELECT l.line_total_pyg                        AS precio_pyg,
       l.cogs_pyg                              AS costo_pyg,
       l.vat_pyg                               AS iva_pyg,
       l.line_total_pyg - l.vat_pyg - l.cogs_pyg AS margen_pyg,
       round(100.0 * (l.line_total_pyg - l.vat_pyg - l.cogs_pyg)
             / NULLIF(l.line_total_pyg - l.vat_pyg, 0), 1) AS margen_pct
  FROM sale_order_lines l
 WHERE l.id = 'cccccccc-0000-0000-0000-00000000000a';

\echo '--- Balance de sumas y saldos'
SELECT account_code, account_name, total_debit_pyg, total_credit_pyg, balance_pyg
  FROM v_trial_balance ORDER BY account_code;

\echo '--- El asiento cuadra'
SELECT sum(debit_pyg) AS debe, sum(credit_pyg) AS haber,
       sum(debit_pyg) - sum(credit_pyg) AS diferencia
  FROM journal_lines
 WHERE entry_id = 'f0000000-0000-0000-0000-000000000001';
