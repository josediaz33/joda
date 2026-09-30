-- =====================================================================
-- 0029_serialized_unit_lot_variant.sql  (WP-C12)
--
-- DEFECTO · LA VARIANTE DE UNA UNIDAD SERIALIZADA ERA LA QUE DECLARA QUIEN
-- INSERTA. `serialized_units` guarda `variant_id` y `lot_id`, y nada exigía
-- que el lote fuera de esa variante: un reloj de una variante podía quedar
-- asociado a un lote de otra. Mismo defecto que 0023 cerró para
-- `inventory_movements` (defecto 2), y con el mismo riesgo: la unidad se
-- vende como una variante, pero su costo y su saldo salen de un lote que es
-- de otra.
--
-- CORRECCIÓN · la FK del lote pasa a ser `(lot_id, variant_id, tenant_id)
-- REFERENCES inventory_lots (id, variant_id, tenant_id)`. Mismo nombre, misma
-- acción ON DELETE. Subsume la de tenant de 0023. Declarativa, sin
-- triggers, y falla cerrado por construcción: no hay manera de escribir una
-- unidad cuya variante difiera de la de su lote. El destino ya tiene el
-- `UNIQUE (id, variant_id, tenant_id)` que le agregó 0023.
--   · Con `lot_id` NULL no se verifica nada (MATCH SIMPLE): una unidad
--     puede existir sin lote (la carga inicial desde la PWA no lo trae
--     siempre), y no hay referencia que contradecir.
--   · Efecto lateral buscado, igual que en los movimientos: un lote con
--     unidades serializadas no cambia de variante.
--   · Si ya hubiera una unidad incoherente, esta migración falla al
--     validar la FK, con el nombre de la restricción, en vez de aceptarla.
-- WP-C18 hereda el mismo invariante para `stock_reservations` (lote y
-- unidad serializada de la reserva, de la variante de la reserva).
-- =====================================================================
SET search_path = app, public;

ALTER TABLE app.serialized_units DROP CONSTRAINT serialized_units_lot_id_fkey;
ALTER TABLE app.serialized_units
  ADD CONSTRAINT serialized_units_lot_id_fkey
  FOREIGN KEY (lot_id, variant_id, tenant_id)
  REFERENCES app.inventory_lots (id, variant_id, tenant_id) ON DELETE RESTRICT;
