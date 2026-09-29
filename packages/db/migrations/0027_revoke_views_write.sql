-- =====================================================================
-- 0027_revoke_views_write.sql  (WP-B16)
--
-- DEFECTO. El `ALTER DEFAULT PRIVILEGES ... ON TABLES` de 0010 concede
-- INSERT, UPDATE y DELETE a `joda_api` sobre todo lo que se cree en
-- `app`, y Postgres no distingue una vista de una tabla en ese default
-- (no existe `ON VIEWS`). Las cuatro vistas de `app.*` lo heredaron:
-- v_balance_drift, v_decant_yield, v_stock_available y v_trial_balance.
-- Hallazgo de la revisión cruzada de B09b.
--
-- HOY ES INOCUO: ninguna es actualizable ni tiene `INSTEAD OF`. Pero una
-- vista futura simple sobre `inventory_balances` heredaría el permiso y
-- reabriría B09b: la API volvería a poder escribir la proyección de
-- saldos sin pasar por el ledger.
--
-- CORRECCIÓN. Se revoca la escritura sobre las cuatro. Conservan SELECT:
-- la API las lee.
--
-- HACIA ADELANTE. El default no se puede acotar a tablas, así que una
-- vista nueva vuelve a nacer con escritura. La garantía es el invariante
-- 78, que hace fallar `db:test` si alguna vista de `app.*` la tiene: la
-- migración que crea la vista trae su REVOKE.
-- =====================================================================
REVOKE INSERT, UPDATE, DELETE ON
  app.v_balance_drift,
  app.v_decant_yield,
  app.v_stock_available,
  app.v_trial_balance
FROM joda_api;
