-- =====================================================================
-- invariants.sql — cada prueba INTENTA una operación inválida y espera
-- que la base la rechace. Un invariante que nunca se probó es una creencia.
-- Se ejecuta después de smoke_business_flow.sql.
-- =====================================================================
SET search_path = app, public;

CREATE TEMP TABLE results (n int, nombre text, esperado text, resultado text);

CREATE OR REPLACE FUNCTION pg_temp.expect_fail(
  p_n int, p_nombre text, p_sql text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    INSERT INTO results VALUES (p_n, p_nombre, 'rechazo', 'FALLO — fue aceptado');
  EXCEPTION WHEN others THEN
    INSERT INTO results VALUES (p_n, p_nombre, 'rechazo',
      'OK — ' || left(replace(SQLERRM, E'\n', ' '), 62));
  END;
END $$;

-- WP-B08: a diferencia de expect_fail (que INTENTA algo inválido y espera
-- el rechazo), esto verifica una PROPIEDAD del esquema directamente — no
-- hay ninguna operación que "intentar". Misma tabla `results`, mismo
-- conteo, para no duplicar el mecanismo de reporte.
CREATE OR REPLACE FUNCTION pg_temp.expect_true(
  p_n int, p_nombre text, p_condition boolean
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition THEN
    INSERT INTO results VALUES (p_n, p_nombre, 'verdadero', 'OK — condición cumplida');
  ELSE
    INSERT INTO results VALUES (p_n, p_nombre, 'verdadero', 'FALLO — condición no se cumplió');
  END IF;
END $$;

-- 1 ─ El ledger no se edita
SELECT pg_temp.expect_fail(1, 'UPDATE sobre inventory_movements',
  $$UPDATE app.inventory_movements SET qty = 999 WHERE id = 1$$);

-- 2 ─ El ledger no se borra
SELECT pg_temp.expect_fail(2, 'DELETE sobre inventory_movements',
  $$DELETE FROM app.inventory_movements WHERE id = 1$$);

-- 3 ─ No se puede vender lo que no hay (sobreventa)
SELECT pg_temp.expect_fail(3, 'Sobreventa: 200 ml de un lote con 114,65',
  $$INSERT INTO app.inventory_movements
      (tenant_id, lot_id, variant_id, qty, uom, movement_type)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '99999999-0000-0000-0000-000000000002',
            '55555555-0000-0000-0000-000000000002', -200, 'ml', 'sale')$$);

-- 4 ─ Signo incoherente con el tipo de movimiento
SELECT pg_temp.expect_fail(4, 'Venta con cantidad positiva',
  $$INSERT INTO app.inventory_movements
      (tenant_id, lot_id, variant_id, qty, uom, movement_type)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '99999999-0000-0000-0000-000000000002',
            '55555555-0000-0000-0000-000000000002', 5, 'ml', 'sale')$$);

-- 5 ─ Unidad de medida incompatible con el lote
SELECT pg_temp.expect_fail(5, 'Movimiento en unidades sobre lote en ml',
  $$INSERT INTO app.inventory_movements
      (tenant_id, lot_id, variant_id, qty, uom, movement_type)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '99999999-0000-0000-0000-000000000002',
            '55555555-0000-0000-0000-000000000002', -1, 'unit', 'sale')$$);

-- 6 ─ Un frasco abierto para decantar no se vende sellado
SELECT pg_temp.expect_fail(6, 'Venta de sellado desde lote abierto',
  $$INSERT INTO app.inventory_movements
      (tenant_id, lot_id, variant_id, qty, uom, movement_type)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '99999999-0000-0000-0000-000000000001',
            '55555555-0000-0000-0000-000000000001', -1, 'unit', 'sale')$$);

-- 7 ─ Asiento descuadrado (se detecta al COMMIT, no antes)
SELECT pg_temp.expect_fail(7, 'Asiento con debe <> haber',
  $$DO $x$
    BEGIN
      INSERT INTO app.journal_entries
        (id, tenant_id, period_id, entry_no, entry_date, status, memo)
      VALUES ('f0000000-0000-0000-0000-0000000000ff',
              '11111111-1111-1111-1111-111111111111',
              'ffffffff-0000-0000-0000-000000000001', 99, current_date,
              'draft', 'Asiento descuadrado a propósito');
      INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
      SELECT '11111111-1111-1111-1111-111111111111', 'f0000000-0000-0000-0000-0000000000ff', id, 100000, 0
        FROM app.chart_of_accounts WHERE code = '1.1.01.001'
         AND tenant_id = '11111111-1111-1111-1111-111111111111';
      INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
      SELECT '11111111-1111-1111-1111-111111111111', 'f0000000-0000-0000-0000-0000000000ff', id, 0, 70000
        FROM app.chart_of_accounts WHERE code = '4.1.01.001'
         AND tenant_id = '11111111-1111-1111-1111-111111111111';
      SET CONSTRAINTS app.trg_journal_balanced IMMEDIATE;
    END $x$
  $$);

-- 8 ─ Una línea contable no puede ser débito y crédito a la vez
SELECT pg_temp.expect_fail(8, 'Línea con debe y haber simultáneos',
  $$INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
    SELECT '11111111-1111-1111-1111-111111111111', 'f0000000-0000-0000-0000-000000000001', id, 5000, 5000
      FROM app.chart_of_accounts WHERE code = '1.1.01.001'
       AND tenant_id = '11111111-1111-1111-1111-111111111111'$$);

-- 9 ─ Un asiento contabilizado no se modifica
SELECT pg_temp.expect_fail(9, 'Editar línea de asiento ya contabilizado',
  $$UPDATE app.journal_lines SET debit_pyg = 1
     WHERE entry_id = 'f0000000-0000-0000-0000-000000000001'$$);

-- 10 ─ Webhook de pago duplicado (Bancard reintenta)
SELECT pg_temp.expect_fail(10, 'Evento de pago repetido',
  $$INSERT INTO app.payment_events
      (tenant_id, provider, external_event_id, payload)
    VALUES ('11111111-1111-1111-1111-111111111111', 'bancard', 'EVT-889231-01',
            '{"replay":true}')$$);

-- 11 ─ Coherencia de vertical: un reloj no puede tener detalles de perfume
SELECT pg_temp.expect_fail(11, 'perfume_details sobre un producto watch',
  $$DO $x$
    BEGIN
      INSERT INTO app.products (id, tenant_id, kind, slug, name, status)
      VALUES ('44444444-0000-0000-0000-00000000bbbb',
              '11111111-1111-1111-1111-111111111111', 'watch', 'seiko-skx', 'Seiko SKX', 'draft');
      INSERT INTO app.perfume_details
        (tenant_id, product_id, concentration, nominal_volume_ml, olfactory_family)
      VALUES ('11111111-1111-1111-1111-111111111111',
              '44444444-0000-0000-0000-00000000bbbb', 'edp', 100, 'Acuática');
    END $x$
  $$);

-- 12 ─ Una seña no puede aplicarse por más de lo recibido
SELECT pg_temp.expect_fail(12, 'Seña sobre-aplicada',
  $$DO $x$
    BEGIN
      INSERT INTO app.customer_deposits
        (id, tenant_id, customer_id, amount_pyg, applied_pyg)
      VALUES ('ab000000-0000-0000-0000-000000000001',
              '11111111-1111-1111-1111-111111111111',
              'aaaaaaaa-0000-0000-0000-000000000001', 500000, 800000);
    END $x$
  $$);

-- 13 ─ Las capas de costo tienen que cuadrar con el costo del movimiento
SELECT pg_temp.expect_fail(13, 'Asignación de costo que no cuadra',
  $$DO $x$
    DECLARE v_mov bigint;
    BEGIN
      INSERT INTO app.inventory_movements
        (tenant_id, lot_id, variant_id, qty, uom, movement_type, total_cost_pyg)
      VALUES ('11111111-1111-1111-1111-111111111111',
              '99999999-0000-0000-0000-000000000002',
              '55555555-0000-0000-0000-000000000002', -1, 'ml', 'sale', 11972)
      RETURNING id INTO v_mov;
      INSERT INTO app.movement_cost_allocations
        (tenant_id, movement_id, lot_id, qty, unit_cost_pyg, total_cost_pyg)
      VALUES ('11111111-1111-1111-1111-111111111111',
              v_mov, '99999999-0000-0000-0000-000000000002', 1, 5000, 5000);
      SET CONSTRAINTS app.trg_cost_allocation_matches IMMEDIATE;
    END $x$
  $$);

-- 14 ─ Una nota de crédito sin documento de referencia
SELECT pg_temp.expect_fail(14, 'Nota de crédito huérfana',
  $$INSERT INTO app.fiscal_documents (tenant_id, doc_type, status, total_pyg)
    VALUES ('11111111-1111-1111-1111-111111111111', 'nota_credito', 'draft', 0)$$);

-- 15 ─ Un documento fiscal aprobado sin CDC
SELECT pg_temp.expect_fail(15, 'Documento aprobado sin CDC',
  $$INSERT INTO app.fiscal_documents (tenant_id, doc_type, status, total_pyg)
    VALUES ('11111111-1111-1111-1111-111111111111', 'factura', 'approved', 0)$$);

-- 16 ─ Total de pedido incoherente con sus componentes
SELECT pg_temp.expect_fail(16, 'Total de pedido que no cierra',
  $$INSERT INTO app.sale_orders
      (tenant_id, channel_id, code, subtotal_pyg, discount_pyg, shipping_pyg, total_pyg)
    VALUES ('11111111-1111-1111-1111-111111111111',
            'bbbbbbbb-0000-0000-0000-000000000001', 'VTA-BAD',
            100000, 0, 0, 999999)$$);

-- 17 ─ Variante bajo pedido sin granel de origen
SELECT pg_temp.expect_fail(17, 'made_to_order sin source_variant_id',
  $$INSERT INTO app.product_variants
      (tenant_id, product_id, sku, variant_type, uom, size_ml, price_pyg, production_mode)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '44444444-4444-4444-4444-444444444444', 'LAY-DEC-5-BAD',
            'decant', 'ml', 5, 140000, 'made_to_order')$$);

-- 18 ─ Auditoría inmutable
SELECT pg_temp.expect_fail(18, 'DELETE sobre audit_log',
  $$DO $x$
    BEGIN
      INSERT INTO app.audit_log (tenant_id, audience, action, entity)
      VALUES ('11111111-1111-1111-1111-111111111111', 'staff', 'test', 'x');
      DELETE FROM app.audit_log WHERE action = 'test';
    END $x$
  $$);

-- 19 ─ Una sesión de personal revocada siempre lleva su motivo (WP-C03)
SELECT pg_temp.expect_fail(19, 'staff_sessions con revoked_at sin revoked_reason',
  $$INSERT INTO app.staff_sessions (tenant_id, staff_user_id, expires_at, revoked_at)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '22222222-2222-2222-2222-222222222222',
            now() + interval '8 hours', now())$$);

-- 20 ─ ... y viceversa: un motivo sin revoked_at tampoco entra (WP-C03)
SELECT pg_temp.expect_fail(20, 'staff_sessions con revoked_reason sin revoked_at',
  $$INSERT INTO app.staff_sessions (tenant_id, staff_user_id, expires_at, revoked_reason)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '22222222-2222-2222-2222-222222222222',
            now() + interval '8 hours', 'logout')$$);

-- 21 ─ Un usuario no puede quedar "inscripto" en MFA sin secreto guardado
-- (WP-C04). El fixture de smoke_business_flow.sql ya deja a este staff_user
-- con mfa_enrolled = true y un mfa_secret_encrypted no nulo — el ataque es
-- borrarle el secreto sin des-inscribirlo.
SELECT pg_temp.expect_fail(21, 'staff_users con mfa_enrolled = true y mfa_secret_encrypted NULL',
  $$UPDATE app.staff_users
       SET mfa_secret_encrypted = NULL
     WHERE id = '22222222-2222-2222-2222-222222222222'$$);

-- 22 ─ Toda tabla de app.* tiene RLS habilitado, salvo las dos excepciones
-- documentadas (WP-B08, packages/db/migrations/0014_rls_sweep.sql). Motivado
-- por el hallazgo de la revisión cruzada de WP-C09: product_media no tenía
-- tenant_id, quedó fuera del aislamiento por RLS durante todo ese WP, y
-- nadie lo notó hasta la revisión — esto es lo que hace que no se repita
-- por olvido. `tenants`/`permissions` son las únicas dos justificadas por
-- escrito (ver el encabezado de esa migración); una tabla nueva sin RLS y
-- sin agregarse a esa lista hace fallar esto, a propósito.
SELECT pg_temp.expect_true(22,
  'Toda tabla de app.* tiene RLS, salvo tenants/permissions (justificadas)',
  NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'app'
       AND c.relkind = 'r'
       AND NOT c.relrowsecurity
       AND c.relname NOT IN ('tenants', 'permissions')
  ));

-- 23 ─ Toda tabla de app.* con RLS tiene una política `tenant_isolation`
-- declarada AS RESTRICTIVE, salvo las mismas dos excepciones del 22 (WP-B10,
-- packages/db/migrations/0016_rls_tenant_isolation_restrictive.sql). Las
-- permisivas `tenant_access*` de esa migración son `USING (true)`: seguras
-- SOLO porque la restrictiva las recorta con AND. Una tabla nueva que copie
-- la permisiva sin la restrictiva — o una `tenant_isolation` creada
-- PERMISSIVE, el default de Postgres, que es exactamente el defecto que
-- corrigió B10 — queda abierta, y esto falla a propósito.
SELECT pg_temp.expect_true(23,
  'Toda tabla de app.* con RLS tiene tenant_isolation RESTRICTIVE, salvo tenants/permissions',
  NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'app'
       AND c.relkind = 'r'
       AND c.relrowsecurity
       AND c.relname NOT IN ('tenants', 'permissions')
       AND NOT EXISTS (
         SELECT 1
           FROM pg_policy p
          WHERE p.polrelid = c.oid
            AND p.polname = 'tenant_isolation'
            AND NOT p.polpermissive
            AND p.polcmd = '*')
  ));

-- 24 ─ Una línea contable no puede quedar en un tenant distinto del de su
-- asiento (WP-B10, 0017_guard_posted_journal_fail_closed.sql). Con
-- SECURITY DEFINER, guard_posted_journal ve asientos de todos los tenants y
-- la FK entry_id no evalúa RLS: el tenant se verifica explícitamente. Sobre
-- un asiento en BORRADOR, para que el rechazo no venga de la regla de
-- asiento contabilizado.
SELECT pg_temp.expect_fail(24, 'Línea de asiento movida a otro tenant',
  $$DO $x$
    BEGIN
      INSERT INTO app.tenants (id, slug, legal_name, trade_name)
      VALUES ('24242424-0000-0000-0000-000000000024', 'tenant-inv-24', 'Inv 24 SA', 'Inv 24');
      INSERT INTO app.journal_entries
        (id, tenant_id, period_id, entry_no, entry_date, status, memo)
      VALUES ('f0000000-0000-0000-0000-000000000024',
              '11111111-1111-1111-1111-111111111111',
              'ffffffff-0000-0000-0000-000000000001', 98, current_date,
              'draft', 'Borrador para el invariante 24');
      INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
      SELECT '11111111-1111-1111-1111-111111111111', 'f0000000-0000-0000-0000-000000000024', id, 1000, 0
        FROM app.chart_of_accounts WHERE code = '1.1.01.001'
         AND tenant_id = '11111111-1111-1111-1111-111111111111';
      -- Segunda línea para que el borrador cuadre: si el guard no rechazara,
      -- el fallo tiene que verse como FALLO de este invariante, no como un
      -- asiento descuadrado al COMMIT de todo el script.
      INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
      SELECT '11111111-1111-1111-1111-111111111111', 'f0000000-0000-0000-0000-000000000024', id, 0, 1000
        FROM app.chart_of_accounts WHERE code = '4.1.01.001'
         AND tenant_id = '11111111-1111-1111-1111-111111111111';
      UPDATE app.journal_lines SET tenant_id = '24242424-0000-0000-0000-000000000024'
       WHERE entry_id = 'f0000000-0000-0000-0000-000000000024';
    END $x$
  $$);

-- 25 ─ El guard de asiento contabilizado FALLA CERRADO (WP-B10, 0017): si no
-- encuentra el asiento de la línea, rechaza — nunca compara contra un NULL.
-- Borrar el asiento contabilizado del smoke borra sus líneas por cascada,
-- con el asiento ya inexistente: antes de 0017 eso daba v_status NULL y
-- pasaba (el asiento contabilizado desaparecía entero).
SELECT pg_temp.expect_fail(25, 'Borrar un asiento contabilizado (cascada a sus líneas)',
  $$DELETE FROM app.journal_entries WHERE id = 'f0000000-0000-0000-0000-000000000001'$$);

-- 26 ─ Una línea no se saca de un asiento contabilizado (WP-B10, 0017). La
-- versión de 0009 miraba solo el asiento de NEW en un UPDATE: mover la
-- línea a un borrador pasaba.
SELECT pg_temp.expect_fail(26, 'Mover una línea fuera de un asiento contabilizado',
  $$DO $x$
    BEGIN
      INSERT INTO app.journal_entries
        (id, tenant_id, period_id, entry_no, entry_date, status, memo)
      VALUES ('f0000000-0000-0000-0000-000000000026',
              '11111111-1111-1111-1111-111111111111',
              'ffffffff-0000-0000-0000-000000000001', 97, current_date,
              'draft', 'Borrador para el invariante 26');
      UPDATE app.journal_lines SET entry_id = 'f0000000-0000-0000-0000-000000000026'
       WHERE entry_id = 'f0000000-0000-0000-0000-000000000001';
    END $x$
  $$);

\echo ''
\echo '=============================================================='
\echo ' INVARIANTES'
\echo '=============================================================='
SELECT n, nombre, resultado FROM results ORDER BY n;

SELECT count(*) FILTER (WHERE resultado LIKE 'OK%')    AS pasaron,
       count(*) FILTER (WHERE resultado LIKE 'FALLO%') AS fallaron,
       count(*)                                        AS total
  FROM results;
