-- =====================================================================
-- 0035_business_defaults_decisions.sql  (WP-E05a, decisiones de José sobre #90)
--
-- Dos valores por defecto de `app.perfume_details` y `app.watch_details`
-- que #90 dejó marcados como pendientes. José decidió así:
--
-- 1. `waste_factor`: el DEFAULT pasa de 0,02 a 0,05. José pierde entre
--    0,3 y 0,5 ml por decant de 10 ml (3 a 5 %) y se toma el extremo alto.
--    Este factor solo sirve para RESERVAR líquido (RN-FRA-02, reserva, y
--    RN-FRA-06, disponibilidad): el costo sale siempre de la merma real que
--    se carga en cada orden (RN-FRA-04), no de este número. Equivocarse por
--    arriba reserva de más; equivocarse por debajo promete un decant que el
--    frasco no alcanza.
--
--    Como todavía no hay datos de producción, también se corrigen las filas
--    que tengan el 0,02 viejo: ese valor es el DEFAULT anterior, no una
--    elección de nadie. Sobre datos reales este UPDATE sería incorrecto
--    (pisaría un 0,02 puesto a propósito); por eso es un paso único de esta
--    migración y no una regla que se repita.
--
-- 2. `requires_serial`: se QUITA el DEFAULT (`true` en 0003). No todos los
--    relojes llevan número de serie, y la respuesta correcta ante "depende"
--    es no tener valor por defecto: con `true`, un reloj sin serie se traba
--    al recibirlo (la recepción exige cargar los seriales, RN-SER, WP-C15);
--    con `false`, uno con serie entra sin registrarla, en silencio. Se
--    decide al crear el reloj. La columna sigue siendo `NOT NULL`, así que
--    un INSERT que omita el campo ahora falla en lugar de adivinar.
--
-- `warranty_months = 12`, `unusable_residue_ml = 2` y `evaporation_ml_year
-- = 0` quedan como están: José confirmó los tres, no hay nada que migrar.
--
-- No es un DROP COLUMN: es un cambio de DEFAULT, compatible con expand/
-- contract. La API ya mandaba `requires_serial` explícito en cada alta
-- (`apps/api/src/modules/catalog/repository.ts`, `insertWatchDetails`).
--
-- La paridad con `packages/contracts/src/catalog-defaults.ts` la verifica
-- `businessDefaultsParity.integration.test.ts`.
-- =====================================================================
SET search_path = app, public;

ALTER TABLE perfume_details
  ALTER COLUMN waste_factor SET DEFAULT 0.05000;

UPDATE perfume_details
   SET waste_factor = 0.05000
 WHERE waste_factor = 0.02000;

ALTER TABLE watch_details
  ALTER COLUMN requires_serial DROP DEFAULT;
