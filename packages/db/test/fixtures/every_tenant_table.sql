-- =====================================================================
-- every_tenant_table.sql  (WP-B08b)
--
-- Se carga DESPUÉS de tests/smoke_business_flow.sql. El smoke deja filas
-- del tenant real en 33 de las 61 tablas con tenant_id; este archivo pone
-- al menos una en cada una de las 28 restantes. Sin fila del tenant real,
-- "otro tenant ve cero filas" es cierto sobre una tabla vacía y no prueba
-- nada (lección de B06/B10).
--
-- Además: el tenant vecino, con un owner (todos los permisos) y una sesión
-- viva para cada owner (WP-B13: has_permission exige app.session_id).
--
-- Si aparece una tabla nueva con tenant_id, rls_every_table.test.ts falla
-- hasta que se la agregue a su lista, y probablemente a este archivo.
-- =====================================================================
SET search_path = app, public;

-- Tenant vecino, su owner, y una sesión viva por owner.
INSERT INTO tenants (id, slug, legal_name, trade_name)
VALUES ('33333333-3333-3333-3333-333333333333', 'tenant-vecino', 'Vecino SA', 'Vecino');
SELECT app.seed_roles('33333333-3333-3333-3333-333333333333');
INSERT INTO staff_users (id, tenant_id, auth_subject, email, full_name)
VALUES ('33333333-3333-3333-3333-3333333300a1', '33333333-3333-3333-3333-333333333333',
        'sub-peer-owner', 'owner@vecino.test', 'Owner vecino');
INSERT INTO staff_user_roles (staff_user_id, role_id, tenant_id)
SELECT '33333333-3333-3333-3333-3333333300a1', id, tenant_id FROM roles
 WHERE tenant_id = '33333333-3333-3333-3333-333333333333' AND code = 'owner';

INSERT INTO staff_sessions (id, tenant_id, staff_user_id, expires_at) VALUES
  ('b08b0000-0000-0000-0000-0000000005a1', '11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222', now() + interval '8 hours'),
  ('b08b0000-0000-0000-0000-0000000005a2', '33333333-3333-3333-3333-333333333333',
   '33333333-3333-3333-3333-3333333300a1', now() + interval '8 hours');

-- Una fila del tenant real por cada tabla que el smoke deja vacía.
INSERT INTO audit_log (tenant_id, audience, action, entity)
VALUES ('11111111-1111-1111-1111-111111111111', 'staff', 'test.b08b', 'fixture');

INSERT INTO tags (id, tenant_id, slug, name)
VALUES ('b08b0000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
        'tag-b08b', 'Etiqueta B08b');
INSERT INTO product_tags (tenant_id, product_id, tag_id)
VALUES ('11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444',
        'b08b0000-0000-0000-0000-000000000001');

INSERT INTO products (id, tenant_id, kind, slug, name, status)
VALUES ('b08b0000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
        'watch', 'reloj-b08b', 'Reloj B08b', 'draft');
INSERT INTO watch_details (tenant_id, product_id, movement, case_material, requires_serial)
VALUES ('11111111-1111-1111-1111-111111111111', 'b08b0000-0000-0000-0000-000000000002',
        'automatic', 'acero', true);

INSERT INTO media (id, tenant_id, sha256, bucket, object_key, mime_type, bytes)
VALUES ('b08b0000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
        repeat('a', 64), 'bucket-b08b', 'objeto-b08b', 'image/png', 1);
INSERT INTO product_media (tenant_id, product_id, media_id)
VALUES ('11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444',
        'b08b0000-0000-0000-0000-000000000003');

INSERT INTO channel_listings (tenant_id, channel_id, variant_id)
VALUES ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000001',
        '55555555-0000-0000-0000-000000000001');

INSERT INTO customer_addresses (tenant_id, customer_id, line1, city)
VALUES ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
        'Calle 1', 'Encarnación');

INSERT INTO customer_deposits (id, tenant_id, customer_id, amount_pyg)
VALUES ('b08b0000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111',
        'aaaaaaaa-0000-0000-0000-000000000001', 100000);
INSERT INTO customer_deposit_applications (tenant_id, deposit_id, sale_order_id, amount_pyg)
VALUES ('11111111-1111-1111-1111-111111111111', 'b08b0000-0000-0000-0000-000000000004',
        'cccccccc-0000-0000-0000-000000000001', 50000);

INSERT INTO fiscal_config (tenant_id, ruc)
VALUES ('11111111-1111-1111-1111-111111111111', '80012345-6');

INSERT INTO fiscal_documents (id, tenant_id, doc_type, total_pyg)
VALUES ('b08b0000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111',
        'factura', 0);
INSERT INTO fiscal_document_lines
  (tenant_id, fiscal_document_id, description, qty, unit_price_pyg, vat_rate, gross_pyg)
VALUES ('11111111-1111-1111-1111-111111111111', 'b08b0000-0000-0000-0000-000000000005',
        'Decant Layton 10 ml', 1, 245000, 'iva_10', 245000);
INSERT INTO fiscal_events (tenant_id, fiscal_document_id, event_type)
VALUES ('11111111-1111-1111-1111-111111111111', 'b08b0000-0000-0000-0000-000000000005',
        'created');

INSERT INTO idempotency_keys (tenant_id, scope, key, request_hash)
VALUES ('11111111-1111-1111-1111-111111111111', 'api', 'clave-b08b', 'hash-b08b');

-- Capa de costo del consumo del decant del smoke: mismo importe que el
-- movimiento, así la constraint diferida cuadra sin tocar ningún saldo.
INSERT INTO movement_cost_allocations
  (tenant_id, movement_id, lot_id, qty, unit_cost_pyg, total_cost_pyg)
SELECT '11111111-1111-1111-1111-111111111111', m.id,
       '99999999-0000-0000-0000-000000000002', 10, 11972, 119720
  FROM inventory_movements m
 WHERE m.movement_type = 'decant_consumption'
   AND m.lot_id = '99999999-0000-0000-0000-000000000002';

INSERT INTO purchase_order_transitions (tenant_id, purchase_order_id, from_status, to_status)
VALUES ('11111111-1111-1111-1111-111111111111', '77777777-7777-7777-7777-777777777777',
        'draft', 'approved');
INSERT INTO sale_order_transitions (tenant_id, sale_order_id, from_status, to_status)
VALUES ('11111111-1111-1111-1111-111111111111', 'cccccccc-0000-0000-0000-000000000001',
        'awaiting_payment', 'paid');

INSERT INTO returns (id, tenant_id, sale_order_id, code, reason)
VALUES ('b08b0000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111',
        'cccccccc-0000-0000-0000-000000000001', 'DEV-B08B', 'Fixture de B08b');
INSERT INTO return_items (tenant_id, return_id, sale_order_line_id, qty)
VALUES ('11111111-1111-1111-1111-111111111111', 'b08b0000-0000-0000-0000-000000000006',
        'cccccccc-0000-0000-0000-00000000000a', 1);

INSERT INTO serialized_units (tenant_id, variant_id, serial_number)
VALUES ('11111111-1111-1111-1111-111111111111', '55555555-0000-0000-0000-000000000001',
        'SN-B08B');

INSERT INTO shipments (tenant_id, sale_order_id)
VALUES ('11111111-1111-1111-1111-111111111111', 'cccccccc-0000-0000-0000-000000000001');

INSERT INTO sourcing_scenarios (id, tenant_id, name, created_by)
VALUES ('b08b0000-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111',
        'Escenario B08b', '22222222-2222-2222-2222-222222222222');
INSERT INTO sourcing_scenario_lines
  (tenant_id, scenario_id, variant_id, qty, unit_price_minor, currency, fx_assumed)
VALUES ('11111111-1111-1111-1111-111111111111', 'b08b0000-0000-0000-0000-000000000007',
        '55555555-0000-0000-0000-000000000001', 1, 19000, 'USD', 7300);

INSERT INTO staff_refresh_tokens (tenant_id, session_id, token_hash)
VALUES ('11111111-1111-1111-1111-111111111111', 'b08b0000-0000-0000-0000-0000000005a1',
        'token-hash-b08b');

INSERT INTO supplier_contacts (tenant_id, supplier_id, name)
VALUES ('11111111-1111-1111-1111-111111111111', '66666666-6666-6666-6666-666666666666',
        'Contacto B08b');

INSERT INTO unposted_events (tenant_id, event_code, source_type, source_id, payload, reason)
VALUES ('11111111-1111-1111-1111-111111111111', 'sale.confirmed', 'sale_order',
        'cccccccc-0000-0000-0000-000000000001', '{}', 'rule_disabled');
