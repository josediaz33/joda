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
  (
    COALESCE(s.available, (0) :: numeric) > (0) :: numeric
  ) AS in_stock
FROM
  (
    (
      product_variants v
      JOIN products p ON ((p.id = v.product_id))
    )
    LEFT JOIN v_stock_available s ON ((s.variant_id = v.id))
  )
WHERE
  (
    v.online_visible
    AND (p.status = 'active' :: product_status)
    AND (p.published_at IS NOT NULL)
  );