-- =====================================================================
-- 0025_single_reversal.sql  (WP-B14b)
--
-- DEFECTO. Pregunta abierta de B14 y hallazgo H2 de la revisión de B12:
-- nada impedía contabilizar dos reversiones del mismo asiento antes de
-- marcarlo `reversed`. Con dos reversiones contabilizadas,
-- `v_trial_balance` sobre-revierte: el saldo termina en el importe
-- invertido en vez de volver a cero.
--
-- CORRECCIÓN (decisión de José, 2026-09-25): un asiento se revierte una
-- sola vez. Índice único parcial sobre `reverses_id` para los asientos que
-- no son borrador.
--   · Borradores de reversión duplicados se permiten: un borrador no
--     impacta el balance, y el que sobre se borra. El segundo falla al
--     pasar a `posted`.
--   · `posted` y `reversed` cuentan los dos: una reversión contabilizada
--     que después se revierte a su vez sigue ocupando el lugar.
--   · Dos transacciones que contabilizan a la vez dos reversiones del
--     mismo asiento: la segunda espera a la primera y falla con 23505.
--
-- Declarativo, no un trigger: el índice falla cerrado y no depende de
-- visibilidad ni de permisos. La reversión la genera el motor de posteo
-- (WP-H01) espejando el original; este índice es la red de abajo.
-- =====================================================================
CREATE UNIQUE INDEX journal_entries_single_reversal
  ON app.journal_entries (reverses_id)
  WHERE reverses_id IS NOT NULL AND status <> 'draft';
