-- =====================================================================
-- 0042_sale_confirmation.sql  (WP-C19)
--
-- Lo que la base tiene que dar para que confirmar una venta (el pedido pasa a
-- `paid`, RN-VTA-02) consuma el inventario sin que el vendedor lea costos.
-- Dos piezas, ninguna debilita una política ni un permiso.
--
-- 1. LA UNIDAD SERIALIZADA DE UN MOVIMIENTO ES DE LA VARIANTE DEL MOVIMIENTO.
--    `inventory_movements` guarda `variant_id` y `serial_unit_id`, y la FK de la
--    unidad (0023) solo ataba `(serial_unit_id, tenant_id)`: nada exigía que la
--    unidad fuera de esa variante. Un movimiento `sale` de un reloj podía
--    declarar la variante de una cinta y llevarse el costo y el saldo de otra.
--    Es el defecto que 0023 cerró para el lote (defecto 2), 0029 para la unidad
--    contra su lote y 0040 para las reservas, y se cierra igual: FK compuesta
--    `(serial_unit_id, variant_id, tenant_id)` contra el `UNIQUE (id,
--    variant_id, tenant_id)` que 0040 ya agregó a `serialized_units`. Mismo
--    nombre y misma acción ON DELETE (RESTRICT) que la de 0023, así la relación
--    conserva su nombre en `schema.prisma`. Con `serial_unit_id` NULL no
--    verifica nada (MATCH SIMPLE): casi todo movimiento no lleva unidad.
--    EXPAND-SAFE: ningún flujo de la API escribía todavía movimientos con
--    unidad; el smoke no tiene ninguno. Si alguna fila fuera incoherente, la
--    migración falla al validar, con el nombre de la restricción.
--
-- 2. `app.list_sale_allocation_lots(variantes)`: LOS LOTES QUE LA VENTA PUEDE
--    CONSUMIR, SIN QUE EL VENDEDOR LOS LEA (H1 de la revisión de WP-C13).
--    Confirmar una venta elige de qué lotes sale la mercadería (RN-LOT-05) y a
--    qué costo (RN-COS-04): necesita el saldo, la fecha de recepción y el costo
--    unitario de cada lote. El vendedor no tiene `inventory.stock:read`
--    (`lots_read`, 0010; el costo del lote es lo que esa lectura protege,
--    docs/security-spec.md §2), pero registra el movimiento `sale` y sus capas
--    (0034, 0039). Dos caminos descartados: darle `inventory.stock:read` (le
--    abre todos los costos) y mover la elección de lote a un disparador (es
--    lógica de negocio, ADR-017/026). Queda la función `SECURITY DEFINER`, el
--    patrón de `app.list_decant_plan_lots` (0039) y `app.can_allocate_cost_to_
--    movement`:
--      · `search_path` fijo con `pg_temp` al final y nombres calificados (B09);
--      · el chequeo de `sales.order:write` ADENTRO, y falla cerrado: sin el
--        permiso, sin sesión de staff o sin tenant rechaza (42501), no devuelve
--        un vacío (un vacío es indistinguible de «no hay stock»);
--      · filtra por el tenant de la sesión, y una variante que no es del tenant
--        rechaza (P0002) en vez de omitirse en silencio;
--      · devuelve SOLO lo que la elección necesita: el lote, su variante, la
--        recepción, el vencimiento, el saldo y el costo unitario. Ningún
--        proveedor, ni moneda, ni tipo de cambio, ni costo total del lote;
--      · lotes `available` con saldo positivo, nada más: los de cuarentena,
--        dañados, agotados o abiertos para fraccionar no son saldo vendible;
--      · TOMA EL BLOQUEO DE LOS LOTES que devuelve, en una sola sentencia y por
--        `id` ascendente (`FOR UPDATE OF l`, RN-LOT-05, ADR-019). Quien no lee
--        lotes no podría bloquearlos desde la API (un `FOR UPDATE` bajo RLS solo
--        toma las filas que la política deja ver: ninguna), así que lo hace la
--        función, DESPUÉS de que la API tomó las variantes (`lockVariantsThenLots`,
--        RN-RES-07). Es VOLATILE por eso: una función `STABLE` no puede tomar
--        bloqueos de fila.
--    EL COSTO LLEGA A LA API Y NO SALE DE ELLA: lo usa el dominio para armar las
--    capas, y no viaja en ninguna respuesta ni en ningún mensaje de error. Lo que
--    esta función suma a la superficie: un proceso de la API comprometido, con
--    una sesión que tenga `sales.order:write`, puede ejecutarla y leer el costo
--    unitario de los lotes de las variantes que nombre. Es el mismo alcance que
--    ya tiene quien escribe capas (0039) y no abre una lectura nueva a una
--    persona: el vendedor sigue sin procedimiento que devuelva un costo.
--    Decisión registrada en docs/decisiones-provisionales.md, con cómo revertirla.
--    Solo `joda_api` la ejecuta (REVOKE de PUBLIC, como 0011 y 0039).
-- =====================================================================
SET search_path = app, public;

-- 1. FK compuesta de la unidad serializada de un movimiento.
ALTER TABLE app.inventory_movements DROP CONSTRAINT inventory_movements_serial_unit_id_fkey;
ALTER TABLE app.inventory_movements
  ADD CONSTRAINT inventory_movements_serial_unit_id_fkey
  FOREIGN KEY (serial_unit_id, variant_id, tenant_id)
  REFERENCES app.serialized_units (id, variant_id, tenant_id) ON DELETE RESTRICT;

-- 2. Los lotes consumibles de las variantes de una venta.
CREATE FUNCTION app.list_sale_allocation_lots(p_variant_ids uuid[])
RETURNS TABLE (
  lot_id               uuid,
  variant_id           uuid,
  received_at          timestamptz,
  expiry_at            date,
  on_hand              app.qty,
  unit_landed_cost_pyg app.pyg
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'No hay tenant en el contexto de la sesión: no se pueden listar lotes para vender'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- `has_permission` exige además sesión de staff viva del mismo usuario y
  -- tenant (0019): sin sesión da falso, y este rechazo es el de «sin sesión».
  IF NOT app.has_permission('sales.order:write') THEN
    RAISE EXCEPTION 'Falta el permiso sales.order:write, o no hay una sesión de personal vigente'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_variant_ids IS NULL THEN
    RAISE EXCEPTION 'Faltan las variantes de los lotes a listar'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- Una variante ajena o inexistente no se omite en silencio: un vacío
  -- parecería «sin stock».
  IF (SELECT count(*) FROM app.product_variants v
       WHERE v.tenant_id = v_tenant AND v.id = ANY (p_variant_ids))
     <> (SELECT count(DISTINCT x) FROM unnest(p_variant_ids) AS x) THEN
    RAISE EXCEPTION 'Una de las variantes no existe en el tenant de la sesión'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- `ORDER BY l.id` y la sentencia única son el contrato del bloqueo: el orden
  -- ascendente de lotes de RN-LOT-05. No los "limpies".
  RETURN QUERY
  SELECT l.id, l.variant_id, l.received_at, l.expiry_at, b.on_hand, l.unit_landed_cost_pyg
    FROM app.inventory_lots l
    JOIN app.inventory_balances b
      ON b.lot_id = l.id
     AND b.tenant_id = l.tenant_id
   WHERE l.tenant_id = v_tenant
     AND l.variant_id = ANY (p_variant_ids)
     AND l.status = 'available'
     AND b.on_hand > 0
   ORDER BY l.id
     FOR UPDATE OF l;
END $$;

REVOKE ALL ON FUNCTION app.list_sale_allocation_lots(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_sale_allocation_lots(uuid[]) TO joda_api;
