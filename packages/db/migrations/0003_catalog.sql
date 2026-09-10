-- =====================================================================
-- 0003_catalog.sql — catálogo multicategoría
--   Núcleo (products) + detalles tipados por vertical (CTI)
--   + facetas JSONB para descubrimiento
--   + categorías comerciales N:N jerárquicas + tags transversales
-- =====================================================================
SET search_path = app, public;

CREATE TABLE brands (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug        citext NOT NULL,
  name        text NOT NULL,
  country     char(2),
  logo_media_id uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

-- Categorías COMERCIALES: árbol de navegación, breadcrumbs y SEO.
-- No confundir con product_kind, que es clasificación de COMPORTAMIENTO.
CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id   uuid REFERENCES categories(id) ON DELETE RESTRICT,
  slug        citext NOT NULL,
  name        text NOT NULL,
  path        text NOT NULL,             -- materialized path: 'perfumeria/nicho'
  position    int NOT NULL DEFAULT 0,
  is_visible  boolean NOT NULL DEFAULT true,
  seo         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug),
  UNIQUE (tenant_id, path),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX categories_parent ON categories (tenant_id, parent_id, position);

CREATE TABLE tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug       citext NOT NULL,
  name       text NOT NULL,
  kind       text NOT NULL DEFAULT 'marketing',   -- marketing | coleccion | badge
  UNIQUE (tenant_id, slug)
);

-- ---------------------------------------------------------------------
-- Núcleo del producto
-- ---------------------------------------------------------------------
CREATE TABLE products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind          product_kind NOT NULL,
  brand_id      uuid REFERENCES brands(id) ON DELETE RESTRICT,
  slug          citext NOT NULL,
  name          text NOT NULL,
  description   text,
  status        product_status NOT NULL DEFAULT 'draft',
  seo           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Proyección de descubrimiento: la mantiene la capa de servicio y la
  -- verifica un job nocturno. No lleva reglas de negocio.
  facets        jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_vector tsvector GENERATED ALWAYS AS (
                  to_tsvector('spanish',
                    coalesce(name, '') || ' ' || coalesce(description, ''))
                ) STORED,
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug),
  -- Habilita la FK compuesta que impide que un 'watch' tenga perfume_details.
  UNIQUE (id, kind)
);

CREATE INDEX products_facets_gin  ON products USING gin (facets jsonb_path_ops);
CREATE INDEX products_search_gin  ON products USING gin (search_vector);
CREATE INDEX products_tenant_kind ON products (tenant_id, kind, status);

CREATE TABLE product_categories (
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  is_primary  boolean NOT NULL DEFAULT false,   -- la que arma el breadcrumb
  PRIMARY KEY (product_id, category_id)
);
-- Exactamente una categoría primaria por producto.
CREATE UNIQUE INDEX product_categories_one_primary
  ON product_categories (product_id) WHERE is_primary;

CREATE TABLE product_tags (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tag_id     uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, tag_id)
);

-- ---------------------------------------------------------------------
-- Detalles por vertical (Class Table Inheritance)
-- Acá viven SOLO los atributos que participan en reglas de negocio.
-- Lo puramente descriptivo va a products.facets.
-- ---------------------------------------------------------------------
CREATE TABLE perfume_details (
  product_id          uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  kind                product_kind NOT NULL DEFAULT 'perfume'
                        CHECK (kind = 'perfume'),
  concentration       perfume_concentration NOT NULL,
  nominal_volume_ml   numeric(8,2) NOT NULL CHECK (nominal_volume_ml > 0),
  olfactory_family    text NOT NULL,
  notes_top           text[] NOT NULL DEFAULT '{}',
  notes_heart         text[] NOT NULL DEFAULT '{}',
  notes_base          text[] NOT NULL DEFAULT '{}',
  is_decantable       boolean NOT NULL DEFAULT true,
  -- Merma en TRES componentes: proporcional, fija por frasco, y por tiempo.
  waste_factor        numeric(6,5) NOT NULL DEFAULT 0.02000
                        CHECK (waste_factor >= 0 AND waste_factor < 0.5),
  unusable_residue_ml numeric(8,3) NOT NULL DEFAULT 2.000
                        CHECK (unusable_residue_ml >= 0),
  evaporation_ml_year numeric(8,3) NOT NULL DEFAULT 0.000
                        CHECK (evaporation_ml_year >= 0),
  FOREIGN KEY (product_id, kind) REFERENCES products(id, kind)
);

CREATE TABLE watch_details (
  product_id         uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  kind               product_kind NOT NULL DEFAULT 'watch'
                       CHECK (kind = 'watch'),
  movement           watch_movement NOT NULL,
  case_material      text NOT NULL,
  case_diameter_mm   numeric(5,2) CHECK (case_diameter_mm > 0),
  water_resistance_m integer CHECK (water_resistance_m >= 0),
  strap_material     text,
  crystal            text,
  warranty_months    integer NOT NULL DEFAULT 12 CHECK (warranty_months >= 0),
  requires_serial    boolean NOT NULL DEFAULT true,
  FOREIGN KEY (product_id, kind) REFERENCES products(id, kind)
);

CREATE TABLE accessory_details (
  product_id   uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  kind         product_kind NOT NULL DEFAULT 'accessory'
                 CHECK (kind = 'accessory'),
  material     text,
  color        text,
  size_label   text,
  FOREIGN KEY (product_id, kind) REFERENCES products(id, kind)
);

-- ---------------------------------------------------------------------
-- Variantes: la unidad vendible y la unidad de inventario
-- ---------------------------------------------------------------------
CREATE TABLE product_variants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id        uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku               citext NOT NULL,
  variant_type      variant_type NOT NULL,
  uom               uom NOT NULL,
  size_ml           numeric(8,2) CHECK (size_ml IS NULL OR size_ml > 0),
  price_pyg         pyg NOT NULL CHECK (price_pyg >= 0),
  compare_at_pyg    pyg CHECK (compare_at_pyg IS NULL OR compare_at_pyg >= 0),
  vat_rate          vat_rate NOT NULL DEFAULT 'iva_10',
  allocation_policy allocation_policy NOT NULL DEFAULT 'fifo',
  production_mode   production_mode NOT NULL DEFAULT 'stocked',
  -- Para variantes made_to_order: de qué granel se sirven.
  source_variant_id uuid REFERENCES product_variants(id) ON DELETE RESTRICT,
  is_serialized     boolean NOT NULL DEFAULT false,
  online_visible    boolean NOT NULL DEFAULT false,
  min_stock_alert   qty,
  weight_g          numeric(10,2),
  position          int NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku),
  -- Fraccionables y sellados llevan volumen; unidades y suministros no.
  CHECK (
    (variant_type IN ('sealed', 'decant', 'tester') AND size_ml IS NOT NULL)
    OR (variant_type IN ('unit', 'supply', 'bulk') AND size_ml IS NULL)
  ),
  -- Decants y granel se miden en ml; todo lo demás en unidades.
  CHECK ((variant_type IN ('decant', 'bulk') AND uom = 'ml') OR uom = 'unit'),
  -- Una variante bajo pedido tiene que declarar de qué granel sale.
  CHECK (production_mode = 'stocked' OR source_variant_id IS NOT NULL),
  -- Serialización solo tiene sentido sobre unidades enteras.
  CHECK (NOT is_serialized OR uom = 'unit')
);
CREATE INDEX variants_product ON product_variants (product_id, position);
CREATE INDEX variants_online  ON product_variants (tenant_id, online_visible)
  WHERE online_visible;

-- ---------------------------------------------------------------------
-- BOM: lo que consume producir una unidad vendible.
-- Un decant de 10 ml consume líquido + frasco + atomizador + etiqueta.
-- Sin esto, el margen del decant está sistemáticamente sobreestimado.
-- ---------------------------------------------------------------------
CREATE TABLE bom_components (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_variant_id  uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  component_variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  qty_per_unit       qty NOT NULL CHECK (qty_per_unit > 0),
  uom                uom NOT NULL,
  is_optional        boolean NOT NULL DEFAULT false,
  notes              text,
  UNIQUE (parent_variant_id, component_variant_id),
  CHECK (parent_variant_id <> component_variant_id)
);

-- ---------------------------------------------------------------------
-- Media: nunca más base64 en la base de datos
-- ---------------------------------------------------------------------
CREATE TABLE media (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sha256       char(64) NOT NULL,        -- deduplicación
  bucket       text NOT NULL,            -- 'public-catalog' | 'private-docs'
  object_key   text NOT NULL,
  mime_type    text NOT NULL,
  width        int,
  height       int,
  bytes        bigint NOT NULL CHECK (bytes > 0),
  is_public    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sha256)
);

CREATE TABLE product_media (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  media_id   uuid NOT NULL REFERENCES media(id) ON DELETE RESTRICT,
  variant_id uuid REFERENCES product_variants(id) ON DELETE CASCADE,
  position   int NOT NULL DEFAULT 0,
  alt_text   text,
  PRIMARY KEY (product_id, media_id)
);

ALTER TABLE brands
  ADD CONSTRAINT brands_logo_fk FOREIGN KEY (logo_media_id) REFERENCES media(id);

CREATE TRIGGER trg_products_updated BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER trg_variants_updated BEFORE UPDATE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
