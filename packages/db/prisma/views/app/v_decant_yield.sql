SELECT
  tenant_id,
  target_variant_id,
  count(*) AS runs,
  sum(ml_expected) AS ml_expected,
  sum(waste_expected) AS waste_expected,
  sum(waste_actual) AS waste_actual,
  CASE
    WHEN (sum(waste_expected) > (0) :: numeric) THEN round((sum(waste_actual) / sum(waste_expected)), 4)
    ELSE NULL :: numeric
  END AS actual_over_expected
FROM
  decant_work_orders wo
WHERE
  (STATUS = 'done' :: decant_wo_status)
GROUP BY
  tenant_id,
  target_variant_id;