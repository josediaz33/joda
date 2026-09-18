SELECT
  p.id,
  p.tenant_id,
  p.kind,
  p.slug,
  p.name,
  p.description,
  p.facets,
  b.name AS brand_name,
  b.slug AS brand_slug,
  p.published_at
FROM
  (
    products p
    LEFT JOIN brands b ON ((b.id = p.brand_id))
  )
WHERE
  (
    (p.status = 'active' :: product_status)
    AND (p.published_at IS NOT NULL)
  );