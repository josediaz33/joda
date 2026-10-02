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
-- tres que no leen ninguna tabla (`guard_po_no_return_to_draft`, WP-B11,
-- lee solo OLD y NEW). Una función de invariante SECURITY INVOKER lee con
-- los permisos de quien dispara el trigger: si RLS le oculta la fila, decide
-- sobre un NULL (el defecto de B10 y de B09). Una función nueva que lea
-- tablas y no esté en esta lista hace fallar esto.
SELECT pg_temp.expect_true(29,
  'Toda función de disparador de app.* es SECURITY DEFINER, salvo set_updated_at/guard_append_only/guard_po_no_return_to_draft',
  NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app'
       AND p.prorettype = 'trigger'::regtype
       AND NOT p.prosecdef
       AND p.proname NOT IN ('set_updated_at', 'guard_append_only',
                             'guard_po_no_return_to_draft')
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
-- sourcing_scenarios a los invariantes 91 a 94, con una diferencia en el 93:
-- esa tabla SÍ se borra, con `market.sourcing:write`.
-- ─────────────────────────────────────────────────────────────────────

-- Los invariantes 91 a 93 leen el TEXTO de las políticas (pg_get_expr): no
-- pueden probar que la política haga lo que dice, solo que no se la reemplazó
-- por una que ni lo intenta. Que lo haga lo prueba, con cada rol conectado
-- como joda_api, write_permissions.test.ts.

-- 91 ─ Toda política permisiva de escritura (INSERT, UPDATE, DELETE o ALL)
-- de esas seis tablas exige un permiso, y cada una tiene las de INSERT y
-- UPDATE. Con la `tenant_access_*` con `true` de 0016 la escritura vuelve a
-- pedir solo tenant; un `true OR has_permission(..)` tampoco cuenta como
-- exigir un permiso. El nombre lista las políticas culpables y las tablas a
-- las que les falta la de INSERT o la de UPDATE.
WITH sensibles(tabla) AS (
  VALUES ('suppliers'), ('purchase_orders'), ('inventory_lots'),
         ('chart_of_accounts'), ('customer_deposits'), ('sourcing_scenarios')
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
)
SELECT pg_temp.expect_true(91,
  'Escribir en las tablas sensibles exige un permiso, no solo tenant'
    || COALESCE(' — sin permiso: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM sin_permiso), '')
    || COALESCE(' — sin política: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM falta), ''),
  NOT EXISTS (SELECT 1 FROM sin_permiso) AND NOT EXISTS (SELECT 1 FROM falta));

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
                       'chart_of_accounts', 'customer_deposits', 'sourcing_scenarios')
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
-- sourcing_scenarios (WP-B11b) hay también una sola, con
-- `market.sourcing:write` y sin más condición: un escenario es una
-- simulación y se borra. El nombre lista las políticas de DELETE que sobran,
-- o avisa que la de órdenes o la de escenarios no es la esperada.
WITH borrado AS (
  SELECT c.relname AS tabla, p.polname,
         COALESCE(pg_get_expr(p.polqual, p.polrelid), '') AS expresion
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app'
     AND c.relname IN ('suppliers', 'purchase_orders', 'inventory_lots',
                       'chart_of_accounts', 'customer_deposits', 'sourcing_scenarios')
     AND p.polpermissive
     AND p.polcmd IN ('d', '*')
), sobran AS (
  SELECT tabla || '.' || polname AS descripcion
    FROM borrado WHERE tabla NOT IN ('purchase_orders', 'sourcing_scenarios')
), orden_ok AS (
  SELECT count(*) AS n
    FROM borrado
   WHERE tabla = 'purchase_orders'
     AND expresion LIKE '%market.purchase_order:write%'
     AND expresion LIKE '%(status = ''draft''%'
     AND expresion NOT LIKE '% OR %'
), escenario_ok AS (
  SELECT count(*) AS n
    FROM borrado
   WHERE tabla = 'sourcing_scenarios'
     AND expresion LIKE '%market.sourcing:write%'
     AND expresion NOT LIKE '% OR %'
     AND expresion NOT LIKE '% AND %'
)
SELECT pg_temp.expect_true(93,
  'Sin DELETE en lotes, señas, cuentas y proveedores; en órdenes de compra, solo borradores; en escenarios de sourcing, con su permiso'
    || COALESCE(' — DELETE que sobra: '
                || (SELECT string_agg(descripcion, ', ' ORDER BY descripcion) FROM sobran), '')
    || CASE WHEN (SELECT n FROM orden_ok) = 1
             AND (SELECT count(*) FROM borrado WHERE tabla = 'purchase_orders') = 1
            THEN '' ELSE ' — la política de DELETE de purchase_orders no es la esperada' END
    || CASE WHEN (SELECT n FROM escenario_ok) = 1
             AND (SELECT count(*) FROM borrado WHERE tabla = 'sourcing_scenarios') = 1
            THEN '' ELSE ' — la política de DELETE de sourcing_scenarios no es la esperada' END,
  NOT EXISTS (SELECT 1 FROM sobran)
  AND (SELECT n FROM orden_ok) = 1
  AND (SELECT count(*) FROM borrado WHERE tabla = 'purchase_orders') = 1
  AND (SELECT n FROM escenario_ok) = 1
  AND (SELECT count(*) FROM borrado WHERE tabla = 'sourcing_scenarios') = 1);

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
    ('sourcing_scenarios', 'market.sourcing:write',         'market.sourcing:read')
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
     AND NOT (r.code = 'deposito' AND p.tabla = 'purchase_orders'
              AND p.escribe = 'market.purchase_order:receive')
)
SELECT pg_temp.expect_true(94,
  'Ningún rol sembrado escribe en una tabla sensible sin poder leerla (salvo depósito en órdenes, WP-C15)'
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

\echo ''
\echo '=============================================================='
\echo ' INVARIANTES'
\echo '=============================================================='
SELECT n, nombre, resultado FROM results ORDER BY n;

SELECT count(*) FILTER (WHERE resultado LIKE 'OK%')    AS pasaron,
       count(*) FILTER (WHERE resultado LIKE 'FALLO%') AS fallaron,
       count(*)                                        AS total
  FROM results;
