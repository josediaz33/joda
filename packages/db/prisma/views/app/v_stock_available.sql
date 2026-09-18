SELECT
  b.tenant_id,
  b.variant_id,
  sum((b.on_hand) :: numeric) AS on_hand,
  COALESCE(r.reserved, (0) :: numeric) AS reserved,
  (
    sum((b.on_hand) :: numeric) - COALESCE(r.reserved, (0) :: numeric)
  ) AS available
FROM
  (
    inventory_balances b
    LEFT JOIN LATERAL (
      SELECT
        sum((sr.qty) :: numeric) AS reserved
      FROM
        stock_reservations sr
      WHERE
        (
          (sr.variant_id = b.variant_id)
          AND (sr.released_at IS NULL)
          AND (sr.expires_at > NOW())
        )
    ) r ON (TRUE)
  )
GROUP BY
  b.tenant_id,
  b.variant_id,
  r.reserved;