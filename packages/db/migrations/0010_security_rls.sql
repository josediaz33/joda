-- =====================================================================
-- 0010_security_rls.sql
--
-- CORRECCIÓN CRÍTICA respecto de v3: si la API se conecta con una
-- credencial privilegiada (service_role de Supabase, o el owner de las
-- tablas), RLS NO SE EVALÚA y toda la "última línea de defensa" es
-- decorativa.
--
-- Por eso:
--   · joda_api      → rol de aplicación, NOBYPASSRLS, sin UPDATE/DELETE
--                     sobre el ledger ni sobre la auditoría.
--   · joda_readonly → lectura del catálogo público para el storefront.
--   · service_role  → EXCLUSIVAMENTE migraciones y ETL, desde CI, nunca
--                     desde el proceso que atiende requests.
-- =====================================================================
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'joda_api') THEN
    CREATE ROLE joda_api LOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'joda_readonly') THEN
    CREATE ROLE joda_readonly LOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA app TO joda_api, joda_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO joda_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO joda_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO joda_api;

-- Ni siquiera la API puede reescribir la historia.
REVOKE UPDATE, DELETE ON app.inventory_movements       FROM joda_api;
REVOKE UPDATE, DELETE ON app.movement_cost_allocations FROM joda_api;
REVOKE UPDATE, DELETE ON app.audit_log                 FROM joda_api;
REVOKE UPDATE, DELETE ON app.fiscal_events             FROM joda_api;
REVOKE        DELETE ON app.journal_entries            FROM joda_api;

-- ---------------------------------------------------------------------
-- RLS: aislamiento por tenant en toda tabla que lo tenga.
-- FORCE, para que aplique incluso al owner de las tablas.
-- ---------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'app'
       AND c.relkind = 'r'
       AND a.attname = 'tenant_id'
       AND NOT a.attisdropped
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', r.relname);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON app.%I
        USING (tenant_id = app.current_tenant_id())
        WITH CHECK (tenant_id = app.current_tenant_id())
    $f$, r.relname);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Políticas de permiso sobre los módulos que un cliente jamás debe tocar.
-- Deny-by-default: sin política que lo habilite, no hay lectura.
-- ---------------------------------------------------------------------
CREATE POLICY accounting_read ON app.journal_entries
  FOR SELECT USING (app.has_permission('accounting.journal:read'));
CREATE POLICY accounting_write ON app.journal_entries
  FOR INSERT WITH CHECK (app.has_permission('accounting.journal:write'));

CREATE POLICY coa_read ON app.chart_of_accounts
  FOR SELECT USING (app.has_permission('accounting.journal:read'));

CREATE POLICY deposits_read ON app.customer_deposits
  FOR SELECT USING (app.has_permission('accounting.deposit:read'));

CREATE POLICY sourcing_read ON app.sourcing_scenarios
  FOR SELECT USING (app.has_permission('market.sourcing:read'));
CREATE POLICY sourcing_write ON app.sourcing_scenarios
  FOR INSERT WITH CHECK (app.has_permission('market.sourcing:write'));

CREATE POLICY suppliers_read ON app.suppliers
  FOR SELECT USING (app.has_permission('market.supplier:read'));

CREATE POLICY po_read ON app.purchase_orders
  FOR SELECT USING (app.has_permission('market.purchase_order:read'));

-- Los costos de lote son información de proveedor: nunca salen al público.
CREATE POLICY lots_read ON app.inventory_lots
  FOR SELECT USING (app.has_permission('inventory.stock:read'));

-- ---------------------------------------------------------------------
-- Catálogo público
--
-- El storefront NO lee tablas base: lee vistas estables. Si leyera tablas,
-- el esquema interno se convertiría en API pública y no se podría
-- refactorizar nada. La vista se define con security_invoker = false
-- (default), de modo que corre con los privilegios de su dueño y expone
-- únicamente lo publicado.
-- ---------------------------------------------------------------------
CREATE VIEW public.v_catalog_products AS
SELECT
  p.id,
  p.tenant_id,
  p.kind,
  p.slug,
  p.name,
  p.description,
  p.facets,
  b.name  AS brand_name,
  b.slug  AS brand_slug,
  p.published_at
FROM app.products p
LEFT JOIN app.brands b ON b.id = p.brand_id
WHERE p.status = 'active' AND p.published_at IS NOT NULL;

CREATE VIEW public.v_catalog_variants AS
SELECT
  v.id,
  v.tenant_id,
  v.product_id,
  v.sku,
  v.variant_type,
  v.uom,
  v.size_ml,
  v.price_pyg,
  v.compare_at_pyg,
  -- Se expone disponibilidad booleana, nunca la cantidad exacta: el stock
  -- es información competitiva.
  (COALESCE(s.available, 0) > 0) AS in_stock
FROM app.product_variants v
JOIN app.products p ON p.id = v.product_id
LEFT JOIN app.v_stock_available s ON s.variant_id = v.id
WHERE v.online_visible
  AND p.status = 'active'
  AND p.published_at IS NOT NULL;

GRANT SELECT ON public.v_catalog_products, public.v_catalog_variants TO joda_readonly;
