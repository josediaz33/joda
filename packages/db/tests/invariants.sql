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

-- WP-B09: como expect_fail, pero el rechazo solo cuenta si su mensaje
-- coincide con `p_pattern` (LIKE). Cuando varios triggers pueden rechazar
-- la misma operación, "hubo un error" no prueba que el que se quería
-- probar haya funcionado: es exactamente como `trg_movement_uom` enmascaró
-- la falla abierta de `assert_sealed_lot_not_open` desde WP-B01.
CREATE OR REPLACE FUNCTION pg_temp.expect_fail_like(
  p_n int, p_nombre text, p_sql text, p_pattern text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    INSERT INTO results VALUES (p_n, p_nombre, 'rechazo', 'FALLO — fue aceptado');
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE p_pattern THEN
      INSERT INTO results VALUES (p_n, p_nombre, 'rechazo',
        'OK — ' || left(replace(SQLERRM, E'\n', ' '), 62));
    ELSE
      INSERT INTO results VALUES (p_n, p_nombre, 'rechazo',
        'FALLO — rechazado por otro motivo: ' || left(replace(SQLERRM, E'\n', ' '), 62));
    END IF;
  END;
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
-- Sobre un BORRADOR (WP-B14): desde 0020 una línea nueva en el asiento
-- contabilizado del smoke la rechaza el guard antes de que el CHECK llegue
-- a evaluarse, y este invariante probaría otra cosa. Por eso además exige
-- el nombre del CHECK en el mensaje.
SELECT pg_temp.expect_fail_like(8, 'Línea con debe y haber simultáneos',
  $$DO $x$
    BEGIN
      INSERT INTO app.journal_entries
        (id, tenant_id, period_id, entry_no, entry_date, status, memo)
      VALUES ('f0000000-0000-0000-0000-000000000008',
              '11111111-1111-1111-1111-111111111111',
              'ffffffff-0000-0000-0000-000000000001', 88, current_date,
              'draft', 'Borrador para el invariante 8');
      INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
      SELECT '11111111-1111-1111-1111-111111111111', 'f0000000-0000-0000-0000-000000000008', id, 5000, 5000
        FROM app.chart_of_accounts WHERE code = '1.1.01.001'
         AND tenant_id = '11111111-1111-1111-1111-111111111111';
    END $x$
  $$,
  '%line_is_debit_xor_credit%');

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

-- 27 ─ Una línea nueva no se cuelga de un asiento de otro tenant (WP-B10,
-- 0017). La FK entry_id no evalúa RLS y el trigger de 0009 no cubría
-- INSERT: una línea del tenant B apuntando a un asiento del tenant A
-- pasaba. Mismo rechazo que un asiento inexistente.
SELECT pg_temp.expect_fail(27, 'Línea nueva de un tenant sobre el asiento de otro tenant',
  $$DO $x$
    BEGIN
      INSERT INTO app.tenants (id, slug, legal_name, trade_name)
      VALUES ('27272727-0000-0000-0000-000000000027', 'tenant-inv-27', 'Inv 27 SA', 'Inv 27');
      INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
      SELECT '27272727-0000-0000-0000-000000000027', 'f0000000-0000-0000-0000-000000000001', id, 1000, 0
        FROM app.chart_of_accounts WHERE code = '1.1.01.001'
         AND tenant_id = '11111111-1111-1111-1111-111111111111';
      -- Par compensado: sin el guard, el fallo tiene que verse como FALLO
      -- de este invariante, no como un asiento descuadrado al COMMIT.
      INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
      SELECT '27272727-0000-0000-0000-000000000027', 'f0000000-0000-0000-0000-000000000001', id, 0, 1000
        FROM app.chart_of_accounts WHERE code = '4.1.01.001'
         AND tenant_id = '11111111-1111-1111-1111-111111111111';
    END $x$
  $$);

-- ─────────────────────────────────────────────────────────────────────
-- WP-B09 (0018_invariant_triggers_security_definer.sql): funciones de
-- disparador SECURITY DEFINER, que fallan cerrado y verifican el tenant.
-- ─────────────────────────────────────────────────────────────────────

-- 28 ─ Toda función de disparador de app.* fija `search_path = app,
-- pg_temp`. Sin search_path propio, la función resuelve nombres con el de
-- quien la dispara (hallazgo de WP-C10: `joda_api` no tiene `app` en el
-- suyo) y, si es SECURITY DEFINER, busca primero en `pg_temp`, donde quien
-- la dispara puede sombrear una tabla.
SELECT pg_temp.expect_true(28,
  'Toda función de disparador de app.* tiene search_path = app, pg_temp',
  NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app'
       AND p.prorettype = 'trigger'::regtype
       AND NOT ('search_path=app, pg_temp' = ANY (COALESCE(p.proconfig, '{}')))
  ));

-- 29 ─ Toda función de disparador de app.* es SECURITY DEFINER, salvo las
-- que no leen ninguna tabla (`guard_po_no_return_to_draft`, WP-B11,
-- `guard_system_roles`, WP-B11c, `guard_so_no_return_to_draft`, WP-B11d, y
-- `guard_po_line_no_reparent`, 0036: leen solo OLD y NEW). Una función de
-- invariante SECURITY INVOKER lee con
-- los permisos de quien dispara el trigger: si RLS le oculta la fila, decide
-- sobre un NULL (el defecto de B10 y de B09). Una función nueva que lea
-- tablas y no esté en esta lista hace fallar esto.
SELECT pg_temp.expect_true(29,
  'Toda función de disparador de app.* es SECURITY DEFINER, salvo set_updated_at/guard_append_only/guard_po_no_return_to_draft/guard_system_roles/guard_so_no_return_to_draft/guard_po_line_no_reparent',
  NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app'
       AND p.prorettype = 'trigger'::regtype
       AND NOT p.prosecdef
       AND p.proname NOT IN ('set_updated_at', 'guard_append_only',
                             'guard_po_no_return_to_draft', 'guard_system_roles',
                             'guard_so_no_return_to_draft', 'guard_po_line_no_reparent')
  ));

-- 30 ─ El dueño de toda función SECURITY DEFINER de app.* elude RLS. Una
-- SECURITY DEFINER corre como su dueño; si el dueño no es superusuario ni
-- BYPASSRLS, FORCE ROW LEVEL SECURITY lo filtra igual que a `joda_api`, y
-- las funciones de invariantes vuelven a decidir sobre lo que RLS les deja
-- ver. Depende del rol que corre las migraciones en cada entorno.
SELECT pg_temp.expect_true(30,
  'El dueño de toda función SECURITY DEFINER de app.* elude RLS',
  NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles r     ON r.oid = p.proowner
     WHERE n.nspname = 'app'
       AND p.prosecdef
       AND NOT (r.rolsuper OR r.rolbypassrls)
  ));

-- 31 ─ El lote de un movimiento es del tenant del movimiento. Con
-- SECURITY DEFINER el trigger ve lotes de todos los tenants y la FK lot_id
-- no evalúa RLS: sin esta verificación, un movimiento del tenant B movía
-- el saldo de un lote del tenant A.
SELECT pg_temp.expect_fail_like(31, 'Movimiento de un tenant sobre el lote de otro tenant',
  $$DO $x$
    BEGIN
      INSERT INTO app.tenants (id, slug, legal_name, trade_name)
      VALUES ('31313131-0000-0000-0000-000000000031', 'tenant-inv-31', 'Inv 31 SA', 'Inv 31');
      INSERT INTO app.inventory_movements
        (tenant_id, lot_id, variant_id, qty, uom, movement_type)
      VALUES ('31313131-0000-0000-0000-000000000031',
              '99999999-0000-0000-0000-000000000002',
              '55555555-0000-0000-0000-000000000002', 1, 'ml', 'adjustment');
    END $x$
  $$,
  'Lote % no encontrado en el tenant del movimiento%');

-- 32 ─ La variante de un movimiento es del tenant del movimiento. Lote
-- propio, variante ajena: `trg_movement_uom` pasa, y lo que rechaza es
-- `assert_sealed_lot_not_open`, que decide sobre el tipo de la variante.
SELECT pg_temp.expect_fail_like(32, 'Movimiento con la variante de otro tenant',
  $$DO $x$
    BEGIN
      INSERT INTO app.tenants (id, slug, legal_name, trade_name)
      VALUES ('32323232-0000-0000-0000-000000000032', 'tenant-inv-32', 'Inv 32 SA', 'Inv 32');
      INSERT INTO app.products (id, tenant_id, kind, slug, name, status)
      VALUES ('32323232-0000-0000-0000-0000000000a1',
              '32323232-0000-0000-0000-000000000032', 'accessory', 'inv-32', 'Inv 32', 'draft');
      INSERT INTO app.product_variants (id, tenant_id, product_id, sku, variant_type, uom, price_pyg)
      VALUES ('32323232-0000-0000-0000-0000000000b1',
              '32323232-0000-0000-0000-000000000032',
              '32323232-0000-0000-0000-0000000000a1', 'INV-32', 'bulk', 'ml', 0);
      INSERT INTO app.inventory_movements
        (tenant_id, lot_id, variant_id, qty, uom, movement_type)
      VALUES ('11111111-1111-1111-1111-111111111111',
              '99999999-0000-0000-0000-000000000002',
              '32323232-0000-0000-0000-0000000000b1', 1, 'ml', 'adjustment');
    END $x$
  $$,
  'Variante % no encontrada en el tenant del movimiento%');

-- 33 ─ La proyección de saldo verifica el tenant POR SÍ SOLA. Se
-- deshabilitan los dos BEFORE INSERT que hoy rechazan antes, para que lo
-- único que pueda frenar el movimiento sea `project_lot_balance`: ningún
-- trigger puede depender de que otro haya corrido antes. El DISABLE se
-- revierte con el resto del bloque cuando el rechazo aborta la
-- subtransacción. Desde 0023 (WP-B08c) la FK compuesta de lote también
-- rechaza el cruce, y corre antes (los triggers AFTER van en orden
-- alfabético y los de FK empiezan con "RI_"): se deshabilitan todos y se
-- rehabilita solo el que se prueba.
SELECT pg_temp.expect_fail_like(33, 'project_lot_balance sola: saldo de un lote de otro tenant',
  $$DO $x$
    BEGIN
      INSERT INTO app.tenants (id, slug, legal_name, trade_name)
      VALUES ('33333333-0000-0000-0000-000000000033', 'tenant-inv-33', 'Inv 33 SA', 'Inv 33');
      ALTER TABLE app.inventory_movements DISABLE TRIGGER ALL;
      ALTER TABLE app.inventory_movements ENABLE TRIGGER trg_project_balance;
      INSERT INTO app.inventory_movements
        (tenant_id, lot_id, variant_id, qty, uom, movement_type)
      VALUES ('33333333-0000-0000-0000-000000000033',
              '99999999-0000-0000-0000-000000000002',
              '55555555-0000-0000-0000-000000000002', 1, 'ml', 'adjustment');
      ALTER TABLE app.inventory_movements ENABLE TRIGGER ALL;
    END $x$
  $$,
  'No existe fila de saldo para el lote % en el tenant del movimiento');

-- 34 ─ LA TRAMPA DE B09: `assert_sealed_lot_not_open` falla cerrado POR SÍ
-- SOLO, sin `trg_movement_uom` delante (que desde WP-B01 enmascaraba su
-- falla abierta) ni `trg_project_balance` detrás. Una venta del lote de
-- granel de OTRO tenant: sin la verificación de tenant, el lote es granel
-- (no sellado) y el trigger la dejaba pasar.
SELECT pg_temp.expect_fail_like(34, 'assert_sealed_lot_not_open solo: venta sobre el lote de otro tenant',
  $$DO $x$
    BEGIN
      INSERT INTO app.tenants (id, slug, legal_name, trade_name)
      VALUES ('34343434-0000-0000-0000-000000000034', 'tenant-inv-34', 'Inv 34 SA', 'Inv 34');
      ALTER TABLE app.inventory_movements DISABLE TRIGGER trg_movement_uom;
      ALTER TABLE app.inventory_movements DISABLE TRIGGER trg_project_balance;
      INSERT INTO app.inventory_movements
        (tenant_id, lot_id, variant_id, qty, uom, movement_type)
      VALUES ('34343434-0000-0000-0000-000000000034',
              '99999999-0000-0000-0000-000000000002',
              '55555555-0000-0000-0000-000000000002', -1, 'ml', 'sale');
      ALTER TABLE app.inventory_movements ENABLE TRIGGER trg_movement_uom;
      ALTER TABLE app.inventory_movements ENABLE TRIGGER trg_project_balance;
    END $x$
  $$,
  'Lote % no encontrado en el tenant del movimiento%');

-- 35 ─ El movimiento de una capa de costo es del tenant de la capa. La
-- capa es del tenant 35, con un lote propio del 35, colgada de un
-- movimiento del tenant real; los importes cuadran, así que lo único que
-- puede rechazarla es la verificación de tenant del movimiento.
-- Desde 0023 (WP-B08c) la FK compuesta rechaza el cruce al insertar la
-- capa, antes que este trigger diferido: se deshabilitan las FKs de la
-- tabla para probar la función sola.
SELECT pg_temp.expect_fail_like(35, 'Capa de costo de un tenant sobre el movimiento de otro',
  $$DO $x$
    DECLARE v_mov bigint;
    BEGIN
      INSERT INTO app.tenants (id, slug, legal_name, trade_name)
      VALUES ('35353535-0000-0000-0000-000000000035', 'tenant-inv-35', 'Inv 35 SA', 'Inv 35');
      INSERT INTO app.products (id, tenant_id, kind, slug, name, status)
      VALUES ('35353535-0000-0000-0000-0000000000a1',
              '35353535-0000-0000-0000-000000000035', 'accessory', 'inv-35', 'Inv 35', 'draft');
      INSERT INTO app.product_variants (id, tenant_id, product_id, sku, variant_type, uom, price_pyg)
      VALUES ('35353535-0000-0000-0000-0000000000b1',
              '35353535-0000-0000-0000-000000000035',
              '35353535-0000-0000-0000-0000000000a1', 'INV-35', 'unit', 'unit', 0);
      INSERT INTO app.inventory_lots
        (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
         fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
      VALUES ('35353535-0000-0000-0000-0000000000c1',
              '35353535-0000-0000-0000-000000000035',
              '35353535-0000-0000-0000-0000000000b1', 1, 'unit', 0, 'PYG', 1, 0, 0);
      INSERT INTO app.inventory_movements
        (tenant_id, lot_id, variant_id, qty, uom, movement_type, total_cost_pyg)
      VALUES ('11111111-1111-1111-1111-111111111111',
              '99999999-0000-0000-0000-000000000002',
              '55555555-0000-0000-0000-000000000002', -1, 'ml', 'sale', 11972)
      RETURNING id INTO v_mov;
      ALTER TABLE app.movement_cost_allocations DISABLE TRIGGER ALL;
      ALTER TABLE app.movement_cost_allocations ENABLE TRIGGER trg_cost_allocation_matches;
      INSERT INTO app.movement_cost_allocations
        (tenant_id, movement_id, lot_id, qty, unit_cost_pyg, total_cost_pyg)
      VALUES ('35353535-0000-0000-0000-000000000035',
              v_mov, '35353535-0000-0000-0000-0000000000c1', 1, 11972, 11972);
      SET CONSTRAINTS app.trg_cost_allocation_matches IMMEDIATE;
    END $x$
  $$,
  'Movimiento % no encontrado en el tenant de la capa de costo%');

-- 36 ─ El lote de una capa de costo es del tenant de la capa. Capa y
-- movimiento del tenant real, lote ajeno; los importes cuadran.
-- Desde 0023 (WP-B08c) la FK compuesta rechaza el cruce al insertar la
-- capa, antes que este trigger diferido: se deshabilitan las FKs de la
-- tabla para probar la función sola.
SELECT pg_temp.expect_fail_like(36, 'Capa de costo sobre el lote de otro tenant',
  $$DO $x$
    DECLARE v_mov bigint;
    BEGIN
      INSERT INTO app.tenants (id, slug, legal_name, trade_name)
      VALUES ('36363636-0000-0000-0000-000000000036', 'tenant-inv-36', 'Inv 36 SA', 'Inv 36');
      INSERT INTO app.products (id, tenant_id, kind, slug, name, status)
      VALUES ('36363636-0000-0000-0000-0000000000a1',
              '36363636-0000-0000-0000-000000000036', 'accessory', 'inv-36', 'Inv 36', 'draft');
      INSERT INTO app.product_variants (id, tenant_id, product_id, sku, variant_type, uom, price_pyg)
      VALUES ('36363636-0000-0000-0000-0000000000b1',
              '36363636-0000-0000-0000-000000000036',
              '36363636-0000-0000-0000-0000000000a1', 'INV-36', 'unit', 'unit', 0);
      INSERT INTO app.inventory_lots
        (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
         fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
      VALUES ('36363636-0000-0000-0000-0000000000c1',
              '36363636-0000-0000-0000-000000000036',
              '36363636-0000-0000-0000-0000000000b1', 1, 'unit', 0, 'PYG', 1, 0, 0);
      INSERT INTO app.inventory_movements
        (tenant_id, lot_id, variant_id, qty, uom, movement_type, total_cost_pyg)
      VALUES ('11111111-1111-1111-1111-111111111111',
              '99999999-0000-0000-0000-000000000002',
              '55555555-0000-0000-0000-000000000002', -1, 'ml', 'sale', 11972)
      RETURNING id INTO v_mov;
      ALTER TABLE app.movement_cost_allocations DISABLE TRIGGER ALL;
      ALTER TABLE app.movement_cost_allocations ENABLE TRIGGER trg_cost_allocation_matches;
      INSERT INTO app.movement_cost_allocations
        (tenant_id, movement_id, lot_id, qty, unit_cost_pyg, total_cost_pyg)
      VALUES ('11111111-1111-1111-1111-111111111111',
              v_mov, '36363636-0000-0000-0000-0000000000c1', 1, 11972, 11972);
      SET CONSTRAINTS app.trg_cost_allocation_matches IMMEDIATE;
    END $x$
  $$,
  'Lote % no encontrado en el tenant de la capa de costo%');

-- 37 ─ Mover una línea de un borrador a otro verifica el cuadre de LOS DOS
-- asientos. `assert_entry_balanced` (0007) miraba solo el asiento de NEW.
-- Secuencia: A cuadra y se verifica; B nace con solo el debe; se mueve el
-- haber de A a B. B queda cuadrado, A descuadrado — y el único evento que
-- nombra a A es el UPDATE, por su OLD.
SELECT pg_temp.expect_fail_like(37, 'Mover una línea entre borradores descuadra el de origen',
  $$DO $x$
    DECLARE v_credit_line bigint;
    BEGIN
      INSERT INTO app.journal_entries
        (id, tenant_id, period_id, entry_no, entry_date, status, memo)
      VALUES ('f0000000-0000-0000-0000-00000000037a',
              '11111111-1111-1111-1111-111111111111',
              'ffffffff-0000-0000-0000-000000000001', 96, current_date,
              'draft', 'Borrador A del invariante 37'),
             ('f0000000-0000-0000-0000-00000000037b',
              '11111111-1111-1111-1111-111111111111',
              'ffffffff-0000-0000-0000-000000000001', 95, current_date,
              'draft', 'Borrador B del invariante 37');
      INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
      SELECT '11111111-1111-1111-1111-111111111111', 'f0000000-0000-0000-0000-00000000037a',
             id, 1000, 0
        FROM app.chart_of_accounts WHERE code = '1.1.01.001'
         AND tenant_id = '11111111-1111-1111-1111-111111111111';
      INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
      SELECT '11111111-1111-1111-1111-111111111111', 'f0000000-0000-0000-0000-00000000037a',
             id, 0, 1000
        FROM app.chart_of_accounts WHERE code = '4.1.01.001'
         AND tenant_id = '11111111-1111-1111-1111-111111111111'
      RETURNING id INTO v_credit_line;
      SET CONSTRAINTS app.trg_journal_balanced IMMEDIATE;
      SET CONSTRAINTS app.trg_journal_balanced DEFERRED;
      INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
      SELECT '11111111-1111-1111-1111-111111111111', 'f0000000-0000-0000-0000-00000000037b',
             id, 1000, 0
        FROM app.chart_of_accounts WHERE code = '1.1.01.001'
         AND tenant_id = '11111111-1111-1111-1111-111111111111';
      UPDATE app.journal_lines SET entry_id = 'f0000000-0000-0000-0000-00000000037b'
       WHERE id = v_credit_line;
      SET CONSTRAINTS app.trg_journal_balanced IMMEDIATE;
    END $x$
  $$,
  'Asiento f0000000-0000-0000-0000-00000000037a descuadrado%');

-- 38 ─ RN-LOT-03 no se elude declarando otra variante. Hallazgo de la
-- revisión cruzada de B09: el trigger decidía con `NEW.variant_id`, que
-- pone quien inserta. Un sellado en `open_for_decant` que conserva saldo:
-- la venta que declara la variante de GRANEL pasaba. El lote tiene saldo,
-- así que el único que puede rechazarla es el guard del frasco abierto.
-- (Desde WP-C11 la apertura nunca deja saldo, y un sellado abierto es de
-- una sola unidad — el 79 —; este lote sale de un UPDATE manual del estado
-- sin la salida de la unidad. El guard tiene que rechazar igual, por sí
-- solo: no depende de que la apertura se haya hecho bien.)
SELECT pg_temp.expect_fail_like(38, 'Venta de un sellado abierto declarando la variante de granel',
  $$DO $x$
    BEGIN
      INSERT INTO app.inventory_lots
        (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
         fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
      VALUES ('99999999-0000-0000-0000-000000000038',
              '11111111-1111-1111-1111-111111111111',
              '55555555-0000-0000-0000-000000000001', 1, 'unit', 0, 'PYG', 1, 0, 0);
      INSERT INTO app.inventory_movements
        (tenant_id, lot_id, variant_id, qty, uom, movement_type)
      VALUES ('11111111-1111-1111-1111-111111111111',
              '99999999-0000-0000-0000-000000000038',
              '55555555-0000-0000-0000-000000000001', 1, 'unit', 'purchase_receipt');
      UPDATE app.inventory_lots SET status = 'open_for_decant'
       WHERE id = '99999999-0000-0000-0000-000000000038';
      INSERT INTO app.inventory_movements
        (tenant_id, lot_id, variant_id, qty, uom, movement_type)
      VALUES ('11111111-1111-1111-1111-111111111111',
              '99999999-0000-0000-0000-000000000038',
              '55555555-0000-0000-0000-000000000002', -1, 'unit', 'sale');
    END $x$
  $$,
  'El lote 99999999-0000-0000-0000-000000000038 está abierto para decantar%');

-- 39 ─ Un lote cuya variante es de otro tenant no mueve. Desde 0023
-- (WP-B08c) ese lote ya no se puede crear: la FK compuesta lo rechaza (el
-- 67 y cross_tenant_fks.test.ts lo prueban). Acá se lo fabrica con las
-- FKs deshabilitadas, para probar que el guard del frasco abierto, que
-- busca la variante del lote en el tenant del movimiento, sigue fallando
-- cerrado por sí solo ante un dato corrupto.
SELECT pg_temp.expect_fail_like(39, 'Movimiento sobre un lote cuya variante es de otro tenant',
  $$DO $x$
    BEGIN
      INSERT INTO app.tenants (id, slug, legal_name, trade_name)
      VALUES ('39393939-0000-0000-0000-000000000039', 'tenant-inv-39', 'Inv 39 SA', 'Inv 39');
      INSERT INTO app.products (id, tenant_id, kind, slug, name, status)
      VALUES ('39393939-0000-0000-0000-0000000000a1',
              '39393939-0000-0000-0000-000000000039', 'accessory', 'inv-39', 'Inv 39', 'draft');
      INSERT INTO app.product_variants (id, tenant_id, product_id, sku, variant_type, uom, price_pyg)
      VALUES ('39393939-0000-0000-0000-0000000000b1',
              '39393939-0000-0000-0000-000000000039',
              '39393939-0000-0000-0000-0000000000a1', 'INV-39', 'unit', 'unit', 0);
      ALTER TABLE app.inventory_lots DISABLE TRIGGER ALL;
      INSERT INTO app.inventory_lots
        (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
         fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
      VALUES ('99999999-0000-0000-0000-000000000039',
              '11111111-1111-1111-1111-111111111111',
              '39393939-0000-0000-0000-0000000000b1', 1, 'unit', 0, 'PYG', 1, 0, 0);
      ALTER TABLE app.inventory_lots ENABLE TRIGGER ALL;
      INSERT INTO app.inventory_movements
        (tenant_id, lot_id, variant_id, qty, uom, movement_type)
      VALUES ('11111111-1111-1111-1111-111111111111',
              '99999999-0000-0000-0000-000000000039',
              '55555555-0000-0000-0000-00000000a001', 1, 'unit', 'adjustment');
    END $x$
  $$,
  'Variante del lote % no encontrada en el tenant del movimiento%');

-- ─────────────────────────────────────────────────────────────────────
-- WP-B13 (0019_has_permission_session_bound.sql): has_permission exige una
-- sesión válida, y ninguna SECURITY DEFINER busca primero en pg_temp.
-- ─────────────────────────────────────────────────────────────────────

-- 40 ─ Toda función SECURITY DEFINER de app.* fija `search_path = app,
-- pg_temp`. Con `app, public` (lo que tenían has_permission y las dos
-- búsquedas de login), `pg_temp` se busca PRIMERO y una tabla temporal
-- sombrea a la real: verificado como `joda_api` en WP-B10 sobre
-- has_permission. El 28 cubre las de disparador; este, todas.
SELECT pg_temp.expect_true(40,
  'Toda función SECURITY DEFINER de app.* tiene search_path = app, pg_temp',
  NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app'
       AND p.prosecdef
       AND NOT ('search_path=app, pg_temp' = ANY (COALESCE(p.proconfig, '{}')))
  ));

-- 41 a 46 ─ has_permission con el owner del smoke, que TIENE el permiso
-- por rol. Cada bloque fija el contexto como withTenantTx y rechaza con
-- 'concedido' si has_permission da true: en 41–45 ese rechazo es un FALLO
-- (se concedió lo que no debía), así que se busca el rechazo 'denegado'.
-- El 46 es el control positivo, al revés. Las sesiones se crean dentro del
-- bloque y se revierten con él.

-- 41 ─ Sin app.session_id no hay permiso, aunque el user_id tenga el rol.
-- Es exactamente el caso del error de aplicación que fija un user_id.
SELECT pg_temp.expect_fail_like(41, 'has_permission sin app.session_id',
  $$DO $x$
    BEGIN
      PERFORM set_config('app.user_id', '22222222-2222-2222-2222-222222222222', true),
              set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true),
              set_config('app.audience', 'staff', true),
              set_config('app.session_id', '', true);
      IF app.has_permission('accounting.journal:read') THEN
        RAISE EXCEPTION 'concedido';
      END IF;
      RAISE EXCEPTION 'denegado';
    END $x$
  $$,
  'denegado');

-- 42 ─ Una sesión revocada no concede permisos.
SELECT pg_temp.expect_fail_like(42, 'has_permission con una sesión revocada',
  $$DO $x$
    BEGIN
      INSERT INTO app.staff_sessions (id, tenant_id, staff_user_id, expires_at, revoked_at, revoked_reason)
      VALUES ('5e550000-0000-0000-0000-000000000042', '11111111-1111-1111-1111-111111111111',
              '22222222-2222-2222-2222-222222222222', now() + interval '8 hours', now(), 'logout');
      PERFORM set_config('app.user_id', '22222222-2222-2222-2222-222222222222', true),
              set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true),
              set_config('app.audience', 'staff', true),
              set_config('app.session_id', '5e550000-0000-0000-0000-000000000042', true);
      IF app.has_permission('accounting.journal:read') THEN
        RAISE EXCEPTION 'concedido';
      END IF;
      RAISE EXCEPTION 'denegado';
    END $x$
  $$,
  'denegado');

-- 43 ─ Una sesión vencida no concede permisos.
SELECT pg_temp.expect_fail_like(43, 'has_permission con una sesión vencida',
  $$DO $x$
    BEGIN
      INSERT INTO app.staff_sessions (id, tenant_id, staff_user_id, expires_at)
      VALUES ('5e550000-0000-0000-0000-000000000043', '11111111-1111-1111-1111-111111111111',
              '22222222-2222-2222-2222-222222222222', now() - interval '1 second');
      PERFORM set_config('app.user_id', '22222222-2222-2222-2222-222222222222', true),
              set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true),
              set_config('app.audience', 'staff', true),
              set_config('app.session_id', '5e550000-0000-0000-0000-000000000043', true);
      IF app.has_permission('accounting.journal:read') THEN
        RAISE EXCEPTION 'concedido';
      END IF;
      RAISE EXCEPTION 'denegado';
    END $x$
  $$,
  'denegado');

-- 44 ─ La sesión de OTRO usuario no concede los permisos de este: el
-- user_id equivocado necesita una sesión viva de ESE usuario, no una
-- cualquiera.
SELECT pg_temp.expect_fail_like(44, 'has_permission con la sesión de otro usuario',
  $$DO $x$
    BEGIN
      INSERT INTO app.staff_users (id, tenant_id, auth_subject, email, full_name)
      VALUES ('22222222-0000-0000-0000-000000000044', '11111111-1111-1111-1111-111111111111',
              'sub-inv-44', 'inv44@joda.test', 'Invariante 44');
      INSERT INTO app.staff_sessions (id, tenant_id, staff_user_id, expires_at)
      VALUES ('5e550000-0000-0000-0000-000000000044', '11111111-1111-1111-1111-111111111111',
              '22222222-0000-0000-0000-000000000044', now() + interval '8 hours');
      PERFORM set_config('app.user_id', '22222222-2222-2222-2222-222222222222', true),
              set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true),
              set_config('app.audience', 'staff', true),
              set_config('app.session_id', '5e550000-0000-0000-0000-000000000044', true);
      IF app.has_permission('accounting.journal:read') THEN
        RAISE EXCEPTION 'concedido';
      END IF;
      RAISE EXCEPTION 'denegado';
    END $x$
  $$,
  'denegado');

-- 45 ─ Una sesión del usuario en OTRO tenant no concede permisos en este.
-- Desde 0023 (WP-B08c) esa sesión no se puede crear: la FK compuesta
-- staff_user_id → staff_users exige el mismo tenant. Se la fabrica con las
-- FKs deshabilitadas para probar que has_permission sigue verificando el
-- tenant de la sesión por sí sola.
SELECT pg_temp.expect_fail_like(45, 'has_permission con una sesión de otro tenant',
  $$DO $x$
    BEGIN
      INSERT INTO app.tenants (id, slug, legal_name, trade_name)
      VALUES ('45454545-0000-0000-0000-000000000045', 'tenant-inv-45', 'Inv 45 SA', 'Inv 45');
      ALTER TABLE app.staff_sessions DISABLE TRIGGER ALL;
      INSERT INTO app.staff_sessions (id, tenant_id, staff_user_id, expires_at)
      VALUES ('5e550000-0000-0000-0000-000000000045', '45454545-0000-0000-0000-000000000045',
              '22222222-2222-2222-2222-222222222222', now() + interval '8 hours');
      ALTER TABLE app.staff_sessions ENABLE TRIGGER ALL;
      PERFORM set_config('app.user_id', '22222222-2222-2222-2222-222222222222', true),
              set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true),
              set_config('app.audience', 'staff', true),
              set_config('app.session_id', '5e550000-0000-0000-0000-000000000045', true);
      IF app.has_permission('accounting.journal:read') THEN
        RAISE EXCEPTION 'concedido';
      END IF;
      RAISE EXCEPTION 'denegado';
    END $x$
  $$,
  'denegado');

-- 46 ─ Control positivo: sesión viva, del usuario y del tenant → concede.
-- Sin esto, 41–45 pasarían igual con un has_permission que siempre diera
-- false.
SELECT pg_temp.expect_fail_like(46, 'has_permission con una sesión válida (control positivo)',
  $$DO $x$
    BEGIN
      INSERT INTO app.staff_sessions (id, tenant_id, staff_user_id, expires_at)
      VALUES ('5e550000-0000-0000-0000-000000000046', '11111111-1111-1111-1111-111111111111',
              '22222222-2222-2222-2222-222222222222', now() + interval '8 hours');
      PERFORM set_config('app.user_id', '22222222-2222-2222-2222-222222222222', true),
              set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true),
              set_config('app.audience', 'staff', true),
              set_config('app.session_id', '5e550000-0000-0000-0000-000000000046', true);
      IF app.has_permission('accounting.journal:read') THEN
        RAISE EXCEPTION 'concedido';
      END IF;
      RAISE EXCEPTION 'denegado';
    END $x$
  $$,
  'concedido');

-- ─────────────────────────────────────────────────────────────────────
-- WP-B14 (0020_journal_immutability.sql, RN-CTB-06): inmutabilidad
-- contable completa. `posted` y `reversed` no se tocan; draft → posted;
-- posted → reversed solo con una reversión contabilizada; reversed es
-- terminal.
-- ─────────────────────────────────────────────────────────────────────

-- Asiento contabilizado por el flujo real: nace en borrador, recibe un par
-- de líneas cuadrado y pasa a posted. Si `p_reverses` no es NULL, es la
-- reversión de ese asiento (las líneas van invertidas).
CREATE OR REPLACE FUNCTION pg_temp.post_test_entry(
  p_id uuid, p_entry_no bigint, p_reverses uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO app.journal_entries
    (id, tenant_id, period_id, entry_no, entry_date, status, memo, reverses_id)
  VALUES (p_id, '11111111-1111-1111-1111-111111111111',
          'ffffffff-0000-0000-0000-000000000001', p_entry_no, current_date,
          'draft', 'Asiento de prueba de WP-B14', p_reverses);
  INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
  SELECT '11111111-1111-1111-1111-111111111111', p_id, id,
         CASE WHEN p_reverses IS NULL THEN 1000 ELSE 0 END,
         CASE WHEN p_reverses IS NULL THEN 0 ELSE 1000 END
    FROM app.chart_of_accounts WHERE code = '1.1.01.001'
     AND tenant_id = '11111111-1111-1111-1111-111111111111';
  INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
  SELECT '11111111-1111-1111-1111-111111111111', p_id, id,
         CASE WHEN p_reverses IS NULL THEN 0 ELSE 1000 END,
         CASE WHEN p_reverses IS NULL THEN 1000 ELSE 0 END
    FROM app.chart_of_accounts WHERE code = '4.1.01.001'
     AND tenant_id = '11111111-1111-1111-1111-111111111111';
  UPDATE app.journal_entries SET status = 'posted', posted_at = now() WHERE id = p_id;
END $$;

-- 47 ─ Un asiento contabilizado no recibe líneas nuevas. Hallazgo de la
-- segunda revisión cruzada de B10: el guard de 0017 en INSERT solo miraba
-- el tenant, y un par compensado pasaba (cuadra, nada más lo frenaba).
SELECT pg_temp.expect_fail_like(47, 'Línea nueva (par compensado) en un asiento contabilizado',
  $$DO $x$
    BEGIN
      INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
      SELECT '11111111-1111-1111-1111-111111111111', 'f0000000-0000-0000-0000-000000000001', id, 1000, 0
        FROM app.chart_of_accounts WHERE code = '1.1.01.001'
         AND tenant_id = '11111111-1111-1111-1111-111111111111';
      INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
      SELECT '11111111-1111-1111-1111-111111111111', 'f0000000-0000-0000-0000-000000000001', id, 0, 1000
        FROM app.chart_of_accounts WHERE code = '4.1.01.001'
         AND tenant_id = '11111111-1111-1111-1111-111111111111';
    END $x$
  $$,
  'El asiento ya está contabilizado%');

-- 48 ─ posted no vuelve a draft. Verificado en la misma revisión de B10:
-- reabrir, editar y volver a contabilizar no dejaba rastro.
SELECT pg_temp.expect_fail_like(48, 'Reabrir un asiento contabilizado (posted → draft)',
  $$UPDATE app.journal_entries SET status = 'draft'
     WHERE id = 'f0000000-0000-0000-0000-000000000001'$$,
  'El asiento ya está contabilizado%');

-- 49 ─ Un asiento contabilizado no se edita, aunque el estado no cambie.
SELECT pg_temp.expect_fail_like(49, 'Editar el memo de un asiento contabilizado',
  $$UPDATE app.journal_entries SET memo = 'editado'
     WHERE id = 'f0000000-0000-0000-0000-000000000001'$$,
  'El asiento ya está contabilizado%');

-- 50 ─ posted → reversed exige una reversión contabilizada que lo
-- referencie. Sin ninguna reversión, se rechaza.
SELECT pg_temp.expect_fail_like(50, 'Marcar revertido un asiento sin reversión',
  $$UPDATE app.journal_entries SET status = 'reversed'
     WHERE id = 'f0000000-0000-0000-0000-000000000001'$$,
  '%no tiene un asiento de reversión contabilizado%');

-- 51 ─ ... y una reversión todavía en borrador no alcanza.
SELECT pg_temp.expect_fail_like(51, 'Marcar revertido con la reversión todavía en borrador',
  $$DO $x$
    BEGIN
      PERFORM pg_temp.post_test_entry('f0000000-0000-0000-0000-000000000510', 510);
      INSERT INTO app.journal_entries
        (id, tenant_id, period_id, entry_no, entry_date, status, memo, reverses_id)
      VALUES ('f0000000-0000-0000-0000-000000000511', '11111111-1111-1111-1111-111111111111',
              'ffffffff-0000-0000-0000-000000000001', 511, current_date, 'draft',
              'Reversión en borrador', 'f0000000-0000-0000-0000-000000000510');
      UPDATE app.journal_entries SET status = 'reversed'
       WHERE id = 'f0000000-0000-0000-0000-000000000510';
    END $x$
  $$,
  '%no tiene un asiento de reversión contabilizado%');

-- 52 ─ Control positivo: el flujo correcto de reversión funciona. Sin
-- esto, 50/51 pasarían igual con un trigger que rechazara toda reversión.
SELECT pg_temp.expect_fail_like(52, 'Reversión por el flujo correcto (control positivo)',
  $$DO $x$
    BEGIN
      PERFORM pg_temp.post_test_entry('f0000000-0000-0000-0000-000000000520', 520);
      PERFORM pg_temp.post_test_entry('f0000000-0000-0000-0000-000000000521', 521,
                                      'f0000000-0000-0000-0000-000000000520');
      UPDATE app.journal_entries SET status = 'reversed'
       WHERE id = 'f0000000-0000-0000-0000-000000000520';
      SET CONSTRAINTS app.trg_journal_balanced IMMEDIATE;
      IF (SELECT status FROM app.journal_entries
           WHERE id = 'f0000000-0000-0000-0000-000000000520') = 'reversed' THEN
        RAISE EXCEPTION 'aceptado';
      END IF;
    END $x$
  $$,
  'aceptado');

-- 53 ─ reversed es terminal.
SELECT pg_temp.expect_fail_like(53, 'Sacar un asiento de reversed',
  $$DO $x$
    BEGIN
      PERFORM pg_temp.post_test_entry('f0000000-0000-0000-0000-000000000530', 530);
      PERFORM pg_temp.post_test_entry('f0000000-0000-0000-0000-000000000531', 531,
                                      'f0000000-0000-0000-0000-000000000530');
      UPDATE app.journal_entries SET status = 'reversed'
       WHERE id = 'f0000000-0000-0000-0000-000000000530';
      UPDATE app.journal_entries SET status = 'posted'
       WHERE id = 'f0000000-0000-0000-0000-000000000530';
    END $x$
  $$,
  '%está revertido: es definitivo');

-- 54 ─ Las líneas de un asiento revertido tampoco se tocan. 0017 solo
-- bloqueaba 'posted': las de un 'reversed' se editaban como un borrador.
SELECT pg_temp.expect_fail_like(54, 'Editar una línea de un asiento revertido',
  $$DO $x$
    BEGIN
      PERFORM pg_temp.post_test_entry('f0000000-0000-0000-0000-000000000540', 540);
      PERFORM pg_temp.post_test_entry('f0000000-0000-0000-0000-000000000541', 541,
                                      'f0000000-0000-0000-0000-000000000540');
      UPDATE app.journal_entries SET status = 'reversed'
       WHERE id = 'f0000000-0000-0000-0000-000000000540';
      UPDATE app.journal_lines SET memo = 'editada'
       WHERE entry_id = 'f0000000-0000-0000-0000-000000000540';
    END $x$
  $$,
  'El asiento ya está contabilizado%');

-- 55 ─ Un asiento nace en borrador.
SELECT pg_temp.expect_fail_like(55, 'Crear un asiento directamente en posted',
  $$INSERT INTO app.journal_entries
      (tenant_id, period_id, entry_no, entry_date, status, memo, posted_at)
    VALUES ('11111111-1111-1111-1111-111111111111',
            'ffffffff-0000-0000-0000-000000000001', 550, current_date,
            'posted', 'Nacido contabilizado', now())$$,
  'Un asiento nace en borrador%');

-- 56 ─ Un borrador no pasa a reversed.
SELECT pg_temp.expect_fail_like(56, 'Borrador directo a reversed',
  $$DO $x$
    BEGIN
      INSERT INTO app.journal_entries
        (id, tenant_id, period_id, entry_no, entry_date, status, memo)
      VALUES ('f0000000-0000-0000-0000-000000000560', '11111111-1111-1111-1111-111111111111',
              'ffffffff-0000-0000-0000-000000000001', 560, current_date, 'draft', 'Borrador 56');
      UPDATE app.journal_entries SET status = 'reversed'
       WHERE id = 'f0000000-0000-0000-0000-000000000560';
    END $x$
  $$,
  'Un borrador no se revierte%');

-- 57 ─ Un asiento contabilizado no se borra, ni siquiera sin líneas (el
-- invariante 25 cubre el que tiene líneas).
SELECT pg_temp.expect_fail_like(57, 'Borrar un asiento contabilizado sin líneas',
  $$DO $x$
    BEGIN
      INSERT INTO app.journal_entries
        (id, tenant_id, period_id, entry_no, entry_date, status, memo)
      VALUES ('f0000000-0000-0000-0000-000000000570', '11111111-1111-1111-1111-111111111111',
              'ffffffff-0000-0000-0000-000000000001', 570, current_date, 'draft', 'Asiento 57');
      UPDATE app.journal_entries SET status = 'posted', posted_at = now()
       WHERE id = 'f0000000-0000-0000-0000-000000000570';
      DELETE FROM app.journal_entries WHERE id = 'f0000000-0000-0000-0000-000000000570';
    END $x$
  $$,
  '%no está en borrador: no se borra, se reversa');

-- 58 ─ Una reversión apunta a un asiento del MISMO tenant. La FK
-- reverses_id no evalúa RLS.
SELECT pg_temp.expect_fail_like(58, 'Reversión de un asiento de otro tenant',
  $$DO $x$
    BEGIN
      INSERT INTO app.tenants (id, slug, legal_name, trade_name)
      VALUES ('58585858-0000-0000-0000-000000000058', 'tenant-inv-58', 'Inv 58 SA', 'Inv 58');
      INSERT INTO app.accounting_periods (id, tenant_id, code, starts_on, ends_on)
      VALUES ('58585858-0000-0000-0000-0000000000f1', '58585858-0000-0000-0000-000000000058',
              '2026-09', '2026-09-01', '2026-09-30');
      INSERT INTO app.journal_entries
        (id, tenant_id, period_id, entry_no, entry_date, status, memo)
      VALUES ('58585858-0000-0000-0000-0000000000e1', '58585858-0000-0000-0000-000000000058',
              '58585858-0000-0000-0000-0000000000f1', 1, current_date, 'draft', 'Ajeno');
      UPDATE app.journal_entries SET status = 'posted', posted_at = now()
       WHERE id = '58585858-0000-0000-0000-0000000000e1';
      INSERT INTO app.journal_entries
        (tenant_id, period_id, entry_no, entry_date, status, memo, reverses_id)
      VALUES ('11111111-1111-1111-1111-111111111111',
              'ffffffff-0000-0000-0000-000000000001', 580, current_date, 'draft',
              'Reversión cruzada', '58585858-0000-0000-0000-0000000000e1');
    END $x$
  $$,
  'Asiento a revertir % no encontrado en el tenant del asiento');

-- 59 ─ Solo se revierte un asiento contabilizado.
SELECT pg_temp.expect_fail_like(59, 'Reversión de un borrador',
  $$DO $x$
    BEGIN
      INSERT INTO app.journal_entries
        (id, tenant_id, period_id, entry_no, entry_date, status, memo)
      VALUES ('f0000000-0000-0000-0000-000000000590', '11111111-1111-1111-1111-111111111111',
              'ffffffff-0000-0000-0000-000000000001', 590, current_date, 'draft', 'Borrador 59');
      INSERT INTO app.journal_entries
        (tenant_id, period_id, entry_no, entry_date, status, memo, reverses_id)
      VALUES ('11111111-1111-1111-1111-111111111111',
              'ffffffff-0000-0000-0000-000000000001', 591, current_date, 'draft',
              'Reversión de un borrador', 'f0000000-0000-0000-0000-000000000590');
    END $x$
  $$,
  'Solo se revierte un asiento contabilizado%');

-- 60 ─ El tenant de un asiento no cambia: sus líneas quedarían colgadas de
-- un asiento de otro tenant.
SELECT pg_temp.expect_fail_like(60, 'Mover un borrador a otro tenant',
  $$DO $x$
    BEGIN
      INSERT INTO app.tenants (id, slug, legal_name, trade_name)
      VALUES ('60606060-0000-0000-0000-000000000060', 'tenant-inv-60', 'Inv 60 SA', 'Inv 60');
      INSERT INTO app.journal_entries
        (id, tenant_id, period_id, entry_no, entry_date, status, memo)
      VALUES ('f0000000-0000-0000-0000-000000000600', '11111111-1111-1111-1111-111111111111',
              'ffffffff-0000-0000-0000-000000000001', 600, current_date, 'draft', 'Borrador 60');
      UPDATE app.journal_entries SET tenant_id = '60606060-0000-0000-0000-000000000060'
       WHERE id = 'f0000000-0000-0000-0000-000000000600';
    END $x$
  $$,
  'El tenant de un asiento no cambia');

-- 61 ─ CONSECUENCIA DELIBERADA (0017, escrita en 0020): un borrador con
-- líneas no se borra de un golpe. La cascada borra las líneas con el
-- asiento ya inexistente, y el guard, que falla cerrado, no distingue esa
-- línea huérfana de una colgada de un asiento de otro tenant.
SELECT pg_temp.expect_fail_like(61, 'Borrar de un golpe un borrador con líneas (deliberado)',
  $$DO $x$
    BEGIN
      INSERT INTO app.journal_entries
        (id, tenant_id, period_id, entry_no, entry_date, status, memo)
      VALUES ('f0000000-0000-0000-0000-000000000610', '11111111-1111-1111-1111-111111111111',
              'ffffffff-0000-0000-0000-000000000001', 610, current_date, 'draft', 'Borrador 61');
      INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
      SELECT '11111111-1111-1111-1111-111111111111', 'f0000000-0000-0000-0000-000000000610', id, 1000, 0
        FROM app.chart_of_accounts WHERE code = '1.1.01.001'
         AND tenant_id = '11111111-1111-1111-1111-111111111111';
      DELETE FROM app.journal_entries WHERE id = 'f0000000-0000-0000-0000-000000000610';
    END $x$
  $$,
  'Asiento % no encontrado en el tenant de la línea%');

-- 62 ─ ... y el camino correcto, primero las líneas y después el asiento,
-- funciona (control positivo del 61).
SELECT pg_temp.expect_fail_like(62, 'Borrar un borrador: primero las líneas, después el asiento',
  $$DO $x$
    BEGIN
      INSERT INTO app.journal_entries
        (id, tenant_id, period_id, entry_no, entry_date, status, memo)
      VALUES ('f0000000-0000-0000-0000-000000000620', '11111111-1111-1111-1111-111111111111',
              'ffffffff-0000-0000-0000-000000000001', 620, current_date, 'draft', 'Borrador 62');
      INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
      SELECT '11111111-1111-1111-1111-111111111111', 'f0000000-0000-0000-0000-000000000620', id, 1000, 0
        FROM app.chart_of_accounts WHERE code = '1.1.01.001'
         AND tenant_id = '11111111-1111-1111-1111-111111111111';
      DELETE FROM app.journal_lines WHERE entry_id = 'f0000000-0000-0000-0000-000000000620';
      DELETE FROM app.journal_entries WHERE id = 'f0000000-0000-0000-0000-000000000620';
      SET CONSTRAINTS app.trg_journal_balanced IMMEDIATE;
      IF NOT EXISTS (SELECT 1 FROM app.journal_entries
                      WHERE id = 'f0000000-0000-0000-0000-000000000620') THEN
        RAISE EXCEPTION 'aceptado';
      END IF;
    END $x$
  $$,
  'aceptado');

-- ─────────────────────────────────────────────────────────────────────
-- WP-B12 (0021_app_views_security_invoker.sql): las vistas de app.* se
-- evalúan con los permisos de quien consulta; las de public no.
-- ─────────────────────────────────────────────────────────────────────

-- 63 ─ Toda vista de app.* es security_invoker, sin excepciones desde
-- WP-B12b (0022), y ninguna de public lo es.
-- Una vista de app.* sin security_invoker corre como su dueño, que elude
-- RLS, y le muestra a `joda_api` filas de todos los tenants (demostrado
-- con v_trial_balance en la revisión de B10). Las de public son la
-- excepción deliberada: corren como su dueño para que `joda_readonly` vea
-- el catálogo publicado. "Arreglarlas" dejaría al storefront sin catálogo.
SELECT pg_temp.expect_true(63,
  'Toda vista de app.* es security_invoker; ninguna de public.v_catalog_* lo es',
  NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'v'
       AND (   (n.nspname = 'app'
                AND NOT ('security_invoker=true' = ANY (COALESCE(c.reloptions, '{}'))))
            OR (n.nspname = 'public' AND c.relname LIKE 'v\_catalog\_%'
                AND 'security_invoker=true' = ANY (COALESCE(c.reloptions, '{}'))))
  ));

-- 64 ─ Revertir un asiento deja el balance como estaba (RN-CTB-06). Hasta
-- 0021, v_trial_balance contaba solo 'posted': el original, ya 'reversed',
-- desaparecía, la reversión quedaba sola, y el saldo de la cuenta cambiaba
-- en el importe invertido en vez de volver al de antes.
SELECT pg_temp.expect_fail_like(64, 'Revertir un asiento deja el balance como estaba',
  $$DO $x$
    DECLARE v_before numeric; v_after numeric;
    BEGIN
      SELECT COALESCE(sum(balance_pyg), 0) INTO v_before
        FROM app.v_trial_balance
       WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND account_code = '1.1.01.001';
      PERFORM pg_temp.post_test_entry('f0000000-0000-0000-0000-000000000640', 640);
      PERFORM pg_temp.post_test_entry('f0000000-0000-0000-0000-000000000641', 641,
                                      'f0000000-0000-0000-0000-000000000640');
      UPDATE app.journal_entries SET status = 'reversed'
       WHERE id = 'f0000000-0000-0000-0000-000000000640';
      SELECT COALESCE(sum(balance_pyg), 0) INTO v_after
        FROM app.v_trial_balance
       WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND account_code = '1.1.01.001';
      IF v_after = v_before THEN
        RAISE EXCEPTION 'aceptado';
      END IF;
      RAISE EXCEPTION 'balance cambió: antes=% después=%', v_before, v_after;
    END $x$
  $$,
  'aceptado');

-- 65 ─ Una reversión en un período posterior NO reescribe el período del
-- original. Hallazgo de la revisión cruzada de B12, fijado como
-- comportamiento correcto: el período original conserva el asiento (un
-- período cerrado no se reescribe) y la reversión impacta en el suyo. La
-- compensación vale en el total, no por período. Con el filtro viejo
-- ('posted' solo), el original desaparecía retroactivamente de su período.
SELECT pg_temp.expect_fail_like(65, 'Reversión en otro período: cada asiento queda en el suyo',
  $$DO $x$
    DECLARE v_orig numeric; v_rev numeric;
    BEGIN
      INSERT INTO app.accounting_periods (id, tenant_id, code, starts_on, ends_on)
      VALUES ('ffffffff-0000-0000-0000-000000000065', '11111111-1111-1111-1111-111111111111',
              '2026-10', '2026-10-01', '2026-10-31');
      PERFORM pg_temp.post_test_entry('f0000000-0000-0000-0000-000000000650', 650);
      INSERT INTO app.journal_entries
        (id, tenant_id, period_id, entry_no, entry_date, status, memo, reverses_id)
      VALUES ('f0000000-0000-0000-0000-000000000651', '11111111-1111-1111-1111-111111111111',
              'ffffffff-0000-0000-0000-000000000065', 651, current_date, 'draft',
              'Reversión en octubre', 'f0000000-0000-0000-0000-000000000650');
      INSERT INTO app.journal_lines (tenant_id, entry_id, account_id, debit_pyg, credit_pyg)
      SELECT '11111111-1111-1111-1111-111111111111', 'f0000000-0000-0000-0000-000000000651', id,
             CASE code WHEN '1.1.01.001' THEN 0 ELSE 1000 END,
             CASE code WHEN '1.1.01.001' THEN 1000 ELSE 0 END
        FROM app.chart_of_accounts WHERE code IN ('1.1.01.001', '4.1.01.001')
         AND tenant_id = '11111111-1111-1111-1111-111111111111';
      UPDATE app.journal_entries SET status = 'posted', posted_at = now()
       WHERE id = 'f0000000-0000-0000-0000-000000000651';
      UPDATE app.journal_entries SET status = 'reversed'
       WHERE id = 'f0000000-0000-0000-0000-000000000650';
      SELECT COALESCE(sum(balance_pyg), 0) INTO v_rev
        FROM app.v_trial_balance
       WHERE period_id = 'ffffffff-0000-0000-0000-000000000065' AND account_code = '1.1.01.001';
      SELECT COALESCE(sum(jl.debit_pyg - jl.credit_pyg), 0) INTO v_orig
        FROM app.journal_lines jl JOIN app.chart_of_accounts c ON c.id = jl.account_id
       WHERE jl.entry_id = 'f0000000-0000-0000-0000-000000000650' AND c.code = '1.1.01.001';
      IF v_orig = 1000 AND v_rev = -1000
         AND EXISTS (SELECT 1 FROM app.v_trial_balance
                      WHERE period_id = 'ffffffff-0000-0000-0000-000000000001'
                        AND account_code = '1.1.01.001') THEN
        RAISE EXCEPTION 'aceptado';
      END IF;
      RAISE EXCEPTION 'inesperado: original=% reversión en su período=%', v_orig, v_rev;
    END $x$
  $$,
  'aceptado');

-- ─────────────────────────────────────────────────────────────────────
-- WP-B12b (0022_stock_available_invoker.sql): v_catalog_variants calcula
-- la disponibilidad desde su propia fuente, no desde v_stock_available.
-- ─────────────────────────────────────────────────────────────────────

-- 66 ─ La fórmula "saldo − reservas vivas" está escrita dos veces (0022):
-- in_stock de v_catalog_variants coincide con available > 0 de
-- v_stock_available para toda variante publicada. Corre como superusuario,
-- que ve todos los tenants por las dos vistas. El smoke no deja ninguna
-- variante publicada con stock, y "coinciden" sobre un catálogo todo en
-- falso no prueba nada: el bloque le da dos frascos al sellado, compara,
-- los reserva (una reserva viva y una vencida, que no cuenta), y vuelve a
-- comparar. El RAISE final revierte todo.
SELECT pg_temp.expect_fail_like(66,
  'in_stock de v_catalog_variants coincide con v_stock_available',
  $$DO $x$
    DECLARE v_disagree int; v_in_stock_before boolean; v_in_stock_after boolean;
    BEGIN
      INSERT INTO app.inventory_lots
        (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
         fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
      VALUES ('99999999-0000-0000-0000-000000000660', '11111111-1111-1111-1111-111111111111',
              '55555555-0000-0000-0000-000000000001', 2, 'unit', 0, 'PYG', 1, 0, 0);
      INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
      VALUES ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000660',
              '55555555-0000-0000-0000-000000000001', 2, 'unit', 'purchase_receipt');
      SELECT in_stock INTO v_in_stock_before
        FROM public.v_catalog_variants WHERE id = '55555555-0000-0000-0000-000000000001';
      SELECT count(*) INTO v_disagree
        FROM public.v_catalog_variants c
        LEFT JOIN app.v_stock_available s ON s.variant_id = c.id
       WHERE c.in_stock IS DISTINCT FROM (COALESCE(s.available, 0) > 0);
      -- Una viva de 1 y una vencida de 5: queda 1 disponible solo si las
      -- dos fórmulas ignoran la vencida.
      INSERT INTO app.stock_reservations (tenant_id, variant_id, qty, reason, expires_at) VALUES
        ('11111111-1111-1111-1111-111111111111', '55555555-0000-0000-0000-000000000001',
         1, 'manual_hold', now() + interval '1 hour'),
        ('11111111-1111-1111-1111-111111111111', '55555555-0000-0000-0000-000000000001',
         5, 'manual_hold', now() - interval '1 hour');
      SELECT v_disagree + count(*) INTO v_disagree
        FROM public.v_catalog_variants c
        LEFT JOIN app.v_stock_available s ON s.variant_id = c.id
       WHERE c.in_stock IS DISTINCT FROM (COALESCE(s.available, 0) > 0);
      SELECT v_in_stock_before AND in_stock INTO v_in_stock_before
        FROM public.v_catalog_variants WHERE id = '55555555-0000-0000-0000-000000000001';
      -- Otra viva de 1: disponible 0, agotado para las dos.
      INSERT INTO app.stock_reservations (tenant_id, variant_id, qty, reason, expires_at) VALUES
        ('11111111-1111-1111-1111-111111111111', '55555555-0000-0000-0000-000000000001',
         1, 'manual_hold', now() + interval '1 hour');
      SELECT in_stock INTO v_in_stock_after
        FROM public.v_catalog_variants WHERE id = '55555555-0000-0000-0000-000000000001';
      SELECT v_disagree + count(*) INTO v_disagree
        FROM public.v_catalog_variants c
        LEFT JOIN app.v_stock_available s ON s.variant_id = c.id
       WHERE c.in_stock IS DISTINCT FROM (COALESCE(s.available, 0) > 0);
      IF v_disagree = 0 AND v_in_stock_before AND NOT v_in_stock_after THEN
        RAISE EXCEPTION 'aceptado';
      END IF;
      RAISE EXCEPTION 'inesperado: desacuerdos=% antes=% después=%',
        v_disagree, v_in_stock_before, v_in_stock_after;
    END $x$
  $$,
  'aceptado');

-- ─────────────────────────────────────────────────────────────────────
-- WP-B08c (0023_cross_tenant_fks.sql): coherencia entre filas
-- relacionadas. FKs con tenant, variante del movimiento = variante del
-- lote, RN-LOT-03 extendida a cualquier movimiento, y un lote sellado
-- abierto es terminal.
-- ─────────────────────────────────────────────────────────────────────

-- 67 ─ Toda FK entre dos tablas con tenant_id verifica el tenant. Para
-- cada FK, su columna de referencia (la primera) tiene que estar en una FK
-- de la misma tabla, al mismo destino, que incluya tenant_id. Así pasan
-- las `(product_id, kind)` de las tablas de detalle, que tienen al lado su
-- `(product_id, tenant_id)`. Una FK nueva de una sola columna lo rompe.
-- El conteo mínimo evita que pase porque la consulta no encuentra nada.
SELECT pg_temp.expect_true(67,
  'Toda FK entre tablas con tenant_id incluye tenant_id',
  NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_attribute ct ON ct.attrelid = c.conrelid  AND ct.attname = 'tenant_id'
      JOIN pg_attribute tt ON tt.attrelid = c.confrelid AND tt.attname = 'tenant_id'
     WHERE c.contype = 'f'
       AND c.connamespace = 'app'::regnamespace
       AND c.conkey[1] <> ct.attnum
       AND NOT EXISTS (
         SELECT 1 FROM pg_constraint c2
          WHERE c2.contype = 'f'
            AND c2.conrelid = c.conrelid
            AND c2.confrelid = c.confrelid
            AND c.conkey[1] = ANY (c2.conkey)
            AND ct.attnum = ANY (c2.conkey))
  )
  AND (SELECT count(*) FROM pg_constraint c
         JOIN pg_attribute ct ON ct.attrelid = c.conrelid AND ct.attname = 'tenant_id'
        WHERE c.contype = 'f' AND c.connamespace = 'app'::regnamespace
          AND ct.attnum = ANY (c.conkey) AND cardinality(c.conkey) > 1) >= 103);

-- 68 ─ La variante de un movimiento es la de su lote. Fue la puerta del
-- bloqueante de B09. Sobre el granel (no sellado, así el guard de RN-LOT-03
-- no interviene), con la uom del lote y otra variante del mismo tenant:
-- lo único que puede rechazarlo es la FK compuesta lote+variante.
SELECT pg_temp.expect_fail_like(68, 'Movimiento que declara una variante distinta de la de su lote',
  $$INSERT INTO app.inventory_movements
      (tenant_id, lot_id, variant_id, qty, uom, movement_type)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '99999999-0000-0000-0000-000000000002',
            '55555555-0000-0000-0000-00000000a001', 1, 'ml', 'adjustment')$$,
  '%inventory_movements_lot_id_fkey%');

-- 69 y 70 ─ RN-LOT-03 extendida: un lote sellado abierto no admite NINGÚN
-- movimiento. Hasta 0023 solo rechazaba `sale`; un `waste` o un
-- `adjustment` sacaban frascos sellados de un lote abierto con saldo
-- (pregunta de la revisión de B09, decidida por José). Desde WP-C11 un
-- sellado abierto es de una sola unidad (el 79): el lote de este test tiene
-- una, y conserva su saldo porque el UPDATE de estado se hace sin la salida
-- de la unidad que haría la apertura.
SELECT pg_temp.expect_fail_like(69, 'waste sobre un lote sellado abierto con saldo',
  $$DO $x$
    BEGIN
      INSERT INTO app.inventory_lots
        (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
         fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
      VALUES ('99999999-0000-0000-0000-000000000069', '11111111-1111-1111-1111-111111111111',
              '55555555-0000-0000-0000-000000000001', 1, 'unit', 0, 'PYG', 1, 0, 0);
      INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
      VALUES ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000069',
              '55555555-0000-0000-0000-000000000001', 1, 'unit', 'purchase_receipt');
      UPDATE app.inventory_lots SET status = 'open_for_decant'
       WHERE id = '99999999-0000-0000-0000-000000000069';
      INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
      VALUES ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000069',
              '55555555-0000-0000-0000-000000000001', -1, 'unit', 'waste');
    END $x$
  $$,
  'El lote 99999999-0000-0000-0000-000000000069 está abierto para decantar: un sellado abierto no admite movimientos');

SELECT pg_temp.expect_fail_like(70, 'adjustment positivo sobre un lote sellado abierto',
  $$INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
    VALUES ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000001',
            '55555555-0000-0000-0000-000000000001', 1, 'unit', 'adjustment')$$,
  'El lote 99999999-0000-0000-0000-000000000001 está abierto para decantar: un sellado abierto no admite movimientos');

-- 71 ─ Un lote sellado abierto es terminal: volverlo a `available` es la
-- vía para eludir 69/70 (y abrir dos veces el mismo frasco, caso borde 5).
SELECT pg_temp.expect_fail_like(71, 'Lote sellado abierto vuelve a available',
  $$UPDATE app.inventory_lots SET status = 'available'
     WHERE id = '99999999-0000-0000-0000-000000000001'$$,
  'El lote 99999999-0000-0000-0000-000000000001 es un sellado abierto para decantar: su estado es terminal');

-- 72 ─ Control positivo: el granel hijo también está en `open_for_decant`
-- pero no es sellado. Se sigue moviendo y puede agotarse (RN-LOT-04).
SELECT pg_temp.expect_fail_like(72, 'El granel abierto se mueve y se agota',
  $$DO $x$
    BEGIN
      INSERT INTO app.inventory_movements (tenant_id, lot_id, variant_id, qty, uom, movement_type)
      VALUES ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000002',
              '55555555-0000-0000-0000-000000000002', -0.5, 'ml', 'waste');
      UPDATE app.inventory_lots SET status = 'depleted'
       WHERE id = '99999999-0000-0000-0000-000000000002';
      RAISE EXCEPTION 'aceptado';
    END $x$
  $$,
  'aceptado');

-- 73 ─ El caso de la revisión de B09: un lote propio que apunta a una
-- variante de otro tenant. Hasta 0023 se creaba igual.
SELECT pg_temp.expect_fail_like(73, 'Lote con la variante de otro tenant',
  $$DO $x$
    BEGIN
      INSERT INTO app.tenants (id, slug, legal_name, trade_name)
      VALUES ('73737373-0000-0000-0000-000000000073', 'tenant-inv-73', 'Inv 73 SA', 'Inv 73');
      INSERT INTO app.inventory_lots
        (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
         fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
      VALUES ('99999999-0000-0000-0000-000000000073', '73737373-0000-0000-0000-000000000073',
              '55555555-0000-0000-0000-000000000001', 1, 'unit', 0, 'PYG', 1, 0, 0);
    END $x$
  $$,
  '%inventory_lots_variant_id_fkey%');

-- ─────────────────────────────────────────────────────────────────────
-- WP-B09b (0024_revoke_balances_write.sql): la API no escribe la
-- proyección de saldos.
-- ─────────────────────────────────────────────────────────────────────

-- 74 ─ joda_api no tiene INSERT, UPDATE ni DELETE sobre inventory_balances,
-- y sí SELECT. La proyección la escriben solo los triggers SECURITY
-- DEFINER; un saldo se corrige con un movimiento de ajuste.
SELECT pg_temp.expect_true(74,
  'joda_api solo lee inventory_balances',
  has_table_privilege('joda_api', 'app.inventory_balances', 'SELECT')
  AND NOT has_table_privilege('joda_api', 'app.inventory_balances', 'INSERT')
  AND NOT has_table_privilege('joda_api', 'app.inventory_balances', 'UPDATE')
  AND NOT has_table_privilege('joda_api', 'app.inventory_balances', 'DELETE'));

-- ─────────────────────────────────────────────────────────────────────
-- WP-B14b (0025_single_reversal.sql): un asiento se revierte una sola vez.
-- ─────────────────────────────────────────────────────────────────────

-- 75 ─ Una segunda reversión contabilizada del mismo asiento se rechaza.
-- Hasta 0025 pasaba, y v_trial_balance sobre-revertía el saldo (H2 de la
-- revisión de B12).
SELECT pg_temp.expect_fail_like(75, 'Segunda reversión contabilizada del mismo asiento',
  $$DO $x$
    BEGIN
      PERFORM pg_temp.post_test_entry('f0000000-0000-0000-0000-000000000750', 750);
      PERFORM pg_temp.post_test_entry('f0000000-0000-0000-0000-000000000751', 751,
                                      'f0000000-0000-0000-0000-000000000750');
      PERFORM pg_temp.post_test_entry('f0000000-0000-0000-0000-000000000752', 752,
                                      'f0000000-0000-0000-0000-000000000750');
    END $x$
  $$,
  '%journal_entries_single_reversal%');

-- 76 ─ Control positivo: dos BORRADORES de reversión del mismo asiento
-- conviven (no impactan el balance), el primero se contabiliza, y el
-- original pasa a reversed.
SELECT pg_temp.expect_fail_like(76, 'Dos borradores de reversión conviven; uno se contabiliza',
  $$DO $x$
    BEGIN
      PERFORM pg_temp.post_test_entry('f0000000-0000-0000-0000-000000000760', 760);
      INSERT INTO app.journal_entries
        (id, tenant_id, period_id, entry_no, entry_date, status, memo, reverses_id)
      VALUES ('f0000000-0000-0000-0000-000000000761', '11111111-1111-1111-1111-111111111111',
              'ffffffff-0000-0000-0000-000000000001', 761, current_date, 'draft',
              'Borrador de reversión que sobra', 'f0000000-0000-0000-0000-000000000760');
      PERFORM pg_temp.post_test_entry('f0000000-0000-0000-0000-000000000762', 762,
                                      'f0000000-0000-0000-0000-000000000760');
      UPDATE app.journal_entries SET status = 'reversed'
       WHERE id = 'f0000000-0000-0000-0000-000000000760';
      RAISE EXCEPTION 'aceptado';
    END $x$
  $$,
  'aceptado');

-- ─────────────────────────────────────────────────────────────────────
-- 0026_public_usage_readonly.sql y scripts/lib/tasks.mjs: el esquema
-- public conserva USAGE después de un db:reset.
-- ─────────────────────────────────────────────────────────────────────

-- 77 ─ joda_readonly (storefront) y joda_api tienen USAGE sobre public.
-- CI corre db:reset antes de db:test, así que esto también vigila el
-- reset: si vuelve a recrear public sin el default, joda_api lo pierde.
SELECT pg_temp.expect_true(77,
  'joda_readonly y joda_api tienen USAGE sobre el esquema public',
  has_schema_privilege('joda_readonly', 'public', 'USAGE')
  AND has_schema_privilege('joda_api', 'public', 'USAGE'));

-- ─────────────────────────────────────────────────────────────────────
-- WP-B16 (0027_revoke_views_write.sql): la API no escribe a través de una
-- vista ni lee una vista materializada.
-- ─────────────────────────────────────────────────────────────────────

-- 78 ─ joda_api no escribe ninguna vista de app.* ni lee ninguna vista
-- materializada de app.*. El ALTER DEFAULT PRIVILEGES de 0010 no distingue
-- vistas de tablas: toda vista o materializada nueva nace con INSERT,
-- UPDATE, DELETE y SELECT para joda_api, y esta prueba es lo que obliga a
-- la migración que la crea a revocar lo que sobra.
--   · Vistas: la ESCRITURA. Hoy es inocuo (ninguna es actualizable); una
--     vista simple sobre inventory_balances reabriría B09b.
--   · Materializadas: la LECTURA. RLS no se aplica a una vista
--     materializada, así que una legible por joda_api muestra las filas de
--     todos los tenants. No admiten escritura, por eso solo se mira SELECT.
-- El alcance es app porque ahí aplica el default de 0010: las vistas de
-- public no lo reciben (joda_readonly las lee, joda_api no tiene nada).
-- Mira el estado real de los privilegios, no el default: no se esquiva
-- cambiando el rol que crea la vista. has_any_column_privilege ve también
-- el privilegio por columna, que has_table_privilege no ve; DELETE no
-- existe por columna, así que usa has_table_privilege. Si falla, el nombre
-- lista las culpables. La condición EXISTS impide pasar en vacío si
-- dejara de haber vistas en app.
WITH v AS (
  SELECT c.oid, c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app' AND c.relkind IN ('v', 'm')
), con_acceso AS (
  SELECT relname || CASE relkind WHEN 'v' THEN ' (escritura)' ELSE ' (lectura)' END AS descripcion
    FROM v
   WHERE (relkind = 'v'
          AND (has_any_column_privilege('joda_api', oid, 'INSERT')
               OR has_any_column_privilege('joda_api', oid, 'UPDATE')
               OR has_table_privilege('joda_api', oid, 'DELETE')))
      OR (relkind = 'm' AND has_any_column_privilege('joda_api', oid, 'SELECT'))
)
SELECT pg_temp.expect_true(78,
  'joda_api no escribe ninguna vista de app.* ni lee ninguna vista materializada'
    || COALESCE(' — con acceso: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM con_acceso), ''),
  EXISTS (SELECT 1 FROM v WHERE relkind = 'v') AND NOT EXISTS (SELECT 1 FROM con_acceso));

-- WP-C11 (0028_sealed_open_single_unit.sql): apertura de frasco. Un
-- sellado abierto es de una sola unidad, y un producto tiene un solo
-- granel.
-- ─────────────────────────────────────────────────────────────────────

-- 79 ─ Un lote sellado de varias unidades no pasa a `open_for_decant`.
-- Es el caso borde 21: marcarlo abierto entero dejaba los otros frascos
-- cerrados sin poder venderse (RN-LOT-03) y el granel heredaba el costo del
-- lote entero, no el de un frasco. La apertura separa primero la unidad.
SELECT pg_temp.expect_fail_like(79, 'Lote sellado de tres unidades pasa a open_for_decant',
  $$DO $x$
    BEGIN
      INSERT INTO app.inventory_lots
        (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
         fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
      VALUES ('99999999-0000-0000-0000-000000000078', '11111111-1111-1111-1111-111111111111',
              '55555555-0000-0000-0000-000000000001', 3, 'unit', 0, 'PYG', 1, 0, 0);
      UPDATE app.inventory_lots SET status = 'open_for_decant'
       WHERE id = '99999999-0000-0000-0000-000000000078';
    END $x$
  $$,
  'El lote 99999999-0000-0000-0000-000000000078 es un sellado abierto de %');

-- 80 ─ Tampoco nace abierto con varias unidades: el INSERT directo con el
-- estado ya en `open_for_decant` es la otra vía.
SELECT pg_temp.expect_fail_like(80, 'Lote sellado de tres unidades nace en open_for_decant',
  $$INSERT INTO app.inventory_lots
      (id, tenant_id, variant_id, status, qty_initial, uom, unit_cost_minor, currency,
       fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
    VALUES ('99999999-0000-0000-0000-000000000079', '11111111-1111-1111-1111-111111111111',
            '55555555-0000-0000-0000-000000000001', 'open_for_decant', 3, 'unit', 0,
            'PYG', 1, 0, 0)$$,
  'El lote 99999999-0000-0000-0000-000000000079 es un sellado abierto de %');

-- 81 ─ Y un sellado ya abierto no crece: cambiar `qty_initial` del lote de
-- la apertura del smoke (una unidad) a tres lo dejaría abierto de varias.
SELECT pg_temp.expect_fail_like(81, 'Un sellado abierto pasa de una unidad a tres',
  $$UPDATE app.inventory_lots SET qty_initial = 3
     WHERE id = '99999999-0000-0000-0000-000000000001'$$,
  'El lote 99999999-0000-0000-0000-000000000001 es un sellado abierto de %');

-- 82 ─ Control positivo: un sellado de UNA unidad se abre, y el granel hijo
-- de 125 ml también está en `open_for_decant` sin ser sellado. Es lo que
-- hace la apertura de WP-C11 (RN-LOT-02); si esto se rechazara, el
-- invariante rompería el caso feliz.
SELECT pg_temp.expect_fail_like(82, 'Un sellado de una unidad se abre, y su granel también',
  $$DO $x$
    BEGIN
      INSERT INTO app.inventory_lots
        (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
         fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
      VALUES ('99999999-0000-0000-0000-000000000081', '11111111-1111-1111-1111-111111111111',
              '55555555-0000-0000-0000-000000000001', 1, 'unit', 0, 'PYG', 1, 0, 0);
      UPDATE app.inventory_lots SET status = 'open_for_decant'
       WHERE id = '99999999-0000-0000-0000-000000000081';
      INSERT INTO app.inventory_lots
        (id, tenant_id, variant_id, parent_lot_id, status, qty_initial, uom, unit_cost_minor,
         currency, fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
      VALUES ('99999999-0000-0000-0000-000000000082', '11111111-1111-1111-1111-111111111111',
              '55555555-0000-0000-0000-000000000002', '99999999-0000-0000-0000-000000000081',
              'open_for_decant', 125, 'ml', 0, 'PYG', 1, 0, 0);
      RAISE EXCEPTION 'aceptado';
    END $x$
  $$,
  'aceptado');

-- 83 ─ Falla cerrado: si no encuentra la variante del lote en su tenant,
-- rechaza, en vez de no poder decidir y dejar pasar (docs/data-model.md
-- §4.2). El lote con la variante de OTRO tenant se fabrica con los
-- triggers y las FKs deshabilitados (desde 0023 la FK compuesta ya no lo
-- deja crear, como en el 39) y se vuelven a habilitar antes del UPDATE.
SELECT pg_temp.expect_fail_like(83, 'Abrir un lote cuya variante es de otro tenant',
  $$DO $x$
    BEGIN
      INSERT INTO app.tenants (id, slug, legal_name, trade_name)
      VALUES ('82828282-0000-0000-0000-000000000082', 'tenant-inv-82', 'Inv 82 SA', 'Inv 82');
      INSERT INTO app.products (id, tenant_id, kind, slug, name, status)
      VALUES ('82828282-0000-0000-0000-0000000000a1',
              '82828282-0000-0000-0000-000000000082', 'accessory', 'inv-82', 'Inv 82', 'draft');
      INSERT INTO app.product_variants
        (id, tenant_id, product_id, sku, variant_type, uom, size_ml, price_pyg)
      VALUES ('82828282-0000-0000-0000-0000000000b1',
              '82828282-0000-0000-0000-000000000082',
              '82828282-0000-0000-0000-0000000000a1', 'INV-82', 'sealed', 'unit', 100, 0);
      ALTER TABLE app.inventory_lots DISABLE TRIGGER ALL;
      INSERT INTO app.inventory_lots
        (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
         fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
      VALUES ('99999999-0000-0000-0000-000000000083',
              '11111111-1111-1111-1111-111111111111',
              '82828282-0000-0000-0000-0000000000b1', 1, 'unit', 0, 'PYG', 1, 0, 0);
      ALTER TABLE app.inventory_lots ENABLE TRIGGER ALL;
      UPDATE app.inventory_lots SET status = 'open_for_decant'
       WHERE id = '99999999-0000-0000-0000-000000000083';
    END $x$
  $$,
  'Variante del lote 99999999-0000-0000-0000-000000000083 no encontrada en su tenant%');

-- 84 ─ Un producto es un solo líquido: una segunda variante de granel del
-- mismo producto se rechaza. La apertura necesita saber a qué granel va el
-- frasco, y lo impone la base, no la búsqueda.
SELECT pg_temp.expect_fail_like(84, 'Segunda variante de granel del mismo producto',
  $$INSERT INTO app.product_variants
      (tenant_id, product_id, sku, variant_type, uom, price_pyg)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '44444444-4444-4444-4444-444444444444', 'LAY-BULK-2', 'bulk', 'ml', 0)$$,
  '%product_variants_one_bulk_per_product%');

-- 85 ─ Control positivo del 84: otro producto sí puede tener su propio
-- granel. El índice es por producto, no global.
SELECT pg_temp.expect_fail_like(85, 'Otro producto tiene su propia variante de granel',
  $$DO $x$
    BEGIN
      INSERT INTO app.product_variants
        (tenant_id, product_id, sku, variant_type, uom, price_pyg)
      VALUES ('11111111-1111-1111-1111-111111111111',
              '44444444-0000-0000-0000-00000000aaaa', 'INSUMOS-BULK', 'bulk', 'ml', 0);
      RAISE EXCEPTION 'aceptado';
    END $x$
  $$,
  'aceptado');


-- ─────────────────────────────────────────────────────────────────────
-- WP-C12 (0029_serialized_unit_lot_variant.sql): la variante de una unidad
-- serializada es la de su lote, y el serial es único por tenant.
-- ─────────────────────────────────────────────────────────────────────

-- 86 ─ Una unidad serializada no puede declarar otra variante que la de su
-- lote. Mismo defecto que el 68 para los movimientos: la variante la
-- declaraba quien inserta, y la unidad quedaba asociada al costo y al
-- saldo de un lote de otra variante. Lo único que puede rechazarlo es la
-- FK compuesta lote+variante.
SELECT pg_temp.expect_fail_like(86, 'Unidad serializada con una variante distinta de la de su lote',
  $$INSERT INTO app.serialized_units (tenant_id, variant_id, lot_id, serial_number)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '55555555-0000-0000-0000-00000000a001',
            '99999999-0000-0000-0000-000000000001', 'SN-INV-85')$$,
  '%serialized_units_lot_id_fkey%');

-- 87 ─ Control positivo del 86: con la variante de su lote, y sin lote
-- (una unidad puede existir sin lote: MATCH SIMPLE no verifica nada con
-- `lot_id` NULL), la unidad se acepta.
SELECT pg_temp.expect_fail_like(87, 'Unidad serializada con la variante de su lote, y otra sin lote',
  $$DO $x$
    BEGIN
      INSERT INTO app.serialized_units (tenant_id, variant_id, lot_id, serial_number)
      VALUES ('11111111-1111-1111-1111-111111111111',
              '55555555-0000-0000-0000-00000000a001',
              '99999999-0000-0000-0000-0000000000a1', 'SN-INV-86'),
             ('11111111-1111-1111-1111-111111111111',
              '55555555-0000-0000-0000-00000000a001', NULL, 'SN-INV-86-SIN-LOTE');
      RAISE EXCEPTION 'aceptado';
    END $x$
  $$,
  'aceptado');

-- 88 ─ Un lote con unidades serializadas no cambia de variante: sin esto,
-- el 86 se eludía cambiando la variante del lote DESPUÉS de crear la
-- unidad. El lote es nuevo y sin movimientos, así que la FK de los
-- movimientos (0023) no interviene: la única barrera es la de la unidad.
SELECT pg_temp.expect_fail_like(88, 'Un lote con unidades serializadas cambia de variante',
  $$DO $x$
    BEGIN
      INSERT INTO app.inventory_lots
        (id, tenant_id, variant_id, qty_initial, uom, unit_cost_minor, currency,
         fx_rate_to_pyg, landed_cost_pyg, unit_landed_cost_pyg)
      VALUES ('99999999-0000-0000-0000-000000000087', '11111111-1111-1111-1111-111111111111',
              '55555555-0000-0000-0000-00000000a001', 1, 'unit', 0, 'PYG', 1, 0, 0);
      INSERT INTO app.serialized_units (tenant_id, variant_id, lot_id, serial_number)
      VALUES ('11111111-1111-1111-1111-111111111111',
              '55555555-0000-0000-0000-00000000a001',
              '99999999-0000-0000-0000-000000000087', 'SN-INV-87');
      UPDATE app.inventory_lots SET variant_id = '55555555-0000-0000-0000-00000000a002'
       WHERE id = '99999999-0000-0000-0000-000000000087';
    END $x$
  $$,
  '%serialized_units_lot_id_fkey%');

-- 89 ─ RN-SER-01: el número de serie es único por tenant.
SELECT pg_temp.expect_fail_like(89, 'Dos unidades con el mismo número de serie en el mismo tenant',
  $$INSERT INTO app.serialized_units (tenant_id, variant_id, serial_number)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '55555555-0000-0000-0000-00000000a001', 'SN-INV-88'),
           ('11111111-1111-1111-1111-111111111111',
            '55555555-0000-0000-0000-00000000a001', 'SN-INV-88')$$,
  '%serialized_units_tenant_id_serial_number_key%');

-- 90 ─ Control positivo del 89: el mismo número de serie en OTRO tenant se
-- acepta. La unicidad es por tenant, no global: dos negocios distintos
-- pueden vender un reloj con el mismo serial sin chocar entre sí.
SELECT pg_temp.expect_fail_like(90, 'El mismo número de serie en dos tenants distintos',
  $$DO $x$
    BEGIN
      INSERT INTO app.tenants (id, slug, legal_name, trade_name)
      VALUES ('89898989-0000-0000-0000-000000000089', 'tenant-inv-89', 'Inv 89 SA', 'Inv 89');
      INSERT INTO app.products (id, tenant_id, kind, slug, name, status)
      VALUES ('89898989-0000-0000-0000-0000000000a1',
              '89898989-0000-0000-0000-000000000089', 'accessory', 'inv-89', 'Inv 89', 'draft');
      INSERT INTO app.product_variants (id, tenant_id, product_id, sku, variant_type, uom, price_pyg)
      VALUES ('89898989-0000-0000-0000-0000000000b1',
              '89898989-0000-0000-0000-000000000089',
              '89898989-0000-0000-0000-0000000000a1', 'INV-89', 'unit', 'unit', 0);
      INSERT INTO app.serialized_units (tenant_id, variant_id, serial_number)
      VALUES ('11111111-1111-1111-1111-111111111111',
              '55555555-0000-0000-0000-00000000a001', 'SN-INV-89'),
             ('89898989-0000-0000-0000-000000000089',
              '89898989-0000-0000-0000-0000000000b1', 'SN-INV-89');
      RAISE EXCEPTION 'aceptado';
    END $x$
  $$,
  'aceptado');

-- WP-B11 (0030_write_permissions_sensitive_tables.sql): escribir en
-- suppliers, purchase_orders, inventory_lots, chart_of_accounts y
-- customer_deposits exige el permiso de escritura, no solo tenant.
-- Propiedades del catálogo y de la matriz sembrada; el comportamiento, con
-- cada rol conectado como joda_api, lo prueba write_permissions.test.ts.
--
-- WP-B11b (0032_write_permissions_sourcing_scenarios.sql) suma
-- sourcing_scenarios y su tabla hija sourcing_scenario_lines a los
-- invariantes 91 a 94, con una diferencia en el 93: esas dos tablas SÍ se
-- borran, con `market.sourcing:write`. Y el 91 exige además que la LECTURA de
-- las líneas pida `market.sourcing:read`: traen precios de proveedor.
-- ─────────────────────────────────────────────────────────────────────

-- Los invariantes 91 a 93 leen el TEXTO de las políticas (pg_get_expr): no
-- pueden probar que la política haga lo que dice, solo que no se la reemplazó
-- por una que ni lo intenta. Que lo haga lo prueba, con cada rol conectado
-- como joda_api, write_permissions.test.ts.

-- 91 ─ Toda política permisiva de escritura (INSERT, UPDATE, DELETE o ALL)
-- de esas siete tablas exige un permiso, y cada una tiene las de INSERT y
-- UPDATE. Con la `tenant_access_*` con `true` de 0016 la escritura vuelve a
-- pedir solo tenant; un `true OR has_permission(..)` tampoco cuenta como
-- exigir un permiso. Y la política de SELECT de las líneas de escenarios de
-- sourcing exige `market.sourcing:read` (WP-B11b). El nombre lista las
-- políticas culpables y las tablas a las que les falta la de INSERT o la de
-- UPDATE.
WITH sensibles(tabla) AS (
  VALUES ('suppliers'), ('purchase_orders'), ('inventory_lots'),
         ('chart_of_accounts'), ('customer_deposits'), ('sourcing_scenarios'),
         ('sourcing_scenario_lines')
), politicas AS (
  SELECT c.relname AS tabla, p.polname, p.polcmd,
         COALESCE(pg_get_expr(p.polqual, p.polrelid), '')
           || ' ' || COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '') AS expresion
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN sensibles s ON s.tabla = c.relname
   WHERE n.nspname = 'app' AND p.polpermissive AND p.polcmd IN ('a', 'w', 'd', '*')
), sin_permiso AS (
  SELECT tabla || '.' || polname AS descripcion
    FROM politicas
   WHERE expresion NOT LIKE '%has_permission(%' OR expresion ~ '\mtrue\M'
), falta AS (
  SELECT s.tabla || CASE c.cmd WHEN 'a' THEN ' (INSERT)' ELSE ' (UPDATE)' END AS descripcion
    FROM sensibles s
   CROSS JOIN (VALUES ('a'::"char"), ('w'::"char")) AS c(cmd)
   WHERE NOT EXISTS (SELECT 1 FROM politicas p WHERE p.tabla = s.tabla AND p.polcmd = c.cmd)
), lectura_lineas AS (
  SELECT p.polname, pg_get_expr(p.polqual, p.polrelid) AS expresion
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app' AND c.relname = 'sourcing_scenario_lines'
     AND p.polpermissive AND p.polcmd = 'r'
), lectura_sin_permiso AS (
  SELECT 'sourcing_scenario_lines.' || polname AS descripcion
    FROM lectura_lineas
   WHERE expresion NOT LIKE '%has_permission(''market.sourcing:read''%'
  UNION ALL
  SELECT 'sourcing_scenario_lines (sin política de SELECT)'
   WHERE NOT EXISTS (SELECT 1 FROM lectura_lineas)
)
SELECT pg_temp.expect_true(91,
  'Escribir en las tablas sensibles exige un permiso, no solo tenant; leer las líneas de sourcing, también'
    || COALESCE(' — sin permiso: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM sin_permiso), '')
    || COALESCE(' — sin política: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM falta), '')
    || COALESCE(' — lectura sin permiso: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM lectura_sin_permiso), ''),
  NOT EXISTS (SELECT 1 FROM sin_permiso) AND NOT EXISTS (SELECT 1 FROM falta)
  AND NOT EXISTS (SELECT 1 FROM lectura_sin_permiso));

-- 92 ─ Ninguna política permisiva de esas tablas es FOR ALL. Un FOR ALL
-- también cubre SELECT: quien puede escribir leería la tabla entera aunque
-- no tenga el permiso de leer, y con él se abre la lectura de costos y
-- proveedores. Una política por comando. El nombre lista las culpables.
WITH for_all AS (
  SELECT c.relname || '.' || p.polname AS descripcion
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app'
     AND c.relname IN ('suppliers', 'purchase_orders', 'inventory_lots',
                       'chart_of_accounts', 'customer_deposits', 'sourcing_scenarios',
                       'sourcing_scenario_lines')
     AND p.polpermissive
     AND p.polcmd = '*'
)
SELECT pg_temp.expect_true(92,
  'Ninguna política de permiso de las tablas sensibles es FOR ALL'
    || COALESCE(' — FOR ALL: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM for_all), ''),
  NOT EXISTS (SELECT 1 FROM for_all));

-- 93 ─ Nadie borra lotes, señas, cuentas ni proveedores: sin política
-- permisiva de DELETE. En purchase_orders hay una sola, con
-- `market.purchase_order:write` Y el estado `draft` dentro de la política:
-- el DELETE directo de una orden enviada no pasa aunque quien lo intenta
-- tenga el permiso. Que `draft` signifique "nunca enviada" lo sostiene el
-- trigger de 0031 (invariantes 95-103), no esta política. En
-- sourcing_scenarios y sourcing_scenario_lines (WP-B11b) hay también una sola
-- por tabla, con `market.sourcing:write` y sin más condición: un escenario
-- es una simulación y se borra. El nombre lista las políticas de DELETE que
-- sobran, o avisa que la de órdenes o la de sourcing no es la esperada.
WITH borrado AS (
  SELECT c.relname AS tabla, p.polname,
         COALESCE(pg_get_expr(p.polqual, p.polrelid), '') AS expresion
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app'
     AND c.relname IN ('suppliers', 'purchase_orders', 'inventory_lots',
                       'chart_of_accounts', 'customer_deposits', 'sourcing_scenarios',
                       'sourcing_scenario_lines')
     AND p.polpermissive
     AND p.polcmd IN ('d', '*')
), sobran AS (
  SELECT tabla || '.' || polname AS descripcion
    FROM borrado
   WHERE tabla NOT IN ('purchase_orders', 'sourcing_scenarios', 'sourcing_scenario_lines')
), orden_ok AS (
  SELECT count(*) AS n
    FROM borrado
   WHERE tabla = 'purchase_orders'
     AND expresion LIKE '%market.purchase_order:write%'
     AND expresion LIKE '%(status = ''draft''%'
     AND expresion NOT LIKE '% OR %'
), sourcing_ok AS (
  SELECT count(DISTINCT tabla) AS n
    FROM borrado
   WHERE tabla IN ('sourcing_scenarios', 'sourcing_scenario_lines')
     AND expresion LIKE '%market.sourcing:write%'
     AND expresion NOT LIKE '% OR %'
     AND expresion NOT LIKE '% AND %'
)
SELECT pg_temp.expect_true(93,
  'Sin DELETE en lotes, señas, cuentas y proveedores; en órdenes de compra, solo borradores; en escenarios de sourcing y sus líneas, con su permiso'
    || COALESCE(' — DELETE que sobra: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM sobran), '')
    || CASE WHEN (SELECT n FROM orden_ok) = 1
             AND (SELECT count(*) FROM borrado WHERE tabla = 'purchase_orders') = 1
            THEN '' ELSE ' — la política de DELETE de purchase_orders no es la esperada' END
    || CASE WHEN (SELECT n FROM sourcing_ok) = 2
             AND (SELECT count(*) FROM borrado WHERE tabla LIKE 'sourcing_scenario%') = 2
            THEN '' ELSE ' — la política de DELETE de sourcing_scenarios o de sus líneas no es la esperada' END,
  NOT EXISTS (SELECT 1 FROM sobran)
  AND (SELECT n FROM orden_ok) = 1
  AND (SELECT count(*) FROM borrado WHERE tabla = 'purchase_orders') = 1
  AND (SELECT n FROM sourcing_ok) = 2
  AND (SELECT count(*) FROM borrado WHERE tabla LIKE 'sourcing_scenario%') = 2);

-- 94 ─ En los roles sembrados (`is_system`, de cualquier tenant), todo
-- permiso de escritura de esas tablas viene con el de lectura de la MISMA
-- tabla. Con RLS, INSERT ... RETURNING y los UPDATE o DELETE que leen
-- columnas evalúan también la política de lectura: un rol que escribe sin
-- leer recibe 42501 en el INSERT de Prisma y cero filas en el UPDATE, sin un
-- error que explique por qué (el vendedor, que registra señas con
-- accounting.deposit:write y no tenía :read). Única excepción, registrada
-- para WP-C15: depósito recibe (market.purchase_order:receive) sin leer
-- órdenes de compra; carga la recepción en borrador y la contabiliza quien
-- las lee. Si C15 la resuelve, se quita de acá. Los roles que crea un
-- administrador no entran: validar el par al crearlos es de WP-C24.
-- Las filas de `roles`, `role_permissions` y `staff_user_roles` (WP-B11c) no
-- responden a la trampa: su SELECT es por tenant, porque la API lo lee para
-- resolver los permisos de cada sesión. El par existe porque quien administra
-- usuarios y roles tiene que ver la pantalla que los lista. Las de
-- `purchase_order_lines` (WP-B11d) sí: su lectura exige
-- `market.purchase_order:read`, con la misma excepción del depósito.
WITH par(tabla, escribe, lee) AS (
  VALUES
    ('suppliers',         'market.supplier:write',         'market.supplier:read'),
    ('purchase_orders',   'market.purchase_order:write',   'market.purchase_order:read'),
    ('purchase_orders',   'market.purchase_order:approve', 'market.purchase_order:read'),
    ('purchase_orders',   'market.purchase_order:receive', 'market.purchase_order:read'),
    ('inventory_lots',    'market.purchase_order:receive', 'inventory.stock:read'),
    ('inventory_lots',    'inventory.decant:execute',      'inventory.stock:read'),
    ('inventory_lots',    'sales.order:refund',            'inventory.stock:read'),
    ('inventory_lots',    'inventory.stock:adjust',        'inventory.stock:read'),
    ('chart_of_accounts', 'accounting.journal:write',      'accounting.journal:read'),
    ('customer_deposits', 'accounting.deposit:write',      'accounting.deposit:read'),
    ('sourcing_scenarios', 'market.sourcing:write',         'market.sourcing:read'),
    ('sourcing_scenario_lines', 'market.sourcing:write',    'market.sourcing:read'),
    ('roles',              'settings.user:write',           'settings.user:read'),
    ('role_permissions',   'settings.user:write',           'settings.user:read'),
    ('staff_user_roles',   'settings.user:write',           'settings.user:read'),
    ('purchase_order_lines', 'market.purchase_order:write',   'market.purchase_order:read'),
    ('purchase_order_lines', 'market.purchase_order:approve', 'market.purchase_order:read'),
    ('purchase_order_lines', 'market.purchase_order:receive', 'market.purchase_order:read')
), roles_sembrados AS (
  SELECT id, code, tenant_id FROM app.roles WHERE is_system
), escribe_sin_leer AS (
  SELECT r.code || ' (' || left(r.tenant_id::text, 8) || ') → ' || p.tabla
           || ' (' || p.escribe || ')' AS descripcion
    FROM roles_sembrados r
    JOIN app.role_permissions w ON w.role_id = r.id
    JOIN par p ON p.escribe = w.permission_code
   WHERE NOT EXISTS (SELECT 1 FROM app.role_permissions l
                      WHERE l.role_id = r.id AND l.permission_code = p.lee)
     AND NOT (r.code = 'deposito'
              AND p.tabla IN ('purchase_orders', 'purchase_order_lines')
              AND p.escribe = 'market.purchase_order:receive')
)
SELECT pg_temp.expect_true(94,
  'Ningún rol sembrado escribe en una tabla sensible sin poder leerla (salvo depósito en órdenes y sus líneas, WP-C15)'
    || COALESCE(' — escriben sin leer: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM escribe_sin_leer), ''),
  (SELECT count(*) FROM roles_sembrados) >= 4 AND NOT EXISTS (SELECT 1 FROM escribe_sin_leer));


-- WP-B11 (0031_purchase_order_no_return_to_draft.sql, ADR-026): una orden de
-- compra no vuelve a `draft` ni a `pending_approval` desde `approved` en
-- adelante. La política de DELETE de 0030 lee `status = 'draft'` como "nunca
-- enviada"; sin este guarda, un UPDATE a `draft` y un DELETE la eludían en
-- dos pasos, y pasando antes por `pending_approval`, en tres. Estos nueve
-- prueban el COMPORTAMIENTO del trigger, no el texto de ninguna política.
-- ─────────────────────────────────────────────────────────────────────

-- 95 ─ Una orden `approved` no vuelve a borrador.
SELECT pg_temp.expect_fail_like(95, 'Orden de compra approved vuelve a draft',
  $$DO $x$
    BEGIN
      INSERT INTO app.purchase_orders (id, tenant_id, supplier_id, code, status, currency,
                                       created_by, approved_by, approved_at)
      VALUES ('95959595-0000-0000-0000-000000000095', '11111111-1111-1111-1111-111111111111',
              '66666666-6666-6666-6666-666666666666', 'OC-INV-95', 'approved', 'USD',
              '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', now());
      UPDATE app.purchase_orders SET status = 'draft'
       WHERE id = '95959595-0000-0000-0000-000000000095';
    END $x$
  $$,
  'La orden de compra 95959595-0000-0000-0000-000000000095 está en approved y no puede volver a draft%');

-- 96 ─ Una orden `sent` no vuelve a borrador (el rodeo de la revisión de B11).
SELECT pg_temp.expect_fail_like(96, 'Orden de compra sent vuelve a draft',
  $$DO $x$
    BEGIN
      INSERT INTO app.purchase_orders (id, tenant_id, supplier_id, code, status, currency,
                                       created_by, approved_by, approved_at)
      VALUES ('96969696-0000-0000-0000-000000000096', '11111111-1111-1111-1111-111111111111',
              '66666666-6666-6666-6666-666666666666', 'OC-INV-96', 'sent', 'USD',
              '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', now());
      UPDATE app.purchase_orders SET status = 'draft'
       WHERE id = '96969696-0000-0000-0000-000000000096';
    END $x$
  $$,
  'La orden de compra 96969696-0000-0000-0000-000000000096 está en sent y no puede volver a draft%');

-- 97 ─ Una orden `partially_received` no vuelve a borrador.
SELECT pg_temp.expect_fail_like(97, 'Orden de compra partially_received vuelve a draft',
  $$DO $x$
    BEGIN
      INSERT INTO app.purchase_orders (id, tenant_id, supplier_id, code, status, currency,
                                       created_by, approved_by, approved_at)
      VALUES ('97979797-0000-0000-0000-000000000097', '11111111-1111-1111-1111-111111111111',
              '66666666-6666-6666-6666-666666666666', 'OC-INV-97', 'partially_received', 'USD',
              '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', now());
      UPDATE app.purchase_orders SET status = 'draft'
       WHERE id = '97979797-0000-0000-0000-000000000097';
    END $x$
  $$,
  'La orden de compra 97979797-0000-0000-0000-000000000097 está en partially_received y no puede volver a draft%');

-- 98 ─ Una orden `received` no vuelve a borrador. El terminal sigue siendo
-- del dominio (ADR-026): esto guarda solo la ENTRADA a `draft`.
SELECT pg_temp.expect_fail_like(98, 'Orden de compra received vuelve a draft',
  $$DO $x$
    BEGIN
      INSERT INTO app.purchase_orders (id, tenant_id, supplier_id, code, status, currency,
                                       created_by, approved_by, approved_at)
      VALUES ('98989898-0000-0000-0000-000000000098', '11111111-1111-1111-1111-111111111111',
              '66666666-6666-6666-6666-666666666666', 'OC-INV-98', 'received', 'USD',
              '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', now());
      UPDATE app.purchase_orders SET status = 'draft'
       WHERE id = '98989898-0000-0000-0000-000000000098';
    END $x$
  $$,
  'La orden de compra 98989898-0000-0000-0000-000000000098 está en received y no puede volver a draft%');

-- 99 ─ Una orden `cancelled` no vuelve a borrador.
SELECT pg_temp.expect_fail_like(99, 'Orden de compra cancelled vuelve a draft',
  $$DO $x$
    BEGIN
      INSERT INTO app.purchase_orders (id, tenant_id, supplier_id, code, status, currency, created_by)
      VALUES ('99999999-0000-0000-0000-000000000199', '11111111-1111-1111-1111-111111111111',
              '66666666-6666-6666-6666-666666666666', 'OC-INV-99', 'cancelled', 'USD',
              '22222222-2222-2222-2222-222222222222');
      UPDATE app.purchase_orders SET status = 'draft'
       WHERE id = '99999999-0000-0000-0000-000000000199';
    END $x$
  $$,
  'La orden de compra 99999999-0000-0000-0000-000000000199 está en cancelled y no puede volver a draft%');

-- 100 ─ Control positivo de 95-99: una orden en `pending_approval` SÍ vuelve
-- a borrador (la arista de la máquina de A08: el aprobador la devuelve a
-- corregir), y un borrador se edita sin salir de `draft`. Sin esto, un
-- trigger que rechazara todo `draft` pasaría los cinco anteriores.
SELECT pg_temp.expect_fail_like(100, 'Orden de compra pending_approval vuelve a draft',
  $$DO $x$
    BEGIN
      INSERT INTO app.purchase_orders (id, tenant_id, supplier_id, code, status, currency, created_by)
      VALUES ('10001000-0000-0000-0000-000000000100', '11111111-1111-1111-1111-111111111111',
              '66666666-6666-6666-6666-666666666666', 'OC-INV-100', 'pending_approval', 'USD',
              '22222222-2222-2222-2222-222222222222');
      UPDATE app.purchase_orders SET status = 'draft'
       WHERE id = '10001000-0000-0000-0000-000000000100';
      UPDATE app.purchase_orders SET status = 'draft', notes = 'corregida'
       WHERE id = '10001000-0000-0000-0000-000000000100';
      RAISE EXCEPTION 'aceptado';
    END $x$
  $$,
  'aceptado');


-- 101 ─ Una orden `approved` no vuelve a `pending_approval`. Es el primer
-- paso del rodeo de tres: `approved → pending_approval → draft → DELETE`.
-- Guardar solo la entrada a `draft` lo dejaba abierto: `pending_approval` es
-- el otro estado previo a la aprobación, y desde él se llega a `draft`.
SELECT pg_temp.expect_fail_like(101, 'Orden de compra approved vuelve a pending_approval',
  $$DO $x$
    BEGIN
      INSERT INTO app.purchase_orders (id, tenant_id, supplier_id, code, status, currency,
                                       created_by, approved_by, approved_at)
      VALUES ('10110110-0000-0000-0000-000000000101', '11111111-1111-1111-1111-111111111111',
              '66666666-6666-6666-6666-666666666666', 'OC-INV-101', 'approved', 'USD',
              '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', now());
      UPDATE app.purchase_orders SET status = 'pending_approval'
       WHERE id = '10110110-0000-0000-0000-000000000101';
    END $x$
  $$,
  'La orden de compra 10110110-0000-0000-0000-000000000101 está en approved y no puede volver a pending_approval%');

-- 102 ─ Una orden `sent` no vuelve a `pending_approval`.
SELECT pg_temp.expect_fail_like(102, 'Orden de compra sent vuelve a pending_approval',
  $$DO $x$
    BEGIN
      INSERT INTO app.purchase_orders (id, tenant_id, supplier_id, code, status, currency,
                                       created_by, approved_by, approved_at)
      VALUES ('10210210-0000-0000-0000-000000000102', '11111111-1111-1111-1111-111111111111',
              '66666666-6666-6666-6666-666666666666', 'OC-INV-102', 'sent', 'USD',
              '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', now());
      UPDATE app.purchase_orders SET status = 'pending_approval'
       WHERE id = '10210210-0000-0000-0000-000000000102';
    END $x$
  $$,
  'La orden de compra 10210210-0000-0000-0000-000000000102 está en sent y no puede volver a pending_approval%');

-- 103 ─ Control positivo de 101 y 102: el camino hacia adelante sigue andando.
-- Un borrador pasa a `pending_approval` y de ahí a `approved` (con la
-- constancia de quién aprobó, que exige `po_approved_has_approver`). Sin
-- esto, un trigger que rechazara todo cambio de estado pasaría 95-102.
SELECT pg_temp.expect_fail_like(103, 'Orden de compra draft avanza a pending_approval y a approved',
  $$DO $x$
    BEGIN
      INSERT INTO app.purchase_orders (id, tenant_id, supplier_id, code, status, currency, created_by)
      VALUES ('10310310-0000-0000-0000-000000000103', '11111111-1111-1111-1111-111111111111',
              '66666666-6666-6666-6666-666666666666', 'OC-INV-103', 'draft', 'USD',
              '22222222-2222-2222-2222-222222222222');
      UPDATE app.purchase_orders SET status = 'pending_approval'
       WHERE id = '10310310-0000-0000-0000-000000000103';
      UPDATE app.purchase_orders
         SET status = 'approved',
             approved_by = '22222222-2222-2222-2222-222222222222', approved_at = now()
       WHERE id = '10310310-0000-0000-0000-000000000103';
      RAISE EXCEPTION 'aceptado';
    END $x$
  $$,
  'aceptado');


-- WP-B11c (0033_write_permissions_roles.sql): escribir en `roles`,
-- `role_permissions` y `staff_user_roles` exige `settings.user:write`, y los
-- roles de sistema no se borran ni se renombran, por nadie. El 104 lee el
-- TEXTO de las políticas, con el límite de siempre: no prueba que hagan lo
-- que dicen (eso lo prueba, con cada rol como joda_api,
-- write_permissions.test.ts). Del 105 al 110, el trigger se prueba como
-- superusuario, que elude RLS: ese es el "por nadie".
-- ─────────────────────────────────────────────────────────────────────

-- 104 ─ En esas tres tablas, toda política permisiva de escritura (INSERT,
-- UPDATE, DELETE o ALL) exige `settings.user:write`, hay una por cada uno de
-- los tres comandos, y ninguna es FOR ALL. La lectura, en cambio, NO exige
-- permiso: la API lee `role_permissions` y `staff_user_roles` para resolver
-- los permisos de cada sesión, y el vendedor no tiene `settings.user:read`.
-- Una política de SELECT con `has_permission` rompería el login de todos, y
-- sin ninguna permisiva de lectura las tres tablas quedan vacías para
-- `joda_api`. El nombre lista las culpables.
WITH tablas(tabla) AS (
  VALUES ('roles'), ('role_permissions'), ('staff_user_roles')
), politicas AS (
  SELECT c.relname AS tabla, p.polname, p.polcmd,
         COALESCE(pg_get_expr(p.polqual, p.polrelid), '')
           || ' ' || COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '') AS expresion
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN tablas t ON t.tabla = c.relname
   WHERE n.nspname = 'app' AND p.polpermissive
), sin_permiso AS (
  SELECT tabla || '.' || polname AS descripcion
    FROM politicas
   WHERE polcmd IN ('a', 'w', 'd', '*')
     AND (expresion NOT LIKE '%has_permission(''settings.user:write''%' OR expresion ~ '\mtrue\M')
), for_all AS (
  SELECT tabla || '.' || polname AS descripcion FROM politicas WHERE polcmd = '*'
), falta AS (
  SELECT t.tabla || CASE c.cmd WHEN 'a' THEN ' (INSERT)' WHEN 'w' THEN ' (UPDATE)'
                               ELSE ' (DELETE)' END AS descripcion
    FROM tablas t
   CROSS JOIN (VALUES ('a'::"char"), ('w'::"char"), ('d'::"char")) AS c(cmd)
   WHERE NOT EXISTS (SELECT 1 FROM politicas p WHERE p.tabla = t.tabla AND p.polcmd = c.cmd)
), lectura_cerrada AS (
  SELECT tabla || '.' || polname || ' (SELECT con permiso)' AS descripcion
    FROM politicas
   WHERE polcmd = 'r' AND expresion LIKE '%has_permission(%'
  UNION ALL
  SELECT t.tabla || ' (sin política de SELECT)'
    FROM tablas t
   WHERE NOT EXISTS (SELECT 1 FROM politicas p WHERE p.tabla = t.tabla AND p.polcmd = 'r')
)
SELECT pg_temp.expect_true(104,
  'Escribir roles, role_permissions y staff_user_roles exige settings.user:write; leerlos, solo tenant'
    || COALESCE(' — sin permiso: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM sin_permiso), '')
    || COALESCE(' — FOR ALL: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM for_all), '')
    || COALESCE(' — sin política: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM falta), '')
    || COALESCE(' — lectura: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM lectura_cerrada), ''),
  NOT EXISTS (SELECT 1 FROM sin_permiso) AND NOT EXISTS (SELECT 1 FROM for_all)
  AND NOT EXISTS (SELECT 1 FROM falta) AND NOT EXISTS (SELECT 1 FROM lectura_cerrada));

-- 105 ─ El rol de sistema del dueño no se borra, ni siquiera como
-- superusuario: sin esto, quien pueda borrar roles puede borrar el de dueño.
SELECT pg_temp.expect_fail_like(105, 'Borrar el rol de sistema owner',
  $$DELETE FROM app.roles
     WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND code = 'owner'$$,
  'El rol de sistema "%" (owner) no se puede borrar%');

-- 106 ─ Un rol de sistema no cambia de nombre.
SELECT pg_temp.expect_fail_like(106, 'Renombrar (name) el rol de sistema owner',
  $$UPDATE app.roles SET name = 'Otro nombre'
     WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND code = 'owner'$$,
  'El rol de sistema "%" (owner) no se puede renombrar%');

-- 107 ─ Ni de código: el código es lo que el sistema usa para reconocerlo.
SELECT pg_temp.expect_fail_like(107, 'Renombrar (code) el rol de sistema owner',
  $$UPDATE app.roles SET code = 'otro-codigo'
     WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND code = 'owner'$$,
  'El rol de sistema "%" (owner) no se puede renombrar%');

-- 108 ─ La marca `is_system` no se baja. Sin esto, bajarla y borrar el rol
-- son dos pasos: el mismo rodeo que la revisión de B11 encontró con `draft`.
SELECT pg_temp.expect_fail_like(108, 'Bajar is_system del rol de sistema owner',
  $$UPDATE app.roles SET is_system = false
     WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND code = 'owner'$$,
  'La marca is_system del rol "%" (owner) no se puede cambiar%');

-- 109 ─ Ni se sube: un rol creado después no pasa a ser de sistema.
SELECT pg_temp.expect_fail_like(109, 'Subir is_system de un rol personalizado',
  $$DO $x$
    BEGIN
      INSERT INTO app.roles (id, tenant_id, code, name)
      VALUES ('10910910-0000-0000-0000-000000000109',
              '11111111-1111-1111-1111-111111111111', 'inv-109', 'Rol 109');
      UPDATE app.roles SET is_system = true
       WHERE id = '10910910-0000-0000-0000-000000000109';
    END $x$
  $$,
  'La marca is_system del rol "Rol 109" (inv-109) no se puede cambiar%');

-- 110 ─ Control positivo de 105 a 109: un rol que no es de sistema SÍ cambia
-- de nombre y de código y SÍ se borra, y un rol de sistema SÍ admite un
-- UPDATE que no toca su nombre, su código ni su marca. Sin esto, un trigger
-- que rechazara todo cambio de `roles` pasaría los cinco anteriores.
SELECT pg_temp.expect_fail_like(110, 'Rol personalizado se renombra y se borra',
  $$DO $x$
    BEGIN
      INSERT INTO app.roles (id, tenant_id, code, name)
      VALUES ('11011011-0000-0000-0000-000000000110',
              '11111111-1111-1111-1111-111111111111', 'inv-110', 'Rol 110');
      UPDATE app.roles SET name = 'Rol 110 renombrado', code = 'inv-110b'
       WHERE id = '11011011-0000-0000-0000-000000000110';
      UPDATE app.roles SET created_at = created_at
       WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND code = 'owner';
      DELETE FROM app.roles WHERE id = '11011011-0000-0000-0000-000000000110';
      RAISE EXCEPTION 'aceptado';
    END $x$
  $$,
  'aceptado');

-- 111 ─ `joda_api` no escribe el catálogo global `permissions`: ni INSERT,
-- UPDATE, DELETE ni TRUNCATE sobre la tabla, ni INSERT o UPDATE sobre una
-- columna (`has_table_privilege` no ve los privilegios por columna), ni por
-- un GRANT a PUBLIC; y sigue leyéndolo. El catálogo lo carga el seed. Sin
-- esto, un DELETE de un vendedor del tenant A borraba por cascada las
-- `role_permissions` de TODOS los tenants (revisión cruzada de B11c).
SELECT pg_temp.expect_true(111,
  'joda_api lee el catálogo permissions y no lo escribe',
  has_table_privilege('joda_api', 'app.permissions', 'SELECT')
  AND NOT has_table_privilege('joda_api', 'app.permissions', 'INSERT')
  AND NOT has_table_privilege('joda_api', 'app.permissions', 'UPDATE')
  AND NOT has_table_privilege('joda_api', 'app.permissions', 'DELETE')
  AND NOT has_table_privilege('joda_api', 'app.permissions', 'TRUNCATE')
  AND NOT has_any_column_privilege('joda_api', 'app.permissions', 'INSERT')
  AND NOT has_any_column_privilege('joda_api', 'app.permissions', 'UPDATE'));

-- 112 ─ La política de INSERT de `roles` exige que el rol NO sea de sistema:
-- un administrador no fabrica roles imborrables (con `is_system` el trigger
-- impide borrarlos y renombrarlos). Lee el texto de la política; el
-- comportamiento, como joda_api, lo prueba write_permissions.test.ts.
WITH de_insert AS (
  SELECT COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '') AS expresion
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app' AND c.relname = 'roles'
     AND p.polpermissive AND p.polcmd = 'a'
)
SELECT pg_temp.expect_true(112,
  'roles: la política de INSERT exige que el rol no sea de sistema',
  (SELECT count(*) FROM de_insert) = 1
  AND (SELECT count(*) FROM de_insert WHERE expresion LIKE '%NOT is_system%') = 1);

-- 113 ─ Las políticas de escritura de `role_permissions` excluyen los roles
-- de sistema: el INSERT y el UPDATE (el de destino también, para que no se
-- mueva una fila hacia uno) y el DELETE. Sus permisos son la matriz de
-- security-spec §2.1 y se cambian por el seed; sin esto, el dueño se vacía su
-- propio rol con un DELETE (revisión cruzada de B11c). Lee el texto de las
-- políticas; el comportamiento, como joda_api, lo prueba
-- write_permissions.test.ts.
WITH pol AS (
  SELECT p.polcmd,
         COALESCE(pg_get_expr(p.polqual, p.polrelid), '') AS usando,
         COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '') AS chequea
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app' AND c.relname = 'role_permissions'
     AND p.polpermissive AND p.polcmd IN ('a', 'w', 'd', '*')
)
SELECT pg_temp.expect_true(113,
  'role_permissions: no se escribe un rol de sistema (INSERT, UPDATE y DELETE)',
  EXISTS (SELECT 1 FROM pol WHERE polcmd = 'a' AND chequea LIKE '%is_system%')
  AND EXISTS (SELECT 1 FROM pol WHERE polcmd = 'w'
                 AND usando LIKE '%is_system%' AND chequea LIKE '%is_system%')
  AND EXISTS (SELECT 1 FROM pol WHERE polcmd = 'd' AND usando LIKE '%is_system%')
  AND NOT EXISTS (SELECT 1 FROM pol WHERE polcmd = '*'));


-- WP-B11d (0034_write_permissions_children_ledger.sql): escribir en el
-- ledger, en las líneas de órdenes de compra, en las recepciones y borrar un
-- pedido de venta exige permiso. Los invariantes 114, 118 y 119 leen el TEXTO
-- de las políticas (pg_get_expr), con el límite de siempre: no prueban que
-- hagan lo que dicen, y el 114 no puede probar qué permiso va con qué tipo de
-- movimiento. Eso lo prueba, con cada rol como joda_api,
-- write_permissions.test.ts. El CHECK y la guarda se prueban acá por
-- comportamiento, como superusuario.
-- ─────────────────────────────────────────────────────────────────────

-- 114 ─ inventory_movements tiene UNA política de escritura, la de INSERT, con
-- permiso y sin `true`; ninguna de UPDATE, DELETE ni FOR ALL (el ledger es
-- append-only); y nombra todos los valores de `movement_type` y los seis
-- permisos del mapeo. Un valor de enum agregado después y no mapeado se
-- rechaza por RLS, pero este invariante falla para obligar a decidirlo a
-- propósito. El nombre lista las culpables.
WITH politicas AS (
  SELECT p.polname, p.polcmd,
         COALESCE(pg_get_expr(p.polqual, p.polrelid), '')
           || ' ' || COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '') AS expresion
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app' AND c.relname = 'inventory_movements'
     AND p.polpermissive AND p.polcmd IN ('a', 'w', 'd', '*')
), de_insert AS (
  SELECT * FROM politicas WHERE polcmd = 'a'
), sobran AS (
  SELECT polname AS descripcion FROM politicas WHERE polcmd <> 'a'
), sin_permiso AS (
  SELECT polname AS descripcion FROM de_insert
   WHERE expresion NOT LIKE '%has_permission(%' OR expresion ~ '\mtrue\M'
), tipos_sin_cubrir AS (
  SELECT t::text AS descripcion
    FROM unnest(enum_range(NULL::app.movement_type)) AS t
   WHERE NOT EXISTS (SELECT 1 FROM de_insert i WHERE i.expresion LIKE '%''' || t::text || '''%')
), permisos_sin_usar AS (
  SELECT v.permiso AS descripcion
    FROM (VALUES ('sales.order:write'), ('inventory.stock:adjust'),
                 ('inventory.decant:execute'), ('market.purchase_order:receive'),
                 ('sales.order:refund'), ('market.purchase_order:write')) AS v(permiso)
   WHERE NOT EXISTS (SELECT 1 FROM de_insert i WHERE i.expresion LIKE '%''' || v.permiso || '''%')
)
SELECT pg_temp.expect_true(114,
  'Ledger: una sola política de escritura (INSERT), con permiso, que cubre todo movement_type'
    || COALESCE(' — sobran: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM sobran), '')
    || COALESCE(' — sin permiso: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM sin_permiso), '')
    || COALESCE(' — tipos sin cubrir: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM tipos_sin_cubrir), '')
    || COALESCE(' — permisos sin usar: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM permisos_sin_usar), ''),
  (SELECT count(*) FROM de_insert) = 1 AND NOT EXISTS (SELECT 1 FROM sobran)
  AND NOT EXISTS (SELECT 1 FROM sin_permiso) AND NOT EXISTS (SELECT 1 FROM tipos_sin_cubrir)
  AND NOT EXISTS (SELECT 1 FROM permisos_sin_usar));

-- 115 ─ Un transfer con un `reference_type` que no sea de la apertura o la
-- separación se rechaza: la política de `transfer_*` no puede depender de un
-- texto libre. Hay que rechazarlo por el CHECK y no por otra cosa.
SELECT pg_temp.expect_fail_like(115, 'Transfer con reference_type libre',
  $$INSERT INTO app.inventory_movements
      (tenant_id, lot_id, variant_id, qty, uom, movement_type, reference_type)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '99999999-0000-0000-0000-000000000002',
            '55555555-0000-0000-0000-000000000002', 1, 'ml', 'transfer_in', 'otro_texto')$$,
  '%movement_transfer_reference_type%');

-- 116 ─ Ni sin `reference_type`: un `IN` con NULL da NULL y un CHECK lo dejaría
-- pasar, así que el CHECK exige que no sea NULL.
SELECT pg_temp.expect_fail_like(116, 'Transfer sin reference_type',
  $$INSERT INTO app.inventory_movements
      (tenant_id, lot_id, variant_id, qty, uom, movement_type)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '99999999-0000-0000-0000-000000000002',
            '55555555-0000-0000-0000-000000000002', 1, 'ml', 'transfer_in')$$,
  '%movement_transfer_reference_type%');

-- 117 ─ Control positivo de 115 y 116: un transfer de la separación y uno de
-- la apertura SÍ entran, y un movimiento que no es transfer sigue aceptando
-- un `reference_type` libre (`sale_order`, `goods_receipt`...). Sin esto, un
-- CHECK que rechazara todo movimiento pasaría los dos anteriores.
SELECT pg_temp.expect_fail_like(117, 'Transfer de separación y apertura entran; otros tipos, texto libre',
  $$DO $x$
    BEGIN
      INSERT INTO app.inventory_movements
        (tenant_id, lot_id, variant_id, qty, uom, movement_type, reference_type)
      VALUES ('11111111-1111-1111-1111-111111111111',
              '99999999-0000-0000-0000-000000000002',
              '55555555-0000-0000-0000-000000000002', 1, 'ml', 'transfer_in', 'lot_separation'),
             ('11111111-1111-1111-1111-111111111111',
              '99999999-0000-0000-0000-000000000002',
              '55555555-0000-0000-0000-000000000002', 1, 'ml', 'transfer_in', 'lot_opening'),
             ('11111111-1111-1111-1111-111111111111',
              '99999999-0000-0000-0000-000000000002',
              '55555555-0000-0000-0000-000000000002', 1, 'ml', 'adjustment', 'texto libre');
      RAISE EXCEPTION 'aceptado';
    END $x$
  $$,
  'aceptado');

-- 118 ─ purchase_order_lines, goods_receipts y goods_receipt_lines: cada
-- política de escritura es la esperada (tabla, comando y permiso), no hay
-- ninguna otra (en particular, ningún DELETE en recepciones: se cancelan con
-- su estado) y ninguna es `true` ni FOR ALL. Además, el INSERT y el DELETE de
-- las líneas de órdenes exigen que la orden padre esté en `draft` (sin eso,
-- `:write` vaciaba una orden enviada), y su SELECT exige
-- `market.purchase_order:read` (sin eso, el vendedor veía los precios de
-- compra). El nombre lista las que faltan y las que sobran.
WITH esperadas(tabla, cmd, permiso) AS (
  VALUES
    ('purchase_order_lines', 'a'::"char", 'market.purchase_order:write'),
    ('purchase_order_lines', 'w',         'market.purchase_order:write'),
    ('purchase_order_lines', 'w',         'market.purchase_order:approve'),
    ('purchase_order_lines', 'w',         'market.purchase_order:receive'),
    ('purchase_order_lines', 'd',         'market.purchase_order:write'),
    ('goods_receipts',       'a',         'market.purchase_order:receive'),
    ('goods_receipts',       'w',         'market.purchase_order:receive'),
    ('goods_receipt_lines',  'a',         'market.purchase_order:receive'),
    ('goods_receipt_lines',  'w',         'market.purchase_order:receive')
), politicas AS (
  SELECT c.relname AS tabla, p.polname, p.polcmd,
         COALESCE(pg_get_expr(p.polqual, p.polrelid), '')
           || ' ' || COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '') AS expresion
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app' AND p.polpermissive AND p.polcmd IN ('a', 'w', 'd', '*')
     AND c.relname IN ('purchase_order_lines', 'goods_receipts', 'goods_receipt_lines')
), faltan AS (
  SELECT e.tabla || ' (' || e.cmd::text || ') ' || e.permiso AS descripcion
    FROM esperadas e
   WHERE NOT EXISTS (SELECT 1 FROM politicas p
                      WHERE p.tabla = e.tabla AND p.polcmd = e.cmd
                        AND p.expresion LIKE '%''' || e.permiso || '''%')
), sobran AS (
  SELECT p.tabla || '.' || p.polname AS descripcion
    FROM politicas p
   WHERE p.polcmd = '*' OR p.expresion ~ '\mtrue\M'
      OR NOT EXISTS (SELECT 1 FROM esperadas e WHERE e.tabla = p.tabla AND e.cmd = p.polcmd)
), sin_borrador AS (
  SELECT p.tabla || '.' || p.polname AS descripcion
    FROM politicas p
   WHERE p.tabla = 'purchase_order_lines' AND p.polcmd IN ('a', 'd')
     AND (p.expresion NOT LIKE '%purchase_orders%' OR p.expresion NOT LIKE '%''draft''%')
), lectura_lineas AS (
  SELECT p.polname, COALESCE(pg_get_expr(p.polqual, p.polrelid), '') AS expresion
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app' AND c.relname = 'purchase_order_lines'
     AND p.polpermissive AND p.polcmd = 'r'
), lectura_sin_permiso AS (
  SELECT 'purchase_order_lines.' || polname AS descripcion
    FROM lectura_lineas
   WHERE expresion NOT LIKE '%has_permission(''market.purchase_order:read''%'
  UNION ALL
  SELECT 'purchase_order_lines (sin política de SELECT)'
   WHERE NOT EXISTS (SELECT 1 FROM lectura_lineas)
)
SELECT pg_temp.expect_true(118,
  'Líneas de órdenes de compra y recepciones: escribir exige su permiso, las líneas solo en borrador y leerlas, :read; las recepciones no se borran'
    || COALESCE(' — faltan: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM faltan), '')
    || COALESCE(' — sobran: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM sobran), '')
    || COALESCE(' — sin exigir la orden en borrador: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM sin_borrador), '')
    || COALESCE(' — lectura sin permiso: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM lectura_sin_permiso), ''),
  NOT EXISTS (SELECT 1 FROM faltan) AND NOT EXISTS (SELECT 1 FROM sobran)
  AND NOT EXISTS (SELECT 1 FROM sin_borrador) AND NOT EXISTS (SELECT 1 FROM lectura_sin_permiso));

-- 119 ─ sale_orders se borra solo con `sales.order:write` Y en borrador, con
-- el estado dentro de la política y ninguna otra condición (ningún `OR`), y
-- hay una sola política de DELETE. INSERT y UPDATE siguen solo por tenant
-- (ver 0034, "qué queda fuera"), así que no se exige permiso en ellos.
WITH borrado AS (
  SELECT COALESCE(pg_get_expr(p.polqual, p.polrelid), '') AS expresion
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app' AND c.relname = 'sale_orders'
     AND p.polpermissive AND p.polcmd IN ('d', '*')
)
SELECT pg_temp.expect_true(119,
  'sale_orders: DELETE solo con sales.order:write y solo en borrador',
  (SELECT count(*) FROM borrado) = 1
  AND (SELECT count(*) FROM borrado
        WHERE expresion LIKE '%sales.order:write%'
          AND expresion LIKE '%(status = ''draft''%'
          AND expresion NOT LIKE '% OR %') = 1);

-- 120 ─ Un pedido `paid` no vuelve a borrador: sin esto, un UPDATE a `draft`
-- y un DELETE borraban una venta cobrada y desenganchaban su seña.
SELECT pg_temp.expect_fail_like(120, 'Pedido paid vuelve a draft',
  $$DO $x$
    BEGIN
      INSERT INTO app.sale_orders (id, tenant_id, channel_id, code, status)
      VALUES ('11711711-0000-0000-0000-000000000117', '11111111-1111-1111-1111-111111111111',
              'bbbbbbbb-0000-0000-0000-000000000001', 'VTA-INV-117', 'paid');
      UPDATE app.sale_orders SET status = 'draft'
       WHERE id = '11711711-0000-0000-0000-000000000117';
    END $x$
  $$,
  'El pedido 11711711-0000-0000-0000-000000000117 está en paid y no puede volver a draft%');

-- 121 ─ Ni uno `cancelled`.
SELECT pg_temp.expect_fail_like(121, 'Pedido cancelled vuelve a draft',
  $$DO $x$
    BEGIN
      INSERT INTO app.sale_orders (id, tenant_id, channel_id, code, status)
      VALUES ('11811811-0000-0000-0000-000000000118', '11111111-1111-1111-1111-111111111111',
              'bbbbbbbb-0000-0000-0000-000000000001', 'VTA-INV-118', 'cancelled');
      UPDATE app.sale_orders SET status = 'draft'
       WHERE id = '11811811-0000-0000-0000-000000000118';
    END $x$
  $$,
  'El pedido 11811811-0000-0000-0000-000000000118 está en cancelled y no puede volver a draft%');

-- 122 ─ Ni uno `awaiting_payment`, el único estado al que se llega desde
-- `draft`: no hay un análogo de `pending_approval` de la orden de compra, y
-- este es el control de que tampoco se vuelve de ahí.
SELECT pg_temp.expect_fail_like(122, 'Pedido awaiting_payment vuelve a draft',
  $$DO $x$
    BEGIN
      INSERT INTO app.sale_orders (id, tenant_id, channel_id, code, status)
      VALUES ('11911911-0000-0000-0000-000000000119', '11111111-1111-1111-1111-111111111111',
              'bbbbbbbb-0000-0000-0000-000000000001', 'VTA-INV-119', 'awaiting_payment');
      UPDATE app.sale_orders SET status = 'draft'
       WHERE id = '11911911-0000-0000-0000-000000000119';
    END $x$
  $$,
  'El pedido 11911911-0000-0000-0000-000000000119 está en awaiting_payment y no puede volver a draft%');

-- 123 ─ Control positivo de 120 a 122: un borrador se edita sin salir de
-- `draft`, y recorre el camino feliz de la máquina de A09 hasta `delivered`
-- y `refunded`. Sin esto, un trigger que rechazara todo cambio de estado
-- pasaría los tres anteriores.
SELECT pg_temp.expect_fail_like(123, 'Pedido draft se edita y avanza por la máquina',
  $$DO $x$
    BEGIN
      INSERT INTO app.sale_orders (id, tenant_id, channel_id, code, status)
      VALUES ('12012012-0000-0000-0000-000000000120', '11111111-1111-1111-1111-111111111111',
              'bbbbbbbb-0000-0000-0000-000000000001', 'VTA-INV-120', 'draft');
      UPDATE app.sale_orders SET status = 'draft', notes = 'editado'
       WHERE id = '12012012-0000-0000-0000-000000000120';
      UPDATE app.sale_orders SET status = 'awaiting_payment'
       WHERE id = '12012012-0000-0000-0000-000000000120';
      UPDATE app.sale_orders SET status = 'paid'
       WHERE id = '12012012-0000-0000-0000-000000000120';
      UPDATE app.sale_orders SET status = 'preparing'
       WHERE id = '12012012-0000-0000-0000-000000000120';
      UPDATE app.sale_orders SET status = 'ready'
       WHERE id = '12012012-0000-0000-0000-000000000120';
      UPDATE app.sale_orders SET status = 'shipped'
       WHERE id = '12012012-0000-0000-0000-000000000120';
      UPDATE app.sale_orders SET status = 'delivered'
       WHERE id = '12012012-0000-0000-0000-000000000120';
      UPDATE app.sale_orders SET status = 'refunded'
       WHERE id = '12012012-0000-0000-0000-000000000120';
      RAISE EXCEPTION 'aceptado';
    END $x$
  $$,
  'aceptado');

-- 124 ─ Un pedido con una seña enganchada no se borra: la FK
-- `customer_deposits.sale_order_id` es RESTRICT y no SET NULL. Una seña existe
-- antes del cobro, así que un borrador puede tener una; con SET NULL, borrarlo
-- la desenganchaba en silencio (revisión cruzada de B11d). Para borrarlo hay
-- que desvincularla a propósito. Rechaza como superusuario: es la FK, no RLS.
SELECT pg_temp.expect_fail_like(124, 'Borrar un borrador con una seña enganchada',
  $$DO $x$
    BEGIN
      INSERT INTO app.sale_orders (id, tenant_id, channel_id, code, status)
      VALUES ('12412412-0000-0000-0000-000000000124', '11111111-1111-1111-1111-111111111111',
              'bbbbbbbb-0000-0000-0000-000000000001', 'VTA-INV-124', 'draft');
      INSERT INTO app.customer_deposits (tenant_id, customer_id, amount_pyg, sale_order_id)
      VALUES ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
              100000, '12412412-0000-0000-0000-000000000124');
      DELETE FROM app.sale_orders WHERE id = '12412412-0000-0000-0000-000000000124';
    END $x$
  $$,
  '%customer_deposits_sale_order_id_fkey%');

-- 125 ─ Control positivo de 124: un borrador SIN seña se borra, y uno con la
-- seña ya desvinculada también. Sin esto, una FK que rechazara todo borrado
-- de pedidos pasaría el anterior.
SELECT pg_temp.expect_fail_like(125, 'Borrar un borrador sin seña, o con la seña desvinculada',
  $$DO $x$
    DECLARE
      v_deposit uuid;
    BEGIN
      INSERT INTO app.sale_orders (id, tenant_id, channel_id, code, status)
      VALUES ('12512512-0000-0000-0000-000000000125', '11111111-1111-1111-1111-111111111111',
              'bbbbbbbb-0000-0000-0000-000000000001', 'VTA-INV-125', 'draft'),
             ('12512512-0000-0000-0000-000000000126', '11111111-1111-1111-1111-111111111111',
              'bbbbbbbb-0000-0000-0000-000000000001', 'VTA-INV-126', 'draft');
      DELETE FROM app.sale_orders WHERE id = '12512512-0000-0000-0000-000000000125';
      INSERT INTO app.customer_deposits (tenant_id, customer_id, amount_pyg, sale_order_id)
      VALUES ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
              100000, '12512512-0000-0000-0000-000000000126')
      RETURNING id INTO v_deposit;
      UPDATE app.customer_deposits SET sale_order_id = NULL WHERE id = v_deposit;
      DELETE FROM app.sale_orders WHERE id = '12512512-0000-0000-0000-000000000126';
      RAISE EXCEPTION 'aceptado';
    END $x$
  $$,
  'aceptado');

-- 126 ─ Una línea de orden de compra no cambia de orden. Las políticas de
-- INSERT y DELETE de `purchase_order_lines` (0034) exigen la orden padre en
-- `draft`; la de UPDATE no mira el estado, y un UPDATE de `purchase_order_id`
-- hacía lo que ellas prohíben: mover la línea de una orden enviada a un
-- borrador la dejaba VACÍA, y mover una de un borrador a una orden enviada le
-- AGREGABA una (revisión cruzada de B11b/c/d, 0036). Una política de UPDATE no
-- puede comparar OLD con NEW; `trg_po_line_no_reparent` sí. Rechaza como
-- superusuario: es el trigger, no RLS.
SELECT pg_temp.expect_fail_like(126, 'Mover una línea de una orden de compra enviada a un borrador',
  $$DO $x$
    BEGIN
      INSERT INTO app.purchase_orders (id, tenant_id, supplier_id, code, status, currency,
                                       created_by, approved_by, approved_at)
      VALUES ('12612612-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
              '66666666-6666-6666-6666-666666666666', 'OC-INV-126A', 'sent', 'USD',
              '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', now());
      INSERT INTO app.purchase_orders (id, tenant_id, supplier_id, code, status, currency, created_by)
      VALUES ('12612612-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
              '66666666-6666-6666-6666-666666666666', 'OC-INV-126B', 'draft', 'USD',
              '22222222-2222-2222-2222-222222222222');
      INSERT INTO app.purchase_order_lines
        (id, tenant_id, purchase_order_id, variant_id, qty_ordered, uom, unit_price_minor)
      VALUES ('12612612-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111',
              '12612612-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000001',
              2, 'unit', 5000);
      UPDATE app.purchase_order_lines
         SET purchase_order_id = '12612612-0000-0000-0000-000000000002'
       WHERE id = '12612612-0000-0000-0000-0000000000a1';
    END $x$
  $$,
  'La línea 12612612-0000-0000-0000-0000000000a1 pertenece a la orden de compra 12612612-0000-0000-0000-000000000001 y no puede pasar a la orden 12612612-0000-0000-0000-000000000002%');

-- 127 ─ Control positivo de 126: lo que SÍ se edita en una línea de una orden
-- enviada pasa. La recepción actualiza `qty_received`, el precio y la
-- cantidad pedida los decide WP-C15, y un UPDATE que reenvía la misma
-- `purchase_order_id` no es un cambio de orden. Sin esto, un trigger que
-- rechazara todo UPDATE de líneas pasaría el anterior.
SELECT pg_temp.expect_fail_like(127, 'Editar una línea de una orden enviada sin cambiarla de orden',
  $$DO $x$
    BEGIN
      INSERT INTO app.purchase_orders (id, tenant_id, supplier_id, code, status, currency,
                                       created_by, approved_by, approved_at)
      VALUES ('12712712-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
              '66666666-6666-6666-6666-666666666666', 'OC-INV-127', 'sent', 'USD',
              '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', now());
      INSERT INTO app.purchase_order_lines
        (id, tenant_id, purchase_order_id, variant_id, qty_ordered, uom, unit_price_minor)
      VALUES ('12712712-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111',
              '12712712-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000001',
              2, 'unit', 5000);
      UPDATE app.purchase_order_lines SET qty_received = 1, unit_price_minor = 6000
       WHERE id = '12712712-0000-0000-0000-0000000000a1';
      UPDATE app.purchase_order_lines SET purchase_order_id = '12712712-0000-0000-0000-000000000001'
       WHERE id = '12712712-0000-0000-0000-0000000000a1';
      RAISE EXCEPTION 'aceptado';
    END $x$
  $$,
  'aceptado');

-- WP-B11f (0037_read_permission_ledger_costs.sql): leer el ledger y sus capas de
-- costo exige `inventory.stock:read`, como los lotes. Los invariantes 128 y 129
-- leen el TEXTO de las políticas y la matriz sembrada, con el límite de siempre:
-- no prueban que la política haga lo que dice. Eso lo prueba, conectado como
-- joda_api con cada rol, write_permissions.test.ts.
-- ─────────────────────────────────────────────────────────────────────

-- 128 ─ Cada política permisiva que cubre el SELECT de `inventory_movements` y
-- de `movement_cost_allocations` exige `inventory.stock:read`, sin `true` y sin
-- una rama `OR` que la abra (por ejemplo, a las filas `sale`, como sugería la
-- fila de WP-B11f: son las que traen el costo de lo que el vendedor vendió), y
-- ninguna es FOR ALL; y cada tabla tiene al menos una. Con la `tenant_access`
-- de 0014 o la `tenant_access_select` de 0034, el vendedor leía el costo de
-- cada movimiento y, sumando las capas, el mismo total. El nombre lista las
-- culpables y las tablas sin política de lectura.
WITH ledger(tabla) AS (
  VALUES ('inventory_movements'), ('movement_cost_allocations')
), lectura AS (
  SELECT c.relname AS tabla, p.polname, p.polcmd,
         COALESCE(pg_get_expr(p.polqual, p.polrelid), '') AS expresion
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN ledger l ON l.tabla = c.relname
   WHERE n.nspname = 'app' AND p.polpermissive AND p.polcmd IN ('r', '*')
), sin_permiso AS (
  SELECT tabla || '.' || polname AS descripcion
    FROM lectura
   WHERE polcmd = '*'
      OR expresion NOT LIKE '%has_permission(''inventory.stock:read''%'
      OR expresion ~ '\mtrue\M'
      OR expresion LIKE '% OR %'
), sin_politica AS (
  SELECT l.tabla || ' (sin política de SELECT)' AS descripcion
    FROM ledger l
   WHERE NOT EXISTS (SELECT 1 FROM lectura x WHERE x.tabla = l.tabla)
)
SELECT pg_temp.expect_true(128,
  'Leer el ledger y sus capas de costo exige inventory.stock:read, sin true ni rama OR'
    || COALESCE(' — sin permiso: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM sin_permiso), '')
    || COALESCE(' — sin política: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM sin_politica), ''),
  NOT EXISTS (SELECT 1 FROM sin_permiso) AND NOT EXISTS (SELECT 1 FROM sin_politica));

-- 129 ─ La trampa de la lectura del ledger. En los roles sembrados
-- (`is_system`, de cualquier tenant), todo permiso que escribe un movimiento
-- viene con `inventory.stock:read`: `INSERT ... RETURNING` evalúa también la
-- política de lectura, y un rol que escribe sin leer recibe 42501 en el
-- `create` de Prisma. Única excepción, registrada para WP-C19: el vendedor
-- escribe el movimiento `sale` (`sales.order:write`) sin poder leerlo, a
-- propósito (es el costo de lo que vendió); lo registra SIN `RETURNING`. Si
-- C19 la resuelve de otro modo, se quita de acá. Los roles que crea un
-- administrador no entran: validar el par al crearlos es de WP-C24. Los seis
-- permisos son los de la política de INSERT (invariante 114).
WITH escribe(permiso) AS (
  VALUES ('sales.order:write'), ('inventory.stock:adjust'), ('inventory.decant:execute'),
         ('market.purchase_order:receive'), ('sales.order:refund'),
         ('market.purchase_order:write')
), roles_sembrados AS (
  SELECT id, code, tenant_id FROM app.roles WHERE is_system
), escribe_sin_leer AS (
  SELECT r.code || ' (' || left(r.tenant_id::text, 8) || ') → ' || e.permiso AS descripcion
    FROM roles_sembrados r
    JOIN app.role_permissions w ON w.role_id = r.id
    JOIN escribe e ON e.permiso = w.permission_code
   WHERE NOT EXISTS (SELECT 1 FROM app.role_permissions l
                      WHERE l.role_id = r.id AND l.permission_code = 'inventory.stock:read')
     AND NOT (r.code = 'vendedor' AND e.permiso = 'sales.order:write')
)
SELECT pg_temp.expect_true(129,
  'Ningún rol sembrado escribe un movimiento sin poder leerlo (salvo el vendedor con sale, WP-C19)'
    || COALESCE(' — escriben sin leer: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM escribe_sin_leer), ''),
  (SELECT count(*) FROM roles_sembrados) >= 4 AND NOT EXISTS (SELECT 1 FROM escribe_sin_leer));

-- 130 ─ El vendedor sembrado no tiene `inventory.stock:read`. Es lo que hace
-- que la decisión de José (el vendedor no obtiene el costo de un movimiento ni
-- de un lote) sea cierta: con ese permiso, 128 se cumpliría y el vendedor
-- leería igual el ledger, los lotes y las capas. Si el negocio decide darle
-- otra vista del stock, es un permiso nuevo, no este.
WITH vendedores AS (
  SELECT id FROM app.roles WHERE is_system AND code = 'vendedor'
)
SELECT pg_temp.expect_true(130,
  'El vendedor sembrado no tiene inventory.stock:read: no lee costos de lotes ni del ledger',
  (SELECT count(*) FROM vendedores) >= 1
  AND NOT EXISTS (SELECT 1 FROM app.role_permissions rp
                    JOIN vendedores v ON v.id = rp.role_id
                   WHERE rp.permission_code = 'inventory.stock:read'));

-- 131 ─ El mensaje del disparador de las capas de costo no dice el costo a
-- quien no puede leerlo. Rechaza una capa que no cuadra con `Capas de costo del
-- movimiento N no cuadran: asignado=X declarado=Y`, y Y es el costo del
-- movimiento: con una capa de 1 sobre un movimiento ajeno, el vendedor lo leía
-- en el error aunque ya no pudiera leer el ledger (0037). Acá no hay sesión de
-- staff (`has_permission` da falso), así que el rechazo tiene que ser el sin
-- cifras, y con ese texto exacto: sin `%` al final, un mensaje con montos
-- agregados no coincide. El control con permiso, que sí los trae, lo prueba
-- write_permissions.test.ts.
SELECT pg_temp.expect_fail_like(131, 'Capa que no cuadra, sin permiso de lectura: el rechazo no trae los montos',
  $$DO $x$
    DECLARE
      v_mov bigint;
    BEGIN
      INSERT INTO app.inventory_movements
        (tenant_id, lot_id, variant_id, qty, uom, movement_type, total_cost_pyg)
      VALUES ('11111111-1111-1111-1111-111111111111',
              '99999999-0000-0000-0000-000000000002',
              '55555555-0000-0000-0000-000000000002', 1, 'ml', 'adjustment', 5000)
      RETURNING id INTO v_mov;
      INSERT INTO app.movement_cost_allocations
        (tenant_id, movement_id, lot_id, qty, unit_cost_pyg, total_cost_pyg)
      VALUES ('11111111-1111-1111-1111-111111111111', v_mov,
              '99999999-0000-0000-0000-000000000002', 1, 1, 1);
      SET CONSTRAINTS app.trg_cost_allocation_matches IMMEDIATE;
    END $x$
  $$,
  'Capas de costo del movimiento % no cuadran con el costo del movimiento');

-- ─────────────────────────────────────────────────────────────────────
-- WP-B17 (0038_variant_online_visible_types.sql, RN-CAT-02): solo `sealed`,
-- `decant` y `unit` se publican en la tienda. El CHECK es una lista blanca;
-- el motivo del rechazo se pide por nombre de constraint, porque estas filas
-- cumplen los demás CHECK de la tabla (tamaño, unidad de medida): lo único
-- que las puede rechazar es la visibilidad.
-- ─────────────────────────────────────────────────────────────────────

-- 132 ─ Un tester no se publica. Frasco de exhibición, con su `size_ml`.
SELECT pg_temp.expect_fail_like(132, 'Variante tester con online_visible = true',
  $$INSERT INTO app.product_variants
      (tenant_id, product_id, sku, variant_type, uom, size_ml, price_pyg, online_visible)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '44444444-4444-4444-4444-444444444444', 'INV-132-TESTER', 'tester', 'unit', 125, 0, true)$$,
  '%product_variants_online_visible_type_check%');

-- 133 ─ Un insumo no se publica.
SELECT pg_temp.expect_fail_like(133, 'Variante supply con online_visible = true',
  $$INSERT INTO app.product_variants
      (tenant_id, product_id, sku, variant_type, uom, price_pyg, online_visible)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '44444444-0000-0000-0000-00000000aaaa', 'INV-133-SUPPLY', 'supply', 'unit', 0, true)$$,
  '%product_variants_online_visible_type_check%');

-- 134 ─ Un granel no se publica. Se prueba en un producto sin granel
-- (`44444444-0000-0000-0000-00000000aaaa`): en el de Layton el índice único
-- del 84 también lo rechazaría, y un rechazo por otro motivo no prueba el CHECK.
SELECT pg_temp.expect_fail_like(134, 'Variante bulk con online_visible = true',
  $$INSERT INTO app.product_variants
      (tenant_id, product_id, sku, variant_type, uom, price_pyg, online_visible)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '44444444-0000-0000-0000-00000000aaaa', 'INV-134-BULK', 'bulk', 'ml', 0, true)$$,
  '%product_variants_online_visible_type_check%');

-- 135 ─ Encender el flag de una variante que ya existe también se rechaza: el
-- CHECK vale en el UPDATE, no solo al insertar. Es el caso que antes cubría la
-- normalización de `updateVariant` (el granel de Layton, que el smoke dejó en
-- `false`), y el que reabre cualquier UPDATE directo o el procedimiento de
-- publicación de WP-C08g.
SELECT pg_temp.expect_fail_like(135, 'UPDATE online_visible = true sobre el granel existente',
  $$UPDATE app.product_variants SET online_visible = true
     WHERE id = '55555555-0000-0000-0000-000000000002'$$,
  '%product_variants_online_visible_type_check%');

-- 136 ─ Control positivo de 132 a 135: las tres variantes que sí se publican
-- aceptan el flag. Sin él, un CHECK que rechazara todo `online_visible = true`
-- pasaría las cuatro pruebas de arriba.
SELECT pg_temp.expect_fail_like(136, 'Sellado, decant y unit aceptan online_visible = true',
  $$DO $x$
    BEGIN
      INSERT INTO app.product_variants
        (tenant_id, product_id, sku, variant_type, uom, size_ml, price_pyg, online_visible)
      VALUES
        ('11111111-1111-1111-1111-111111111111',
         '44444444-4444-4444-4444-444444444444', 'INV-136-SEALED', 'sealed', 'unit', 50, 0, true),
        ('11111111-1111-1111-1111-111111111111',
         '44444444-4444-4444-4444-444444444444', 'INV-136-DECANT', 'decant', 'ml', 5, 0, true);
      INSERT INTO app.product_variants
        (tenant_id, product_id, sku, variant_type, uom, price_pyg, online_visible)
      VALUES ('11111111-1111-1111-1111-111111111111',
              '44444444-0000-0000-0000-00000000aaaa', 'INV-136-UNIT', 'unit', 'unit', 0, true);
      RAISE EXCEPTION 'aceptado';
    END $x$
  $$,
  'aceptado');

-- ─────────────────────────────────────────────────────────────────────
-- WP-B18 (0039_decant_plan_lots_and_cost_layer_permission.sql, H1 y H3 de la
-- revisión de WP-C13): el vendedor planifica un decant sin leer lotes, y una
-- línea de venta tiene una sola orden de fraccionamiento activa.
--
-- 137 a 139 miran la forma (el seed y la firma); 140 a 145 ejercen la función
-- conectados como `joda_api` (`SET LOCAL ROLE`, la credencial del runtime y no
-- el superusuario que elude RLS), con una sesión de staff viva creada dentro
-- del propio bloque y revertida con él; 146 y 147 prueban el índice. El
-- comportamiento completo, con el vendedor, el depósito y un tenant vecino
-- con sus propios lotes, lo prueba `decant_plan_lots.test.ts`.
--
-- Cada bloque termina en una excepción (`aceptado` si la condición se cumplió):
-- así se revierte todo lo que creó, incluido el `SET LOCAL ROLE`, que de otro
-- modo dejaría al resto del archivo corriendo como `joda_api`.
-- ─────────────────────────────────────────────────────────────────────

-- Un usuario de staff del tenant (por defecto, el del smoke) con el rol de ese
-- código y una sesión viva. El id de usuario es `b1800000-…-<n>` y el de la
-- sesión `b1850000-…-<n>`.
CREATE OR REPLACE FUNCTION pg_temp.b18_actor(
  p_role text, p_n int, p_tenant uuid DEFAULT '11111111-1111-1111-1111-111111111111'
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_user uuid := ('b1800000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_session uuid := ('b1850000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid;
BEGIN
  INSERT INTO app.staff_users (id, tenant_id, auth_subject, email, full_name)
  VALUES (v_user, p_tenant, 'sub-b18-' || p_n, 'b18-' || p_n || '@joda.test', 'Actor B18 ' || p_n);
  INSERT INTO app.staff_user_roles (staff_user_id, role_id, tenant_id)
  SELECT v_user, r.id, r.tenant_id FROM app.roles r WHERE r.tenant_id = p_tenant AND r.code = p_role;
  INSERT INTO app.staff_sessions (id, tenant_id, staff_user_id, expires_at)
  VALUES (v_session, p_tenant, v_user, now() + interval '8 hours');
END $$;

-- 137 ─ `inventory.decant:plan` está en el catálogo y en los cuatro roles de
-- sistema de cada tenant, y en ningún otro rol: ni un rol de sistema que no
-- esté en la lista ni uno personalizado. Sin él en el vendedor, vender un
-- decant vuelve a necesitar `inventory.stock:read`; en un rol de más, la
-- planificación se abre a quien no debe. El nombre lista las culpables.
WITH roles_sistema AS (
  SELECT id, code, tenant_id FROM app.roles WHERE is_system
), tiene AS (
  SELECT rp.role_id FROM app.role_permissions rp
   WHERE rp.permission_code = 'inventory.decant:plan'
), faltan AS (
  SELECT r.code || ' (' || left(r.tenant_id::text, 8) || ')' AS descripcion
    FROM roles_sistema r
   WHERE r.code IN ('owner', 'manager', 'vendedor', 'deposito')
     AND r.id NOT IN (SELECT role_id FROM tiene)
), sobran AS (
  SELECT r.code || ' (' || left(r.tenant_id::text, 8) || ')' AS descripcion
    FROM app.roles r
    JOIN tiene t ON t.role_id = r.id
   WHERE NOT (r.is_system AND r.code IN ('owner', 'manager', 'vendedor', 'deposito'))
)
SELECT pg_temp.expect_true(137,
  'inventory.decant:plan está en el catálogo y solo en owner, manager, vendedor y deposito'
    || COALESCE(' — faltan: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM faltan), '')
    || COALESCE(' — sobran: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM sobran), ''),
  EXISTS (SELECT 1 FROM app.permissions WHERE code = 'inventory.decant:plan')
  AND (SELECT count(*) FROM roles_sistema) >= 4
  AND NOT EXISTS (SELECT 1 FROM faltan) AND NOT EXISTS (SELECT 1 FROM sobran));

-- 138 ─ El vendedor sembrado planifica, pero no ejecuta ni lee lotes:
-- `plan` no es una puerta de atrás hacia `inventory.decant:execute` (la política
-- de `inventory_movements` del consumo del granel, 0034) ni hacia
-- `inventory.stock:read` (el 130). Si se le diera uno de los dos para
-- planificar, volverían los costos de lote al vendedor.
WITH vendedores AS (
  SELECT id FROM app.roles WHERE is_system AND code = 'vendedor'
)
SELECT pg_temp.expect_true(138,
  'El vendedor sembrado tiene inventory.decant:plan y no tiene inventory.decant:execute',
  (SELECT count(*) FROM vendedores) >= 1
  AND NOT EXISTS (SELECT 1 FROM vendedores v
                   WHERE NOT EXISTS (SELECT 1 FROM app.role_permissions rp
                                      WHERE rp.role_id = v.id
                                        AND rp.permission_code = 'inventory.decant:plan'))
  AND NOT EXISTS (SELECT 1 FROM app.role_permissions rp
                    JOIN vendedores v ON v.id = rp.role_id
                   WHERE rp.permission_code = 'inventory.decant:execute'));

-- 139 ─ La función de los lotes candidatos: una sola, SECURITY DEFINER con
-- `search_path` fijo, que devuelve exactamente `lot_id`, `available` y
-- `opened_at` (ningún costo ni proveedor), que no se puede ejecutar por PUBLIC
-- ni por `joda_readonly` (el storefront) y sí por `joda_api`. El 30 y el 40
-- ya cubren el dueño y el `search_path` de toda SECURITY DEFINER; acá se pide
-- por nombre para que borrarla o ensancharla no pase desapercibido.
WITH f AS (
  SELECT p.oid, p.prosecdef, p.proconfig, p.proacl, p.proowner,
         p.proargnames, p.proargmodes, p.proallargtypes
    FROM pg_proc p
   WHERE p.pronamespace = 'app'::regnamespace AND p.proname = 'list_decant_plan_lots'
)
SELECT pg_temp.expect_true(139,
  'list_decant_plan_lots: SECURITY DEFINER, devuelve solo lot_id/available/opened_at, solo joda_api la ejecuta',
  (SELECT count(*) FROM f) = 1
  AND (SELECT bool_and(prosecdef) FROM f)
  AND (SELECT bool_and('search_path=app, pg_temp' = ANY (COALESCE(proconfig, '{}'))) FROM f)
  AND (SELECT bool_and(proargnames = ARRAY['p_variant_id', 'lot_id', 'available', 'opened_at']
                       AND proargmodes = ARRAY['i', 't', 't', 't']::"char"[]
                       AND proallargtypes = ARRAY['uuid'::regtype::oid, 'uuid'::regtype::oid,
                                                  'app.qty'::regtype::oid,
                                                  'timestamptz'::regtype::oid])
         FROM f)
  AND NOT EXISTS (SELECT 1 FROM f,
                    aclexplode(COALESCE(f.proacl, acldefault('f', f.proowner))) a
                   WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
  AND (SELECT bool_and(has_function_privilege('joda_api', oid, 'EXECUTE')) FROM f)
  AND NOT (SELECT bool_or(has_function_privilege('joda_readonly', oid, 'EXECUTE')) FROM f));

-- 140 ─ Control positivo y la razón de ser de la función: el vendedor, conectado
-- como `joda_api` y SIN `inventory.stock:read`, no lee ningún lote
-- (`inventory_lots` le da cero filas) y aun así la función le entrega el granel
-- abierto del tenant con su cantidad y su fecha de apertura, los mismos valores
-- que tiene el lote, y con exactamente esas tres columnas.
SELECT pg_temp.expect_fail_like(140, 'El vendedor planifica sin leer lotes: la función le entrega lot_id, disponible y apertura',
  $$DO $x$
    DECLARE
      v_bulk constant uuid := '55555555-0000-0000-0000-000000000002';
      v_lot constant uuid := '99999999-0000-0000-0000-000000000002';
      v_opened timestamptz;
      v_hand numeric;
      v_direct int;
      v_rows int;
      v_keys text;
      v_got_lot text;
      v_got_available numeric;
      v_got_opened timestamptz;
    BEGIN
      SELECT l.opened_at INTO v_opened FROM app.inventory_lots l WHERE l.id = v_lot;
      SELECT b.on_hand INTO v_hand FROM app.inventory_balances b WHERE b.lot_id = v_lot;
      PERFORM pg_temp.b18_actor('vendedor', 140);
      SET LOCAL ROLE joda_api;
      PERFORM set_config('app.user_id', 'b1800000-0000-0000-0000-000000000140', true),
              set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true),
              set_config('app.audience', 'staff', true),
              set_config('app.session_id', 'b1850000-0000-0000-0000-000000000140', true);
      SELECT count(*) INTO v_direct FROM app.inventory_lots;
      SELECT count(*), min(f.lot_id::text), min(f.available), min(f.opened_at)
        INTO v_rows, v_got_lot, v_got_available, v_got_opened
        FROM app.list_decant_plan_lots(v_bulk) f;
      SELECT string_agg(k, ',' ORDER BY k) INTO v_keys
        FROM (SELECT DISTINCT jsonb_object_keys(to_jsonb(f)) AS k
                FROM app.list_decant_plan_lots(v_bulk) f) s;
      IF v_direct = 0 AND v_rows = 1 AND v_got_lot = v_lot::text
         AND v_got_available = v_hand AND v_got_opened = v_opened
         AND v_keys = 'available,lot_id,opened_at' THEN
        RAISE EXCEPTION 'aceptado';
      END IF;
      RAISE EXCEPTION 'FALLO directo=% filas=% lote=% disponible=% (esperado %) apertura=% columnas=%',
        v_direct, v_rows, v_got_lot, v_got_available, v_hand, v_got_opened, v_keys;
    END $x$
  $$,
  'aceptado');

-- 141 ─ Sin `inventory.decant:plan` la función RECHAZA, no devuelve un vacío:
-- un vacío es indistinguible de «no hay granel», el engaño de H1. Un rol que
-- lee lotes y ejecuta decants (y no puede planificar) es el vecino más
-- plausible.
SELECT pg_temp.expect_fail_like(141, 'Sin inventory.decant:plan la función rechaza (42501), no devuelve un vacío',
  $$DO $x$
    BEGIN
      INSERT INTO app.roles (id, tenant_id, code, name)
      VALUES ('b1860000-0000-0000-0000-000000000141', '11111111-1111-1111-1111-111111111111',
              'b18-sin-plan', 'Sin plan');
      INSERT INTO app.role_permissions (tenant_id, role_id, permission_code)
      VALUES ('11111111-1111-1111-1111-111111111111', 'b1860000-0000-0000-0000-000000000141',
              'inventory.stock:read'),
             ('11111111-1111-1111-1111-111111111111', 'b1860000-0000-0000-0000-000000000141',
              'inventory.decant:execute');
      PERFORM pg_temp.b18_actor('b18-sin-plan', 141);
      SET LOCAL ROLE joda_api;
      PERFORM set_config('app.user_id', 'b1800000-0000-0000-0000-000000000141', true),
              set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true),
              set_config('app.audience', 'staff', true),
              set_config('app.session_id', 'b1850000-0000-0000-0000-000000000141', true);
      PERFORM * FROM app.list_decant_plan_lots('55555555-0000-0000-0000-000000000002');
      RAISE EXCEPTION 'devolvió filas o un vacío';
    END $x$
  $$,
  'Falta el permiso inventory.decant:plan%');

-- 142 ─ Sin sesión de staff vigente tampoco: aunque el usuario tenga el
-- permiso, una audiencia que no es `staff`, una sesión que no existe o ningún
-- `app.session_id` rechazan las tres. Es lo que distingue a la función de una
-- lectura abierta a quien sabe un `user_id`.
SELECT pg_temp.expect_fail_like(142, 'Sin sesión de staff vigente la función rechaza: audiencia system, sesión inexistente y sin sesión',
  $$DO $x$
    DECLARE
      v_ctx record;
      v_rechazos int := 0;
    BEGIN
      PERFORM pg_temp.b18_actor('vendedor', 142);
      SET LOCAL ROLE joda_api;
      FOR v_ctx IN
        SELECT * FROM (VALUES
          ('system', 'b1850000-0000-0000-0000-000000000142'),
          ('staff',  'b1850000-0000-0000-0000-0000000f0142'),
          ('staff',  '')
        ) AS t(audience, session_id)
      LOOP
        PERFORM set_config('app.user_id', 'b1800000-0000-0000-0000-000000000142', true),
                set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true),
                set_config('app.audience', v_ctx.audience, true),
                set_config('app.session_id', v_ctx.session_id, true);
        BEGIN
          PERFORM * FROM app.list_decant_plan_lots('55555555-0000-0000-0000-000000000002');
        EXCEPTION WHEN insufficient_privilege THEN
          IF SQLERRM LIKE 'Falta el permiso inventory.decant:plan%' THEN
            v_rechazos := v_rechazos + 1;
          END IF;
        END;
      END LOOP;
      IF v_rechazos = 3 THEN
        RAISE EXCEPTION 'aceptado';
      END IF;
      RAISE EXCEPTION 'FALLO solo % de 3 contextos rechazaron', v_rechazos;
    END $x$
  $$,
  'aceptado');

-- 143 ─ Sin tenant en el contexto: rechaza. Una SECURITY DEFINER ve las filas
-- de todos los tenants; sin tenant, «filtrar por el tenant de la sesión» no
-- filtraría nada.
SELECT pg_temp.expect_fail_like(143, 'Sin tenant en el contexto la función rechaza (42501), no devuelve lotes',
  $$DO $x$
    BEGIN
      PERFORM pg_temp.b18_actor('vendedor', 143);
      SET LOCAL ROLE joda_api;
      PERFORM set_config('app.user_id', 'b1800000-0000-0000-0000-000000000143', true),
              set_config('app.tenant_id', '', true),
              set_config('app.audience', 'staff', true),
              set_config('app.session_id', 'b1850000-0000-0000-0000-000000000143', true);
      PERFORM * FROM app.list_decant_plan_lots('55555555-0000-0000-0000-000000000002');
      RAISE EXCEPTION 'devolvió filas o un vacío';
    END $x$
  $$,
  'No hay tenant en el contexto%');

-- 144 ─ Una sombra en `pg_temp` no cambia nada. En una SECURITY DEFINER sin
-- `search_path` fijo, `pg_temp` se busca primero (verificado como `joda_api`
-- en WP-B10 sobre has_permission). Con tablas temporales falsas de
-- `role_permissions`, `staff_user_roles`, `staff_sessions`, `inventory_lots`,
-- `inventory_balances` y `product_variants`, y `pg_temp` primero en el
-- `search_path` de la sesión: (a) quien NO tiene el permiso sigue rechazado
-- aunque la sombra se lo otorgue, y (b) quien lo tiene sigue recibiendo los
-- lotes reales aunque la sombra diga que no hay ninguno.
SELECT pg_temp.expect_fail_like(144, 'Una sombra en pg_temp no otorga el permiso ni cambia los lotes que la función devuelve',
  $$DO $x$
    DECLARE
      v_denegado boolean := false;
      v_rows int;
    BEGIN
      INSERT INTO app.roles (id, tenant_id, code, name)
      VALUES ('b1860000-0000-0000-0000-000000000144', '11111111-1111-1111-1111-111111111111',
              'b18-sin-plan-144', 'Sin plan 144');
      PERFORM pg_temp.b18_actor('b18-sin-plan-144', 144);
      PERFORM pg_temp.b18_actor('vendedor', 1440);
      SET LOCAL ROLE joda_api;
      CREATE TEMP TABLE role_permissions (LIKE app.role_permissions);
      CREATE TEMP TABLE staff_user_roles (LIKE app.staff_user_roles);
      CREATE TEMP TABLE inventory_lots (LIKE app.inventory_lots);
      CREATE TEMP TABLE inventory_balances (LIKE app.inventory_balances);
      CREATE TEMP TABLE product_variants (LIKE app.product_variants);
      INSERT INTO pg_temp.role_permissions (tenant_id, role_id, permission_code)
      VALUES ('11111111-1111-1111-1111-111111111111', 'b1860000-0000-0000-0000-000000000144',
              'inventory.decant:plan');
      PERFORM set_config('search_path', 'pg_temp, app, public', true);
      PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true),
              set_config('app.audience', 'staff', true);
      PERFORM set_config('app.user_id', 'b1800000-0000-0000-0000-000000000144', true),
              set_config('app.session_id', 'b1850000-0000-0000-0000-000000000144', true);
      BEGIN
        PERFORM * FROM app.list_decant_plan_lots('55555555-0000-0000-0000-000000000002');
      EXCEPTION WHEN insufficient_privilege THEN
        v_denegado := true;
      END;
      PERFORM set_config('app.user_id', 'b1800000-0000-0000-0000-000000001440', true),
              set_config('app.session_id', 'b1850000-0000-0000-0000-000000001440', true);
      SELECT count(*) INTO v_rows
        FROM app.list_decant_plan_lots('55555555-0000-0000-0000-000000000002');
      IF v_denegado AND v_rows = 1 THEN
        RAISE EXCEPTION 'aceptado';
      END IF;
      RAISE EXCEPTION 'FALLO denegado=% filas=% (esperado true y 1)', v_denegado, v_rows;
    END $x$
  $$,
  'aceptado');

-- 145 ─ La función filtra por el tenant de la sesión: el dueño de OTRO tenant,
-- con todos los permisos, no obtiene los lotes de una variante que no es suya.
-- Un rechazo, no un vacío ni los lotes ajenos (una SECURITY DEFINER ve los
-- de todos los tenants).
SELECT pg_temp.expect_fail_like(145, 'El dueño de otro tenant no obtiene los lotes de una variante ajena',
  $$DO $x$
    BEGIN
      INSERT INTO app.tenants (id, slug, legal_name, trade_name)
      VALUES ('18181818-0000-0000-0000-000000000145', 'tenant-inv-145', 'Inv 145 SA', 'Inv 145');
      PERFORM app.seed_roles('18181818-0000-0000-0000-000000000145');
      PERFORM pg_temp.b18_actor('owner', 145, '18181818-0000-0000-0000-000000000145');
      SET LOCAL ROLE joda_api;
      PERFORM set_config('app.user_id', 'b1800000-0000-0000-0000-000000000145', true),
              set_config('app.tenant_id', '18181818-0000-0000-0000-000000000145', true),
              set_config('app.audience', 'staff', true),
              set_config('app.session_id', 'b1850000-0000-0000-0000-000000000145', true);
      PERFORM * FROM app.list_decant_plan_lots('55555555-0000-0000-0000-000000000002');
      RAISE EXCEPTION 'devolvió filas o un vacío';
    END $x$
  $$,
  'La variante % no existe en el tenant de la sesión');

-- 146 ─ Una línea de venta tiene una sola orden de fraccionamiento activa
-- (H3): el smoke ya tiene una `done` para la línea `cccccccc-…-0a`, y una
-- segunda, sea cual sea su estado salvo `cancelled`, la rechaza el índice
-- único parcial y no otra barrera. La `Idempotency-Key` no lo garantiza: la
-- elige el cliente.
SELECT pg_temp.expect_fail_like(146, 'Segunda orden activa para la misma línea de venta',
  $$INSERT INTO app.decant_work_orders
      (tenant_id, source_lot_id, target_variant_id, sale_order_id, sale_order_line_id,
       qty_units, ml_per_unit, ml_expected, waste_expected)
    VALUES ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000002',
            '55555555-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000001',
            'cccccccc-0000-0000-0000-00000000000a', 1, 10.000, 10.000, 0.200)$$,
  '%decant_wo_one_active_per_line%');

-- 147 ─ Control positivo de 146: cancelar la orden permite replanificar la
-- línea, y las órdenes sin línea (decants para stock, C13b) conviven: un NULL
-- no choca en un índice único. Sin esto, un índice que rechazara todo
-- segundo insert, o que dejara una sola orden sin línea, pasaría el 146.
SELECT pg_temp.expect_fail_like(147, 'Replanificar una línea tras cancelar su orden, y órdenes sin línea',
  $$DO $x$
    BEGIN
      UPDATE app.decant_work_orders SET status = 'cancelled'
       WHERE sale_order_line_id = 'cccccccc-0000-0000-0000-00000000000a';
      INSERT INTO app.decant_work_orders
        (tenant_id, source_lot_id, target_variant_id, sale_order_id, sale_order_line_id,
         qty_units, ml_per_unit, ml_expected, waste_expected)
      VALUES ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000002',
              '55555555-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000001',
              'cccccccc-0000-0000-0000-00000000000a', 1, 10.000, 10.000, 0.200);
      INSERT INTO app.decant_work_orders
        (tenant_id, source_lot_id, target_variant_id, qty_units, ml_per_unit, ml_expected,
         waste_expected)
      VALUES ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000002',
              '55555555-0000-0000-0000-000000000003', 1, 10.000, 10.000, 0.200),
             ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000002',
              '55555555-0000-0000-0000-000000000003', 1, 10.000, 10.000, 0.200);
      RAISE EXCEPTION 'aceptado';
    END $x$
  $$,
  'aceptado');

-- ─────────────────────────────────────────────────────────────────────
-- WP-B11e (misma migración): las capas de costo de una salida exigen el
-- permiso del movimiento al que pertenecen, y solo se atan a un movimiento de
-- la transacción de quien las escribe. Como el 114 para el ledger, estos dos
-- leen el TEXTO de la política y de la función: no prueban que hagan lo que
-- dicen. Eso lo prueba, conectado como joda_api con cada rol,
-- `write_permissions.test.ts`. Acá no se puede: los bloques de este archivo
-- corren dentro de una subtransacción (el `EXCEPTION` de expect_*), y un
-- movimiento insertado en una subtransacción no es «de esta transacción» para
-- la función (su `xmin` es el de la subtransacción; falla cerrado).
-- ─────────────────────────────────────────────────────────────────────

-- 148 ─ movement_cost_allocations tiene UNA política de escritura, la de
-- INSERT, que consulta el permiso del movimiento por la función y no es
-- `true`; ninguna de UPDATE, DELETE ni FOR ALL (las capas son append-only); y
-- la política de INSERT no se queda en un `has_permission` suelto que
-- ignore el tipo del movimiento. Con la `tenant_access_insert` (`true`) de
-- 0037 el vendedor registraba capas sobre cualquier movimiento. El nombre
-- lista las culpables.
WITH politicas AS (
  SELECT p.polname, p.polcmd,
         COALESCE(pg_get_expr(p.polqual, p.polrelid), '')
           || ' ' || COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '') AS expresion
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app' AND c.relname = 'movement_cost_allocations'
     AND p.polpermissive AND p.polcmd IN ('a', 'w', 'd', '*')
), de_insert AS (
  SELECT * FROM politicas WHERE polcmd = 'a'
), sobran AS (
  SELECT polname AS descripcion FROM politicas WHERE polcmd <> 'a'
), sin_funcion AS (
  SELECT polname AS descripcion FROM de_insert
   WHERE expresion NOT LIKE '%can_allocate_cost_to_movement(movement_id)%'
      OR expresion ~ '\mtrue\M'
)
SELECT pg_temp.expect_true(148,
  'Capas de costo: una sola política de escritura (INSERT), por el permiso del movimiento y sin true'
    || COALESCE(' — sobran: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM sobran), '')
    || COALESCE(' — sin la función: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM sin_funcion), ''),
  (SELECT count(*) FROM de_insert) = 1 AND NOT EXISTS (SELECT 1 FROM sobran)
  AND NOT EXISTS (SELECT 1 FROM sin_funcion));

-- 149 ─ La función que decide la política nombra todos los valores de
-- `movement_type` y los seis permisos del mapeo (el mismo del 114), pide que el
-- movimiento sea de esta transacción (`xmin`), filtra por el tenant de la
-- sesión, rechaza lo que no mapea (`ELSE false`) y solo la ejecuta `joda_api`.
-- Un valor de enum agregado después y no mapeado se rechaza (falla cerrado),
-- pero este invariante falla para obligar a decidirlo a propósito, y para que
-- el mapeo de las capas no se separe del del movimiento. El nombre lista las
-- culpables.
WITH f AS (
  SELECT p.oid, p.prosecdef, p.proconfig, p.proacl, p.proowner, p.prosrc
    FROM pg_proc p
   WHERE p.pronamespace = 'app'::regnamespace AND p.proname = 'can_allocate_cost_to_movement'
), tipos_sin_cubrir AS (
  SELECT t::text AS descripcion
    FROM unnest(enum_range(NULL::app.movement_type)) AS t, f
   WHERE f.prosrc NOT LIKE '%WHEN ''' || t::text || '''%'
), permisos_sin_usar AS (
  SELECT v.permiso AS descripcion
    FROM (VALUES ('sales.order:write'), ('inventory.stock:adjust'),
                 ('inventory.decant:execute'), ('market.purchase_order:receive'),
                 ('sales.order:refund'), ('market.purchase_order:write')) AS v(permiso), f
   WHERE f.prosrc NOT LIKE '%has_permission(''' || v.permiso || '''%'
)
SELECT pg_temp.expect_true(149,
  'La función de las capas cubre todo movement_type y los seis permisos, exige un movimiento de esta transacción y del tenant'
    || COALESCE(' — tipos sin cubrir: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM tipos_sin_cubrir), '')
    || COALESCE(' — permisos sin usar: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM permisos_sin_usar), ''),
  (SELECT count(*) FROM f) = 1
  AND (SELECT bool_and(prosecdef) FROM f)
  AND (SELECT bool_and('search_path=app, pg_temp' = ANY (COALESCE(proconfig, '{}'))) FROM f)
  AND NOT EXISTS (SELECT 1 FROM tipos_sin_cubrir)
  AND NOT EXISTS (SELECT 1 FROM permisos_sin_usar)
  AND (SELECT bool_and(prosrc LIKE '%m.xmin = pg_catalog.pg_current_xact_id()%') FROM f)
  AND (SELECT bool_and(prosrc LIKE '%m.tenant_id = app.current_tenant_id()%') FROM f)
  AND (SELECT bool_and(prosrc ~ 'ELSE\s+false') FROM f)
  AND NOT EXISTS (SELECT 1 FROM f,
                    aclexplode(COALESCE(f.proacl, acldefault('f', f.proowner))) a
                   WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
  AND (SELECT bool_and(has_function_privilege('joda_api', oid, 'EXECUTE')) FROM f));

\echo ''
\echo '=============================================================='
\echo ' INVARIANTES'
\echo '=============================================================='
SELECT n, nombre, resultado FROM results ORDER BY n;

SELECT count(*) FILTER (WHERE resultado LIKE 'OK%')    AS pasaron,
       count(*) FILTER (WHERE resultado LIKE 'FALLO%') AS fallaron,
       count(*)                                        AS total
  FROM results;
