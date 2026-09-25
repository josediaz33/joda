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
    LEFT JOIN LATERAL (
      SELECT
        (
          sum((b.on_hand) :: numeric) - COALESCE(
            (
              SELECT
                sum((sr.qty) :: numeric) AS sum
              FROM
                stock_reservations sr
              WHERE
                (
                  (sr.variant_id = v.id)
                  AND (sr.released_at IS NULL)
                  AND (sr.expires_at > NOW())
                )
            ),
            (0) :: numeric
          )
        ) AS available
      FROM
        inventory_balances b
      WHERE
        (b.variant_id = v.id)
    ) s ON (TRUE)
  )
WHERE
  (
    v.online_visible
    AND (p.status = 'active' :: product_status)
    AND (p.published_at IS NOT NULL)
  );