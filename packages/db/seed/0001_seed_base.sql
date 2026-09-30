-- =====================================================================
-- seed/0001_seed_base.sql — permisos, roles, plan de cuentas, posting rules
-- =====================================================================
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- Catálogo de permisos (recurso.subrecurso:acción)
-- ---------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('catalog.product:read',          'Ver productos y variantes'),
  ('catalog.product:write',         'Crear y editar productos'),
  ('catalog.product:publish',       'Publicar productos al storefront'),
  ('inventory.stock:read',          'Ver stock, lotes y costos de lote'),
  ('inventory.stock:adjust',        'Ajustar inventario'),
  ('inventory.decant:execute',      'Ejecutar órdenes de fraccionamiento'),
  ('sales.order:read',              'Ver pedidos'),
  ('sales.order:write',             'Crear y confirmar pedidos'),
  ('sales.order:refund',            'Anular y reembolsar'),
  ('accounting.cashbox:read',       'Ver caja y arqueos'),
  ('accounting.cashbox:write',      'Registrar movimientos de caja'),
  ('accounting.deposit:read',       'Ver señas de clientes'),
  ('accounting.deposit:write',      'Registrar y aplicar señas'),
  ('accounting.journal:read',       'Ver asientos y balances'),
  ('accounting.journal:write',      'Contabilizar asientos'),
  ('market.supplier:read',          'Ver proveedores'),
  ('market.supplier:write',         'Crear y editar proveedores'),
  ('market.purchase_order:read',    'Ver órdenes de compra'),
  ('market.purchase_order:write',   'Crear órdenes de compra'),
  ('market.purchase_order:approve', 'Aprobar órdenes de compra'),
  ('market.purchase_order:receive', 'Registrar recepciones'),
  ('market.sourcing:read',          'Ver escenarios de sourcing'),
  ('market.sourcing:write',         'Crear escenarios de sourcing'),
  ('market.channel:write',          'Gestionar canales y publicaciones'),
  ('fiscal.document:read',          'Ver documentos fiscales'),
  ('fiscal.document:issue',         'Emitir documentos fiscales'),
  ('settings.user:read',            'Ver usuarios y roles'),
  ('settings.user:write',           'Gestionar usuarios y roles')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------
-- Plan de cuentas base
--
-- Paraguay no impone un plan uniforme para empresas generales, pero el
-- Libro de Compras/Ventas IVA y el balance sí condicionan la apertura.
-- ESTE PLAN DEBE VALIDARSE CON EL CONTADOR antes de contabilizar en serio.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.seed_chart_of_accounts(p_tenant uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  v_parent uuid;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('1',           'ACTIVO',                          'asset',     false),
      ('1.1',         'Activo corriente',                'asset',     false),
      ('1.1.01',      'Caja y bancos',                   'asset',     false),
      ('1.1.01.001',  'Caja en guaraníes',               'asset',     true),
      ('1.1.01.002',  'Caja en dólares',                 'asset',     true),
      ('1.1.01.010',  'Banco cuenta corriente',          'asset',     true),
      ('1.1.01.020',  'Pasarela de pagos por acreditar', 'asset',     true),
      ('1.1.02',      'Créditos',                        'asset',     false),
      ('1.1.02.001',  'Cuentas por cobrar clientes',     'asset',     true),
      ('1.1.03',      'Inventarios',                     'asset',     false),
      ('1.1.03.001',  'Mercaderías — perfumería',        'asset',     true),
      ('1.1.03.002',  'Mercaderías — relojería',         'asset',     true),
      ('1.1.03.010',  'Insumos de fraccionamiento',      'asset',     true),
      ('1.1.03.900',  'Mercadería en tránsito',          'asset',     true),
      ('1.1.04',      'Créditos fiscales',               'asset',     false),
      ('1.1.04.001',  'IVA crédito fiscal 10%',          'asset',     true),
      ('1.1.04.002',  'IVA crédito fiscal 5%',           'asset',     true),
      ('2',           'PASIVO',                          'liability', false),
      ('2.1',         'Pasivo corriente',                'liability', false),
      ('2.1.01.001',  'Proveedores locales',             'liability', true),
      ('2.1.01.002',  'Proveedores del exterior',        'liability', true),
      ('2.1.02.001',  'Señas de clientes',               'liability', true),
      ('2.1.03.001',  'IVA débito fiscal 10%',           'liability', true),
      ('2.1.03.002',  'IVA débito fiscal 5%',            'liability', true),
      ('3',           'PATRIMONIO',                      'equity',    false),
      ('3.1.01.001',  'Capital',                         'equity',    true),
      ('3.2.01.001',  'Resultados acumulados',           'equity',    true),
      ('4',           'INGRESOS',                        'revenue',   false),
      ('4.1.01.001',  'Ventas de perfumería',            'revenue',   true),
      ('4.1.01.002',  'Ventas de relojería',             'revenue',   true),
      ('4.1.02.001',  'Descuentos concedidos',           'revenue',   true),
      ('5',           'EGRESOS',                         'expense',   false),
      ('5.1.01.001',  'Costo de mercadería vendida',     'expense',   true),
      ('5.1.02.001',  'Merma de fraccionamiento',        'expense',   true),
      ('5.2.01.001',  'Fletes y logística',              'expense',   true),
      ('5.2.02.001',  'Comisiones de pasarela',          'expense',   true),
      ('5.3.01.001',  'Diferencia de cambio',            'expense',   true)
    ) AS t(code, name, atype, postable)
    ORDER BY t.code
  LOOP
    SELECT id INTO v_parent FROM chart_of_accounts
     WHERE tenant_id = p_tenant
       AND code = left(r.code, GREATEST(length(r.code) - 4, 0))
     LIMIT 1;

    INSERT INTO chart_of_accounts (tenant_id, code, name, account_type, is_postable, parent_id)
    VALUES (p_tenant, r.code, r.name, r.atype::account_type, r.postable, v_parent)
    ON CONFLICT (tenant_id, code) DO NOTHING;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Roles del negocio
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.seed_roles(p_tenant uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_owner uuid; v_manager uuid; v_vendedor uuid; v_deposito uuid;
BEGIN
  INSERT INTO roles (tenant_id, code, name, is_system) VALUES
    (p_tenant, 'owner',    'Dueño',           true),
    (p_tenant, 'manager',  'Encargado',       true),
    (p_tenant, 'vendedor', 'Vendedor',        true),
    (p_tenant, 'deposito', 'Depósito',        true)
  ON CONFLICT (tenant_id, code) DO NOTHING;

  SELECT id INTO v_owner    FROM roles WHERE tenant_id = p_tenant AND code = 'owner';
  SELECT id INTO v_manager  FROM roles WHERE tenant_id = p_tenant AND code = 'manager';
  SELECT id INTO v_vendedor FROM roles WHERE tenant_id = p_tenant AND code = 'vendedor';
  SELECT id INTO v_deposito FROM roles WHERE tenant_id = p_tenant AND code = 'deposito';

  -- Dueño: todo.
  INSERT INTO role_permissions (tenant_id, role_id, permission_code)
  SELECT p_tenant, v_owner, code FROM permissions ON CONFLICT DO NOTHING;

  -- Encargado: todo salvo gestión de usuarios.
  INSERT INTO role_permissions (tenant_id, role_id, permission_code)
  SELECT p_tenant, v_manager, code FROM permissions WHERE code <> 'settings.user:write'
  ON CONFLICT DO NOTHING;

  -- Vendedor: vende y consulta stock. SIN contabilidad ni sourcing:
  -- que alguien cargue una venta no implica que vea el flujo de caja
  -- ni lo que te cuesta cada frasco. Sí maneja señas: las registra y las
  -- aplica al vender, y con RLS escribir una seña exige poder leerla
  -- (INSERT ... RETURNING y UPDATE ... WHERE evalúan la política de
  -- lectura, WP-B11). `accounting.cashbox:read` sigue oculto.
  INSERT INTO role_permissions (tenant_id, role_id, permission_code) VALUES
    (p_tenant, v_vendedor, 'catalog.product:read'),
    (p_tenant, v_vendedor, 'sales.order:read'),
    (p_tenant, v_vendedor, 'sales.order:write'),
    (p_tenant, v_vendedor, 'accounting.deposit:read'),
    (p_tenant, v_vendedor, 'accounting.deposit:write'),
    (p_tenant, v_vendedor, 'fiscal.document:issue')
  ON CONFLICT DO NOTHING;

  -- Depósito: mueve mercadería, no ve precios de compra ni márgenes.
  INSERT INTO role_permissions (tenant_id, role_id, permission_code) VALUES
    (p_tenant, v_deposito, 'catalog.product:read'),
    (p_tenant, v_deposito, 'inventory.stock:read'),
    (p_tenant, v_deposito, 'inventory.stock:adjust'),
    (p_tenant, v_deposito, 'inventory.decant:execute'),
    (p_tenant, v_deposito, 'market.purchase_order:receive')
  ON CONFLICT DO NOTHING;
END $$;

-- ---------------------------------------------------------------------
-- Reglas de posteo — nacen APAGADAS y se encienden de a una.
-- Mientras estén apagadas, el evento cae en unposted_events: visible,
-- reprocesable, nunca perdido en silencio.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.seed_posting_rules(p_tenant uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO posting_rules (tenant_id, code, description, template, is_enabled) VALUES
  (p_tenant, 'sale.confirmed', 'Venta confirmada: cobro, ingreso e IVA débito',
   '[
      {"leg":"debit",  "account":"1.1.01.001", "source":"total_pyg",   "memo":"Cobro"},
      {"leg":"credit", "account":"4.1.01.001", "source":"net_pyg",     "memo":"Venta"},
      {"leg":"credit", "account":"2.1.03.001", "source":"vat_10_pyg",  "memo":"IVA débito 10%"},
      {"leg":"credit", "account":"2.1.03.002", "source":"vat_5_pyg",   "memo":"IVA débito 5%"}
    ]'::jsonb, false),

  (p_tenant, 'sale.cogs', 'Costo de la mercadería vendida',
   '[
      {"leg":"debit",  "account":"5.1.01.001", "source":"cogs_pyg"},
      {"leg":"credit", "account":"1.1.03.001", "source":"cogs_pyg"}
    ]'::jsonb, false),

  (p_tenant, 'receipt.posted', 'Recepción de compra: alta de inventario',
   '[
      {"leg":"debit",  "account":"1.1.03.001", "source":"landed_cost_pyg"},
      {"leg":"credit", "account":"2.1.01.002", "source":"supplier_payable_pyg"},
      {"leg":"credit", "account":"1.1.01.001", "source":"freight_paid_pyg"}
    ]'::jsonb, false),

  (p_tenant, 'decant.waste', 'Merma de fraccionamiento',
   '[
      {"leg":"debit",  "account":"5.1.02.001", "source":"waste_cost_pyg"},
      {"leg":"credit", "account":"1.1.03.001", "source":"waste_cost_pyg"}
    ]'::jsonb, false),

  (p_tenant, 'deposit.received', 'Seña recibida: es pasivo, no ingreso',
   '[
      {"leg":"debit",  "account":"1.1.01.001", "source":"amount_pyg"},
      {"leg":"credit", "account":"2.1.02.001", "source":"amount_pyg"}
    ]'::jsonb, false),

  (p_tenant, 'deposit.applied', 'Seña aplicada a un pedido',
   '[
      {"leg":"debit",  "account":"2.1.02.001", "source":"amount_pyg"},
      {"leg":"credit", "account":"1.1.02.001", "source":"amount_pyg"}
    ]'::jsonb, false)
  ON CONFLICT (tenant_id, code) DO NOTHING;
END $$;
