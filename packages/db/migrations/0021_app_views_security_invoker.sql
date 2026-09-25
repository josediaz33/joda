-- =====================================================================
-- 0021_app_views_security_invoker.sql  (WP-B12)
--
-- DEFECTO. Una vista de Postgres corre, por defecto, con los privilegios
-- de su DUEÑO: el rol que corrió las migraciones, que elude RLS. Las cuatro
-- vistas de `app.*` le devolvían a `joda_api` filas de TODOS los tenants,
-- sin mirar el contexto. Lo demostró la revisión cruzada de B10 con
-- `v_trial_balance`: sin tenant ni usuario en contexto, `joda_api` leía el
-- balance completo.
--
-- CORRECCIÓN. `security_invoker = true`: las tablas de abajo se leen con
-- los permisos de quien consulta la vista, y RLS se evalúa como en una
-- consulta directa. Vale para tres de las cuatro:
--   · v_trial_balance — exige además `accounting.journal:read`
--     (políticas de journal_entries y chart_of_accounts), igual que leer
--     los asientos directamente.
--   · v_balance_drift — lee `inventory_lots` y exige
--     `inventory.stock:read`. OJO, ver abajo.
--   · v_decant_yield — solo tenant.
--
-- `public.v_catalog_*` son la EXCEPCIÓN DELIBERADA y no se tocan: corren
-- como su dueño a propósito, para que `joda_readonly` (sin RLS de tenant ni
-- permisos sobre `app`) vea el catálogo publicado.
--
-- v_stock_available QUEDA COMO ESTABA, y es una decisión pendiente, no un
-- olvido. `public.v_catalog_variants` la consume para calcular
-- `in_stock`. Una vista `security_invoker` anidada dentro de una vista que
-- corre como su dueño NO hereda los permisos de ese dueño: se evalúa con
-- los del usuario que ejecuta la consulta. Verificado en
-- `rls_isolation.test.ts` al escribir este WP: con `v_stock_available`
-- invoker, `joda_readonly` recibía `permission denied for table
-- inventory_balances` y el storefront se quedaba sin disponibilidad.
-- Corregirla exige tocar `v_catalog_variants` (apuntarla a una vista
-- interna que corra como su dueño, sin GRANT a `joda_api`) o aceptar la
-- fuga. Queda en WP-B12b, para que lo decida José: el WP pidió
-- explícitamente no tocar `public.v_catalog_*`. Mientras tanto
-- `joda_api` sigue viendo el saldo por variante de todos los tenants a
-- través de esta vista. Un test de comportamiento conocido lo deja
-- escrito, y el invariante 63 la exceptúa por nombre.
--
-- v_balance_drift Y EL FALLO ABIERTO DEL MONITOREO. "Debe devolver cero
-- filas", y con `security_invoker` cero filas también es lo que devuelve
-- a quien no ve los lotes: sin tenant, sin `inventory.stock:read`, o con
-- otro tenant. Un chequeo de deriva que corra así da verde siempre. Quien
-- la consulte para decidir si hay deriva tiene que verlo todo: el rol de
-- migraciones/CI, que elude RLS (así la usa `smoke_business_flow.sql`), o
-- un contexto con tenant y `inventory.stock:read` que además verifique que
-- ve lotes. Dejarla como estaba no era alternativa: le mostraba a
-- `joda_api` saldos de todos los tenants.
--
-- v_trial_balance CONTABA SOLO 'posted'. Hasta WP-B14 ningún asiento
-- llegaba a 'reversed'. Desde B14, revertir un asiento deja el original en
-- 'reversed' y la reversión en 'posted': con el filtro viejo el original
-- desaparecía del balance, la reversión quedaba sola y el balance mostraba
-- el importe invertido en vez de cero. Se cuentan los dos: se compensan,
-- que es para lo que existe la reversión (RN-CTB-06). Contar solo 'posted'
-- era el único criterio incorrecto; contar ninguno de los dos daría el
-- mismo total, pero borraría el rastro. El invariante 64 lo verifica.
-- La compensación vale en el TOTAL, no por período: si la reversión cae en
-- un período posterior, el período original conserva el asiento y la
-- reversión impacta en el suyo. Es lo correcto, porque un período cerrado
-- no se reescribe; con el filtro viejo, el original desaparecía
-- retroactivamente de su período. El invariante 65 lo fija.
-- =====================================================================
SET search_path = app, public;

ALTER VIEW app.v_balance_drift   SET (security_invoker = true);
ALTER VIEW app.v_decant_yield    SET (security_invoker = true);

CREATE OR REPLACE VIEW app.v_trial_balance
WITH (security_invoker = true) AS
SELECT
  je.tenant_id,
  je.period_id,
  coa.id           AS account_id,
  coa.code         AS account_code,
  coa.name         AS account_name,
  coa.account_type,
  sum(jl.debit_pyg)  AS total_debit_pyg,
  sum(jl.credit_pyg) AS total_credit_pyg,
  CASE WHEN coa.account_type IN ('asset', 'expense')
       THEN sum(jl.debit_pyg) - sum(jl.credit_pyg)
       ELSE sum(jl.credit_pyg) - sum(jl.debit_pyg)
  END AS balance_pyg
FROM app.journal_lines jl
JOIN app.journal_entries je    ON je.id = jl.entry_id AND je.status IN ('posted', 'reversed')
JOIN app.chart_of_accounts coa ON coa.id = jl.account_id
GROUP BY je.tenant_id, je.period_id, coa.id, coa.code, coa.name, coa.account_type;
