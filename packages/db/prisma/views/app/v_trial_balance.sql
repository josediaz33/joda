SELECT
  je.tenant_id,
  je.period_id,
  coa.id AS account_id,
  coa.code AS account_code,
  coa.name AS account_name,
  coa.account_type,
  sum((jl.debit_pyg) :: bigint) AS total_debit_pyg,
  sum((jl.credit_pyg) :: bigint) AS total_credit_pyg,
  CASE
    WHEN (
      coa.account_type = ANY (
        ARRAY ['asset'::account_type, 'expense'::account_type]
      )
    ) THEN (
      sum((jl.debit_pyg) :: bigint) - sum((jl.credit_pyg) :: bigint)
    )
    ELSE (
      sum((jl.credit_pyg) :: bigint) - sum((jl.debit_pyg) :: bigint)
    )
  END AS balance_pyg
FROM
  (
    (
      journal_lines jl
      JOIN journal_entries je ON (
        (
          (je.id = jl.entry_id)
          AND (
            je.status = ANY (
              ARRAY ['posted'::journal_status, 'reversed'::journal_status]
            )
          )
        )
      )
    )
    JOIN chart_of_accounts coa ON ((coa.id = jl.account_id))
  )
GROUP BY
  je.tenant_id,
  je.period_id,
  coa.id,
  coa.code,
  coa.name,
  coa.account_type;