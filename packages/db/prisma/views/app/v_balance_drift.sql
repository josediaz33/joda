SELECT
  l.id AS lot_id,
  l.tenant_id,
  l.variant_id,
  COALESCE((b.on_hand) :: numeric, (0) :: numeric) AS projected,
  COALESCE(m.ledger_sum, (0) :: numeric) AS from_ledger,
  (
    COALESCE((b.on_hand) :: numeric, (0) :: numeric) - COALESCE(m.ledger_sum, (0) :: numeric)
  ) AS drift
FROM
  (
    (
      inventory_lots l
      LEFT JOIN inventory_balances b ON ((b.lot_id = l.id))
    )
    LEFT JOIN LATERAL (
      SELECT
        sum((inventory_movements.qty) :: numeric) AS ledger_sum
      FROM
        inventory_movements
      WHERE
        (inventory_movements.lot_id = l.id)
    ) m ON (TRUE)
  )
WHERE
  (
    COALESCE((b.on_hand) :: numeric, (0) :: numeric) <> COALESCE(m.ledger_sum, (0) :: numeric)
  );