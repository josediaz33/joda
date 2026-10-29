-- =====================================================================
-- 0040_stock_reservation_lot_unit_variant.sql  (WP-C18a)
--
-- DEFECTO · LA VARIANTE DE UNA RESERVA ERA LA QUE DECLARA QUIEN INSERTA.
-- `stock_reservations` guarda `variant_id`, `lot_id` y `serial_unit_id`, y
-- nada exigía que el lote ni la unidad serializada fueran de esa variante:
-- una reserva de un decant podía apuntar al lote de un reloj, o la de un
-- reloj a la unidad de otro modelo. Es el mismo defecto que 0023 cerró para
-- `inventory_movements` (defecto 2) y 0029 para `serialized_units`, y con el
-- mismo riesgo: el disponible de la variante (RN-RES-03, `v_stock_available`)
-- descuenta la reserva de una variante, y la apertura de frasco (RN-LOT-02)
-- y la venta (RN-VTA-02) deciden con el lote o la unidad a la que apunta.
-- Ninguna operación de la API escribe todavía en la tabla (la puebla
-- WP-C18b): este es el momento barato para cerrarlo, antes de que haya filas.
--
-- CORRECCIÓN · dos FK compuestas, y el UNIQUE que una de ellas necesita.
--   · `serialized_units` recibe `UNIQUE (id, variant_id, tenant_id)`, el
--     destino que Postgres exige para referenciar la unidad con su variante.
--     `inventory_lots` ya lo tiene desde 0023. Es redundante con la PK, y
--     cuesta un índice.
--   · `stock_reservations_lot_id_fkey` pasa a `(lot_id, variant_id,
--     tenant_id) REFERENCES inventory_lots (id, variant_id, tenant_id)` y
--     `stock_reservations_serial_unit_id_fkey` a `(serial_unit_id,
--     variant_id, tenant_id) REFERENCES serialized_units (id, variant_id,
--     tenant_id)`. Mismo nombre y misma acción ON DELETE (RESTRICT) que las de
--     0023, para que la relación conserve su nombre en `schema.prisma`. Cada
--     una subsume la de tenant de 0023. Declarativas, sin triggers, y fallan
--     cerrado por construcción: no hay manera de escribir una reserva cuya
--     variante difiera de la de su lote o la de su unidad.
--   · Con `lot_id` o `serial_unit_id` NULL no se verifica nada (MATCH SIMPLE):
--     la reserva es POR VARIANTE por defecto, y atarla a un lote (un plan de
--     decant reserva el lote de granel elegido) o a una unidad (un reloj
--     serializado reserva su unidad) es opcional. No hay referencia que
--     contradecir.
--   · Efecto lateral buscado, igual que en los movimientos y las unidades: un
--     lote o una unidad con reservas (vivas o liberadas: la fila queda) no
--     cambia de variante. ON UPDATE queda NO ACTION.
--   · `variant_id` ya es NOT NULL en la tabla, así que la FK compuesta no
--     depende de que la reserva declare variante: siempre la verifica.
--
-- EXPAND-SAFE · agregar el UNIQUE y reemplazar una FK por otra más estricta
-- no quita ninguna columna ni cambia lo que la API lee. El DROP y el ADD del
-- mismo nombre ocurren en la misma transacción (el archivo es una sola), sin
-- ventana sin FK. Con la tabla vacía no valida nada. Con filas, las coherentes
-- (la del smoke: lote de granel y variante de granel) pasan; si alguna es
-- incoherente, la migración falla al validar la FK, con el nombre de la
-- restricción y la clave, en vez de aceptarla: se corrige esa fila (o se
-- libera y se crea otra) y se vuelve a correr.
--
-- LO QUE NO ESTÁ ACÁ (queda en WP-C18b, que puede traer su propia migración):
-- la política de permisos de escritura de la tabla, la función `SECURITY
-- DEFINER` que lista los tenants con reservas por liberar, la configuración
-- del TTL por tenant y un índice que limite a una la reserva viva por unidad
-- serializada. Ver «Decisiones (C18)» en docs/backlog.md.
-- =====================================================================
SET search_path = app, public;

-- Destino de la FK reserva → unidad con su variante.
ALTER TABLE app.serialized_units
  ADD CONSTRAINT serialized_units_id_variant_tenant_key UNIQUE (id, variant_id, tenant_id);

-- DROP + ADD con el mismo nombre dentro de la misma transacción: no hay
-- ventana sin FK.
ALTER TABLE app.stock_reservations DROP CONSTRAINT stock_reservations_lot_id_fkey;
ALTER TABLE app.stock_reservations
  ADD CONSTRAINT stock_reservations_lot_id_fkey
  FOREIGN KEY (lot_id, variant_id, tenant_id)
  REFERENCES app.inventory_lots (id, variant_id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE app.stock_reservations DROP CONSTRAINT stock_reservations_serial_unit_id_fkey;
ALTER TABLE app.stock_reservations
  ADD CONSTRAINT stock_reservations_serial_unit_id_fkey
  FOREIGN KEY (serial_unit_id, variant_id, tenant_id)
  REFERENCES app.serialized_units (id, variant_id, tenant_id) ON DELETE RESTRICT;
