-- =====================================================================
-- 0014_rls_sweep.sql — WP-B08: toda tabla de app.* con RLS, o justificada
--
-- Motivado por el hallazgo de la revisión cruzada de WP-C09 (docs/backlog.md):
-- `product_media` no tenía `tenant_id`, así que quedaba FUERA del bucle que
-- 0010_security_rls.sql habilita automáticamente (recorre columnas
-- `tenant_id`; sin esa columna, no hay política). La FK `product_id →
-- products.id` no compensaba eso: los checks de integridad referencial de
-- Postgres se evalúan con privilegio interno, sin pasar por RLS — un
-- `product_id` de OTRO tenant pasa la FK igual. `apps/api` lo corrigió con
-- una verificación explícita en el servicio (`modules/media/repository.ts`,
-- `productExistsForTenant`), pero eso protege UN callsite, no la tabla.
--
-- Esta migración agrega `tenant_id` a TODA tabla de `app.*` que dependía del
-- tenant solo por una FK transitiva — el mismo patrón de vulnerabilidad que
-- `product_media`, aplicado sistemáticamente — y deja que el bucle de RLS
-- (repetido más abajo, con `NOT c.relrowsecurity` para no tocar lo que ya
-- estaba protegido) las alcance. Es defensa en profundidad, no un reemplazo
-- de la verificación a nivel de servicio: RLS evita que una fila de OTRO
-- tenant sea legible/escribible bajo el contexto de este, pero no evita por
-- sí sola que alguien INSERTE una fila propia que referencia un `id` ajeno
-- por FK (para eso sigue haciendo falta el `findX`-antes-de-insertar de
-- WP-C09, tabla por tabla, en el WP que construya cada módulo).
--
-- DOS EXCEPCIONES, sin `tenant_id` ni RLS, por diseño — no un olvido:
--
--   · `permissions` — catálogo GLOBAL de códigos de permiso
--     (docs/security-spec.md §2), el mismo para todos los tenants. No hay
--     tenant al que asignárselo: no es dato de ningún tenant en particular,
--     es el vocabulario común que `role_permissions` (sí protegida, más
--     abajo) referencia.
--   · `tenants` — la tabla que DEFINE los tenants no puede tener su propio
--     `tenant_id` (sería circular). Recibe su propia política, más abajo,
--     en vez de entrar al bucle automático.
--
-- La prueba de regresión (packages/db/tests/invariants.sql, invariante 22)
-- falla si aparece una tabla nueva de `app.*` sin RLS y sin estar en esta
-- lista de dos — así esto no se puede repetir por olvido.
-- =====================================================================
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- Catálogo — detalle CTI y asociaciones producto↔categoría/tag/medio.
-- Mismo patrón que product_variants/bom_components/media, que ya tenían
-- tenant_id propio desde 0003_catalog.sql.
-- ---------------------------------------------------------------------
ALTER TABLE accessory_details ADD COLUMN tenant_id uuid;
UPDATE accessory_details ad SET tenant_id = p.tenant_id
  FROM products p WHERE p.id = ad.product_id;
ALTER TABLE accessory_details ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE accessory_details
  ADD CONSTRAINT accessory_details_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE perfume_details ADD COLUMN tenant_id uuid;
UPDATE perfume_details pd SET tenant_id = p.tenant_id
  FROM products p WHERE p.id = pd.product_id;
ALTER TABLE perfume_details ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE perfume_details
  ADD CONSTRAINT perfume_details_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE watch_details ADD COLUMN tenant_id uuid;
UPDATE watch_details wd SET tenant_id = p.tenant_id
  FROM products p WHERE p.id = wd.product_id;
ALTER TABLE watch_details ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE watch_details
  ADD CONSTRAINT watch_details_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE product_categories ADD COLUMN tenant_id uuid;
UPDATE product_categories pc SET tenant_id = p.tenant_id
  FROM products p WHERE p.id = pc.product_id;
ALTER TABLE product_categories ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE product_categories
  ADD CONSTRAINT product_categories_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE product_tags ADD COLUMN tenant_id uuid;
UPDATE product_tags pt SET tenant_id = p.tenant_id
  FROM products p WHERE p.id = pt.product_id;
ALTER TABLE product_tags ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE product_tags
  ADD CONSTRAINT product_tags_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- product_media: la tabla que originó este WP (revisión cruzada de C09).
ALTER TABLE product_media ADD COLUMN tenant_id uuid;
UPDATE product_media pm SET tenant_id = p.tenant_id
  FROM products p WHERE p.id = pm.product_id;
ALTER TABLE product_media ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE product_media
  ADD CONSTRAINT product_media_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------
-- Ventas — sale_orders ya tenía tenant_id; sus líneas y transiciones no.
-- ---------------------------------------------------------------------
ALTER TABLE sale_order_lines ADD COLUMN tenant_id uuid;
UPDATE sale_order_lines sol SET tenant_id = so.tenant_id
  FROM sale_orders so WHERE so.id = sol.sale_order_id;
ALTER TABLE sale_order_lines ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sale_order_lines
  ADD CONSTRAINT sale_order_lines_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE sale_order_transitions ADD COLUMN tenant_id uuid;
UPDATE sale_order_transitions sot SET tenant_id = so.tenant_id
  FROM sale_orders so WHERE so.id = sot.sale_order_id;
ALTER TABLE sale_order_transitions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sale_order_transitions
  ADD CONSTRAINT sale_order_transitions_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE return_items ADD COLUMN tenant_id uuid;
UPDATE return_items ri SET tenant_id = r.tenant_id
  FROM returns r WHERE r.id = ri.return_id;
ALTER TABLE return_items ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE return_items
  ADD CONSTRAINT return_items_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE customer_addresses ADD COLUMN tenant_id uuid;
UPDATE customer_addresses ca SET tenant_id = c.tenant_id
  FROM customers c WHERE c.id = ca.customer_id;
ALTER TABLE customer_addresses ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE customer_addresses
  ADD CONSTRAINT customer_addresses_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE customer_deposit_applications ADD COLUMN tenant_id uuid;
UPDATE customer_deposit_applications cda SET tenant_id = cd.tenant_id
  FROM customer_deposits cd WHERE cd.id = cda.deposit_id;
ALTER TABLE customer_deposit_applications ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE customer_deposit_applications
  ADD CONSTRAINT customer_deposit_applications_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE channel_listings ADD COLUMN tenant_id uuid;
UPDATE channel_listings cl SET tenant_id = sc.tenant_id
  FROM sales_channels sc WHERE sc.id = cl.channel_id;
ALTER TABLE channel_listings ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE channel_listings
  ADD CONSTRAINT channel_listings_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------
-- Compras — purchase_orders/goods_receipts ya tenían tenant_id; sus
-- líneas y transiciones no.
-- ---------------------------------------------------------------------
ALTER TABLE purchase_order_lines ADD COLUMN tenant_id uuid;
UPDATE purchase_order_lines pol SET tenant_id = po.tenant_id
  FROM purchase_orders po WHERE po.id = pol.purchase_order_id;
ALTER TABLE purchase_order_lines ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE purchase_order_lines
  ADD CONSTRAINT purchase_order_lines_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE purchase_order_transitions ADD COLUMN tenant_id uuid;
UPDATE purchase_order_transitions pot SET tenant_id = po.tenant_id
  FROM purchase_orders po WHERE po.id = pot.purchase_order_id;
ALTER TABLE purchase_order_transitions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE purchase_order_transitions
  ADD CONSTRAINT purchase_order_transitions_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE goods_receipt_lines ADD COLUMN tenant_id uuid;
UPDATE goods_receipt_lines grl SET tenant_id = gr.tenant_id
  FROM goods_receipts gr WHERE gr.id = grl.goods_receipt_id;
ALTER TABLE goods_receipt_lines ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE goods_receipt_lines
  ADD CONSTRAINT goods_receipt_lines_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE supplier_contacts ADD COLUMN tenant_id uuid;
UPDATE supplier_contacts sc SET tenant_id = s.tenant_id
  FROM suppliers s WHERE s.id = sc.supplier_id;
ALTER TABLE supplier_contacts ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE supplier_contacts
  ADD CONSTRAINT supplier_contacts_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE sourcing_scenario_lines ADD COLUMN tenant_id uuid;
UPDATE sourcing_scenario_lines ssl SET tenant_id = ss.tenant_id
  FROM sourcing_scenarios ss WHERE ss.id = ssl.scenario_id;
ALTER TABLE sourcing_scenario_lines ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sourcing_scenario_lines
  ADD CONSTRAINT sourcing_scenario_lines_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------
-- Inventario y contabilidad — inventory_movements/journal_entries ya
-- tenían tenant_id; sus capas de costo y líneas de asiento no.
-- ---------------------------------------------------------------------
ALTER TABLE movement_cost_allocations ADD COLUMN tenant_id uuid;
UPDATE movement_cost_allocations mca SET tenant_id = im.tenant_id
  FROM inventory_movements im WHERE im.id = mca.movement_id;
ALTER TABLE movement_cost_allocations ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE movement_cost_allocations
  ADD CONSTRAINT movement_cost_allocations_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE journal_lines ADD COLUMN tenant_id uuid;
UPDATE journal_lines jl SET tenant_id = je.tenant_id
  FROM journal_entries je WHERE je.id = jl.entry_id;
ALTER TABLE journal_lines ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE journal_lines
  ADD CONSTRAINT journal_lines_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------
-- Fiscal — fiscal_documents ya tenía tenant_id; sus líneas y eventos no.
-- ---------------------------------------------------------------------
ALTER TABLE fiscal_document_lines ADD COLUMN tenant_id uuid;
UPDATE fiscal_document_lines fdl SET tenant_id = fd.tenant_id
  FROM fiscal_documents fd WHERE fd.id = fdl.fiscal_document_id;
ALTER TABLE fiscal_document_lines ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE fiscal_document_lines
  ADD CONSTRAINT fiscal_document_lines_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE fiscal_events ADD COLUMN tenant_id uuid;
UPDATE fiscal_events fe SET tenant_id = fd.tenant_id
  FROM fiscal_documents fd WHERE fd.id = fe.fiscal_document_id;
ALTER TABLE fiscal_events ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE fiscal_events
  ADD CONSTRAINT fiscal_events_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------
-- Identidad y permisos — roles/staff_users ya tenían tenant_id;
-- role_permissions/staff_user_roles no (apps/api/src/modules/auth/repository.ts
-- ya documentaba esto como una dependencia transitiva, no una decisión).
-- `permission_code` referencia el catálogo GLOBAL `permissions` — no
-- necesita su propio tenant_id, ya lo tiene por `role_id`.
-- ---------------------------------------------------------------------
ALTER TABLE role_permissions ADD COLUMN tenant_id uuid;
UPDATE role_permissions rp SET tenant_id = r.tenant_id
  FROM roles r WHERE r.id = rp.role_id;
ALTER TABLE role_permissions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE role_permissions
  ADD CONSTRAINT role_permissions_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE staff_user_roles ADD COLUMN tenant_id uuid;
UPDATE staff_user_roles sur SET tenant_id = su.tenant_id
  FROM staff_users su WHERE su.id = sur.staff_user_id;
ALTER TABLE staff_user_roles ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE staff_user_roles
  ADD CONSTRAINT staff_user_roles_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------
-- RLS: mismo bucle que 0010_security_rls.sql, repetido acá a propósito
-- (no se edita una migración ya aplicada). `NOT c.relrowsecurity` hace
-- que solo alcance a las columnas `tenant_id` que se acaban de agregar
-- arriba — cualquier tabla ya protegida queda intacta.
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
       AND NOT c.relrowsecurity
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
-- tenants: no tiene tenant_id propio (sería circular) — política propia,
-- un tenant solo ve/edita su propia fila. FORCE para que aplique incluso
-- al owner de las tablas, mismo criterio que 0010_security_rls.sql.
--
-- Ningún código de aplicación consulta `tenants` hoy (login resuelve el
-- tenant vía `staff_users`, nunca vía esta tabla — ver el comentario de
-- `findStaffLoginByEmail`, apps/api/src/modules/auth/repository.ts). Si
-- algún día hace falta leer `tenants` ANTES de que exista contexto de
-- tenant (por ejemplo, onboarding de un tenant nuevo), el patrón ya
-- existe: una función `SECURITY DEFINER` como `app.find_staff_login_by_email`
-- (packages/db/migrations/0011_staff_sessions.sql), que evalúa con el
-- privilegio de quien la definió, no de `joda_api` — no relajar esta
-- política para resolver ese caso.
-- ---------------------------------------------------------------------
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());

-- `permissions` queda sin RLS a propósito: ver el comentario del
-- encabezado. Es el catálogo global, no dato de tenant.
