-- =====================================================================
-- 0022_stock_available_invoker.sql  (WP-B12b)
--
-- DEFECTO. `app.v_stock_available` corría como su dueño, que elude RLS:
-- `joda_api` leía el saldo por variante de TODOS los tenants, sin
-- contexto. 0021 no pudo volverla `security_invoker` porque
-- `public.v_catalog_variants` la consumía, y una vista invoker anidada se
-- evalúa con los permisos de quien consulta: `joda_readonly` recibía
-- `permission denied for table inventory_balances` y el storefront se
-- quedaba sin disponibilidad.
--
-- CORRECCIÓN (decisión de José, 2026-09-25):
--   · `v_stock_available` pasa a `security_invoker`. `joda_api` ve solo
--     el saldo de su tenant, igual que en una consulta directa a
--     `inventory_balances` y `stock_reservations` (las dos exigen solo
--     tenant, no permiso: el vendedor la sigue viendo, como la usa C10).
--   · `v_catalog_variants` deja de leerla y calcula la disponibilidad
--     desde su propia fuente: un LATERAL sobre `inventory_balances` y
--     `stock_reservations` dentro de la misma vista. Sigue corriendo como
--     su dueño (no es invoker), con las mismas columnas y el mismo GRANT a
--     `joda_readonly`. La regla de 0010/0021 era no volver invoker a las
--     `v_catalog_*`, no prohibir cambiar de dónde leen.
--
-- POR QUÉ UN LATERAL Y NO UNA VISTA INTERNA NUEVA. Una vista interna que
-- corra como su dueño es otro objeto de `app.*` que elude RLS: el
-- `ALTER DEFAULT PRIVILEGES` de 0010 le da SELECT a `joda_api` al crearla
-- (habría que revocarlo a mano, y el próximo que la recree lo pierde), y
-- el invariante 63 tendría que exceptuarla por nombre. El LATERAL no crea
-- nada que `joda_api` pueda leer: la única puerta es `v_catalog_variants`,
-- que `joda_api` no tiene concedida.
--
-- COSTO: la fórmula "saldo − reservas vivas" queda escrita dos veces.
-- El invariante 66 compara las dos para toda variante publicada: si
-- alguien cambia una sin la otra (por ejemplo, excluir lotes en
-- cuarentena), falla.
-- =====================================================================
SET search_path = app, public;

ALTER VIEW app.v_stock_available SET (security_invoker = true);

-- Mismas columnas, en el mismo orden y con los mismos tipos que en 0010:
-- CREATE OR REPLACE conserva el dueño y el GRANT a joda_readonly.
CREATE OR REPLACE VIEW public.v_catalog_variants AS
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
  -- es información competitiva. Misma fórmula que app.v_stock_available
  -- (saldo − reservas vivas), calculada acá con los permisos del dueño de
  -- esta vista. Invariante 66.
  (COALESCE(s.available, 0) > 0) AS in_stock
FROM app.product_variants v
JOIN app.products p ON p.id = v.product_id
LEFT JOIN LATERAL (
  SELECT sum(b.on_hand) - COALESCE((
           SELECT sum(sr.qty)
             FROM app.stock_reservations sr
            WHERE sr.variant_id = v.id
              AND sr.released_at IS NULL
              AND sr.expires_at > now()
         ), 0) AS available
    FROM app.inventory_balances b
   WHERE b.variant_id = v.id
) s ON true
WHERE v.online_visible
  AND p.status = 'active'
  AND p.published_at IS NOT NULL;
