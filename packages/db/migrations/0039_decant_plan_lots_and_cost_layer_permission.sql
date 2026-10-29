-- =====================================================================
-- 0039_decant_plan_lots_and_cost_layer_permission.sql  (WP-B18 y WP-B11e)
--
-- Dos cosas de la serie B que C19 (la venta con consumo y COGS) necesita
-- resueltas antes de escribir una línea, y que comparten una premisa: el
-- vendedor no lee los lotes ni el ledger (`inventory.stock:read`, 0010 y
-- 0037), pero vender un decant le exige planificar la orden y registrar el
-- movimiento `sale` con sus capas de costo.
--
--   WP-B18  · planificar un decant sin leer lotes y sin duplicar la orden
--             (H1 y H3 de la revisión de WP-C13; decisiones de José del
--             2026-10-07 y del 2026-10-08).
--   WP-B11e · las capas de costo de una salida exigen el permiso del
--             movimiento al que pertenecen, y solo se atan a un movimiento
--             que quien las escribe creó en esa misma transacción
--             (hallazgo de la revisión cruzada de B11d; decidido por José el
--             2026-10-02).
--
-- ---------------------------------------------------------------------
-- WP-B18 · (1) EL PERMISO `inventory.decant:plan`
--
-- No se crea acá: el catálogo `permissions` y los otorgamientos por rol los
-- carga `seed/0001_seed_base.sql` (`permissions` y `app.seed_roles`), y el
-- código vive también en `packages/contracts/src/security/permissions.ts`.
-- `permissionsParity.integration.test.ts` (WP-M11) compara esos dos catálogos;
-- los otorgamientos por rol los fijan los invariantes 137 y 138, y la tabla de
-- `docs/security-spec.md` §2 no la compara nadie. Lo reciben `vendedor` y
-- `deposito` por seed; `owner` y `manager` lo reciben porque el seed les da
-- todos los permisos (al `manager`, todos menos `settings.user:write`).
-- Planificar exige exactamente ese permiso, sin «cualquiera de los dos»: el
-- cambio en `inventory.decant.plan` es de C19.
--
-- Cómo llega a un tenant que ya existe: los otorgamientos de un rol de
-- sistema solo los escribe el seed (0033: `joda_api` no los toca). Se vuelve
-- a correr `seed/0001_seed_base.sql` y después `SELECT app.seed_roles(<tenant>)`
-- por cada tenant (`ON CONFLICT DO NOTHING`, idempotente); el guion de corte
-- de WP-F02 lo corre. Hasta entonces `has_permission('inventory.decant:plan')`
-- da falso para todos, que es lo seguro.
--
-- WP-B18 · (2) LA FUNCIÓN `app.list_decant_plan_lots(variante)`
--
-- Planificar un decant (`createPlannedWorkOrder`, que C19 llama dentro de su
-- transacción de confirmación) necesita ver qué granel hay, y `lots_read`
-- exige `inventory.stock:read`, que incluye el costo de lote. No se afloja
-- `lots_read` ni se le da `stock:read` al vendedor: sin una salida, recibía un
-- `CONFLICT_NO_BULK_AVAILABLE` que decía «abrí un frasco» aunque el granel
-- existía. La salida es esta función `SECURITY DEFINER`, acotada, que cumple
-- la especificación de `docs/security-spec.md` §3.1:
--
--   · `search_path = app, pg_temp` y nombres calificados (0017, 0018, 0019).
--   · El chequeo de `inventory.decant:plan` va ADENTRO. Que la API llame antes
--     a `requirePermission` no alcanza: la función es la que le abre a
--     `joda_api` una lectura que la política le cierra.
--   · FALLA CERRADO. Sin el permiso, sin sesión de staff válida o sin tenant en
--     el contexto, rechaza con un error (42501); no devuelve cero filas. Un
--     vacío es indistinguible de «no hay granel», que es el engaño de H1. Lo
--     mismo con una variante que no existe en el tenant de la sesión
--     (P0002) o sin variante (22004).
--   · Filtra por el tenant de la sesión (`app.current_tenant_id()`): una
--     SECURITY DEFINER ve las filas de todos los tenants.
--   · Devuelve solo `lot_id`, la cantidad disponible y `opened_at`. Ningún
--     costo, proveedor ni fecha de recepción.
--   · `REVOKE` de `PUBLIC` y `GRANT` solo a `joda_api`, como 0011.
--   · Dependencia operativa de B09 (0018): lee `inventory_lots` por encima de
--     `lots_read`, así que su dueño tiene que eludir RLS. Los invariantes 30
--     y 40 ya lo verifican para toda SECURITY DEFINER de `app`.
--
-- Lo que la especificación dejaba para esta migración, y se decide acá (C19
-- lo usa, y por eso no puede esperar a C19: si se resolviera después, C19
-- volvería a necesitar esquema):
--
--   a. El parámetro es la variante de los lotes (`p_variant_id`) y el filtro
--      lo da el TIPO de esa variante, no el llamador: una variante `bulk`
--      devuelve sus lotes `open_for_decant` (lo que hace `listOpenBulkLots`:
--      un lote de granel abierto con saldo); cualquier otra, sus lotes
--      `available` (lo que hace `listSupplyLots`). El llamador no elige el
--      estado, así que no puede usar la función para listar lotes en
--      cuarentena, dañados o agotados. Orden: `opened_at` y después `id`, el
--      de `listOpenBulkLots` (se termina antes el frasco que lleva más tiempo
--      abierto, y por lo tanto evaporándose). Para los insumos el orden no
--      importa: planificar solo suma lo disponible.
--   b. El `LotSnapshot` sin costo. `planDecant` lee del lote `status`,
--      `variantType`, `uom` y `available`, y nada más (`unitCost` entra en el
--      tipo pero no en el cálculo). Las tres que la función no devuelve las
--      garantiza el filtro o las lee `plan` de la VARIANTE, que el vendedor sí
--      ve (`catalog.product:read`): `status` es `open_for_decant` si la
--      variante es `bulk` y `available` si no; `variantType` y `uom` son los de
--      la variante. C19 tipa la entrada de `planDecant` sin `unitCost` (un
--      `Pick` del `LotSnapshot`); el costo no tiene por qué existir en la
--      memoria de la petición del vendedor.
--   c. Los insumos del BOM: la misma función, una llamada por componente. El
--      contrato es el mismo y la suma de lo disponible la hace `plan`.
--   d. El `sourceLotId` del vendedor: no lo puede pasar. Elegir un lote
--      concreto exige verlo, y ver un lote es `inventory.stock:read`
--      (`findLotWithVariant` bajo `lots_read` da 404 sin él, como hoy). Que el
--      lote lo elija el servidor entre los candidatos es lo que esta función
--      permite; elegir uno a mano sigue siendo del administrador. No se agrega
--      ninguna función de «mirar un lote» para el vendedor.
--
-- Qué NO cambia: `lots_read` sigue exigiendo `inventory.stock:read`; el
-- vendedor sigue sin leer `inventory_lots`; ejecutar la orden sigue exigiendo
-- `inventory.decant:execute` (la política de `inventory_movements`, 0034); la
-- función no escribe nada. Las filas de `inventory_balances` ya las lee todo
-- el tenant (0014), así que la cantidad no es un dato nuevo para el vendedor:
-- lo que la función suma es el estado del lote y la fecha de apertura, y los
-- entrega solo para las variantes que se le piden, sin costos.
--
-- WP-B18 · (3) UNA ORDEN ACTIVA POR LÍNEA DE VENTA (H3)
--
-- `decant_work_orders.sale_order_line_id` y un índice único parcial
-- `WHERE status <> 'cancelled'`: cancelar una orden permite replanificar la
-- línea. La `Idempotency-Key` de `plan` sigue siendo opcional y solo sirve
-- para reintentos: no puede garantizar «una orden por línea», porque la elige
-- el cliente; dos llamadas con claves distintas, o sin clave, crearon las tres
-- órdenes de H3. Es un invariante de la base. Que `plan` reciba la línea y
-- traduzca la violación (23505) a un 409 es de C19.
--
-- La columna es NULLABLE: C13b planifica decants para stock, sin venta, y un
-- NULL no choca en un índice único. La FK es compuesta, `(sale_order_line_id,
-- tenant_id)` (0023): una FK no evalúa RLS, y sin el tenant una orden del
-- tenant A podría apuntar a la línea del tenant B. Con `ON DELETE RESTRICT`: la
-- línea de una venta con una orden de fraccionamiento no se borra por
-- cascada desde el pedido.
--
-- QUÉ QUEDA FUERA de la columna: que la línea sea del pedido `sale_order_id`
-- de la misma orden. Las dos columnas son independientes en el esquema; `plan`
-- (C19) recibe la línea y deriva el pedido de ella, así que no pueden diferir
-- por construcción. Atarlas en la base pide un UNIQUE nuevo sobre
-- `sale_order_lines (id, sale_order_id, tenant_id)` y un CHECK de que no haya
-- línea sin pedido: se evalúa si aparece un segundo escritor de la columna.
--
-- ---------------------------------------------------------------------
-- WP-B11e · LAS CAPAS DE COSTO EXIGEN EL PERMISO DEL MOVIMIENTO
--
-- DEFECTO. Desde 0014 las capas de costo de cada salida
-- (`movement_cost_allocations`) tenían una política de INSERT solo por tenant
-- (`true`; desde 0037, `tenant_access_insert`). Como vendedor se podía
-- registrar una capa sobre un movimiento que el vendedor no puede escribir (un
-- `adjustment`, una recepción de compra), y esa capa participa del cuadre del
-- movimiento: el costo de lo que sale se podía alterar sin el permiso de la
-- operación. Y quedaba un oráculo (el único que dejó 0037): el disparador del
-- cuadre (`trg_cost_allocation_matches`) rechaza una capa que no suma lo que
-- declara el movimiento, y acepta la que coincide; sin cifras en el mensaje,
-- una capa sobre un movimiento ajeno SIN capas pasaba si su total era el costo
-- exacto del movimiento, y el vendedor confirmaba por igualdad un dato que no
-- puede leer.
--
-- CORRECCIÓN. La política de INSERT pasa a ser
-- `app.can_allocate_cost_to_movement(movement_id)`, que exige DOS cosas:
--
--   1. El mismo permiso que el `movement_type` del movimiento al que la capa
--      pertenece, con el mapeo de 0034 (decisiones de José del 2026-10-01):
--
--        sale                                      sales.order:write
--        adjustment                                inventory.stock:adjust
--        decant_consumption, decant_yield,
--          bom_consumption, waste                  inventory.decant:execute
--        transfer_in, transfer_out                 inventory.decant:execute
--        purchase_receipt                          market.purchase_order:receive
--        return_in                                 sales.order:refund
--        return_out                                market.purchase_order:write
--
--      Quien no puede insertar un `adjustment` no puede registrarle capas, y
--      quien puede insertar un `sale` sí. Un `movement_type` que se agregue al
--      enum y no figure acá no coincide con ninguna rama y se rechaza hasta
--      mapearlo a propósito (falla cerrado; el invariante 149 obliga a
--      decidirlo, como el 114 para el movimiento).
--   2. Que el movimiento lo haya creado ESTA transacción. Es lo que cierra el
--      oráculo de arriba (la prueba por igualdad ya no tiene sobre qué
--      probar: no se puede apuntar una capa a un movimiento ajeno) y lo que
--      siempre debió ser cierto del ledger: el movimiento y sus capas son un
--      solo acto, y el cuadre es una constraint diferida que se verifica al
--      COMMIT de la transacción que los escribió. Ningún flujo legítimo
--      agrega capas a un movimiento de otra transacción.
--
-- LA TRAMPA QUE ESTO RESUELVE. La política tiene que saber el `movement_type`
-- de `movement_id`, y desde 0037 el vendedor no ve el movimiento que acaba de
-- insertar (`movements_read` exige `inventory.stock:read`): un `EXISTS` sobre
-- `inventory_movements` correría bajo RLS y rechazaría su INSERT. Por eso la
-- lectura va en una función de solo lectura `SECURITY DEFINER`, como
-- `has_permission`: ve el ledger sin importar quién escribe, y devuelve solo un
-- booleano. No le dice nada a quien la llama: para un movimiento ajeno, uno que
-- no existe, uno de otro tenant o uno viejo, la respuesta es la misma: falso.
--
-- CÓMO SE SABE QUE EL MOVIMIENTO ES DE ESTA TRANSACCIÓN: `xmin` de su fila es
-- el id de transacción que la insertó (`xmin = pg_current_xact_id()::xid`).
-- Es lo que ve la base sin agregar una columna al ledger. Dos límites, que
-- fallan cerrado:
--   · Subtransacciones. Un movimiento insertado DENTRO de un `SAVEPOINT` (o de
--     un bloque PL/pgSQL con `EXCEPTION`, que es uno) lleva el id de la
--     subtransacción, y `pg_current_xact_id()` devuelve el de la transacción:
--     no coincide, ni siquiera tras un `RELEASE`, y sus capas se rechazan
--     aunque las inserte el mismo bloque. La regla para quien use savepoints:
--     el MOVIMIENTO se inserta fuera de todo savepoint; un savepoint abierto
--     después de insertarlo no afecta a sus capas. Ni `withTenantTx` ni Prisma
--     abren savepoints en una transacción interactiva.
--   · Vuelta del contador. `xmin` es de 32 bits y `pg_current_xact_id()::xid`
--     lo trunca: una transacción cuyo id coincida módulo 2^32 con el de un
--     movimiento viejo (que conserva su `xmin` original aunque esté congelado)
--     podría atarle una capa, siempre con el permiso del tipo y el tenant
--     correctos. Hacen falta más de 4.290 millones de transacciones entre las
--     dos; se acepta.
--
-- Sin UPDATE ni DELETE (la tabla es append-only y `joda_api` no tiene esos
-- privilegios, 0010); el SELECT sigue exigiendo `inventory.stock:read` (0037).
-- Una política por comando, nunca `FOR ALL`. El disparador del cuadre
-- (`assert_cost_allocation_matches`, 0018 y 0037) no cambia: sigue
-- verificando que las capas sumen el costo del movimiento. Los roles de la
-- carga masiva (ETL, `service_role`) eluden RLS y no pasan por esta política.
--
-- Esta migración agrega una columna, una FK, un índice y dos funciones, y
-- cambia una política. No cambia datos.
-- =====================================================================
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- WP-B18 · (3) decant_work_orders.sale_order_line_id
-- ---------------------------------------------------------------------
ALTER TABLE app.decant_work_orders ADD COLUMN sale_order_line_id uuid;

ALTER TABLE app.decant_work_orders
  ADD CONSTRAINT decant_work_orders_sale_order_line_id_fkey
  FOREIGN KEY (sale_order_line_id, tenant_id)
  REFERENCES app.sale_order_lines (id, tenant_id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX decant_wo_one_active_per_line
  ON app.decant_work_orders (sale_order_line_id)
  WHERE status <> 'cancelled';

-- ---------------------------------------------------------------------
-- WP-B18 · (2) Los lotes candidatos de un decant, sin costos
-- ---------------------------------------------------------------------
CREATE FUNCTION app.list_decant_plan_lots(p_variant_id uuid)
RETURNS TABLE (lot_id uuid, available app.qty, opened_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_type   app.variant_type;
  v_status app.lot_status;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'No hay tenant en el contexto de la sesión: no se pueden listar lotes para planificar'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- `has_permission` exige además sesión de staff viva del mismo usuario y
  -- tenant (0019): sin sesión da falso, y este rechazo es el de «sin sesión».
  IF NOT app.has_permission('inventory.decant:plan') THEN
    RAISE EXCEPTION 'Falta el permiso inventory.decant:plan, o no hay una sesión de personal vigente'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_variant_id IS NULL THEN
    RAISE EXCEPTION 'Falta la variante de los lotes a listar'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  SELECT v.variant_type INTO v_type
    FROM app.product_variants v
   WHERE v.id = p_variant_id
     AND v.tenant_id = v_tenant;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La variante % no existe en el tenant de la sesión', p_variant_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- El estado lo decide el tipo de la variante, no quien llama: el granel se
  -- sirve de lotes abiertos para fraccionar; un insumo, de lotes disponibles.
  v_status := CASE WHEN v_type = 'bulk' THEN 'open_for_decant'::app.lot_status
                   ELSE 'available'::app.lot_status END;

  RETURN QUERY
  SELECT l.id, b.on_hand, l.opened_at
    FROM app.inventory_lots l
    JOIN app.inventory_balances b
      ON b.lot_id = l.id
     AND b.tenant_id = l.tenant_id
   WHERE l.variant_id = p_variant_id
     AND l.tenant_id = v_tenant
     AND l.status = v_status
     AND b.on_hand > 0
   ORDER BY l.opened_at, l.id;
END $$;

REVOKE ALL ON FUNCTION app.list_decant_plan_lots(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_decant_plan_lots(uuid) TO joda_api;

-- ---------------------------------------------------------------------
-- WP-B11e · El permiso del movimiento al que pertenece una capa de costo
--
-- No escribe nada y es SECURITY DEFINER (ve el ledger sin importar quién
-- escribe; su dueño tiene que eludir RLS, invariante 30), con `search_path`
-- fijo y falla cerrado: un movimiento que no se
-- encuentra, que es de otro tenant o que no es de esta transacción da falso,
-- igual que un `movement_type` sin mapear. Devuelve un booleano y nada más.
--
-- VOLATILE a propósito, aunque no escriba nada: una función STABLE lee con el
-- snapshot de la sentencia que la llama y no ve un movimiento que insertó un
-- CTE de esa misma sentencia (`WITH m AS (INSERT ... RETURNING id) INSERT INTO
-- movement_cost_allocations SELECT ... FROM m`), que sería rechazado como si
-- fuera ajeno. La volátil toma un snapshot por sentencia propia y lo ve.
-- ---------------------------------------------------------------------
CREATE FUNCTION app.can_allocate_cost_to_movement(p_movement_id bigint)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE
  v_type app.movement_type;
BEGIN
  SELECT m.movement_type INTO v_type
    FROM app.inventory_movements m
   WHERE m.id = p_movement_id
     AND m.tenant_id = app.current_tenant_id()
     AND m.xmin = pg_catalog.pg_current_xact_id()::pg_catalog.xid;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  RETURN CASE v_type
    WHEN 'sale'              THEN app.has_permission('sales.order:write')
    WHEN 'adjustment'        THEN app.has_permission('inventory.stock:adjust')
    WHEN 'decant_consumption' THEN app.has_permission('inventory.decant:execute')
    WHEN 'decant_yield'      THEN app.has_permission('inventory.decant:execute')
    WHEN 'bom_consumption'   THEN app.has_permission('inventory.decant:execute')
    WHEN 'waste'             THEN app.has_permission('inventory.decant:execute')
    WHEN 'transfer_in'       THEN app.has_permission('inventory.decant:execute')
    WHEN 'transfer_out'      THEN app.has_permission('inventory.decant:execute')
    WHEN 'purchase_receipt'  THEN app.has_permission('market.purchase_order:receive')
    WHEN 'return_in'         THEN app.has_permission('sales.order:refund')
    WHEN 'return_out'        THEN app.has_permission('market.purchase_order:write')
    ELSE false
  END;
END $$;

REVOKE ALL ON FUNCTION app.can_allocate_cost_to_movement(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_allocate_cost_to_movement(bigint) TO joda_api;

-- ---------------------------------------------------------------------
-- WP-B11e · La política de INSERT de las capas
--
-- Reemplaza a `tenant_access_insert` (0037, `true`). `tenant_isolation`
-- (RESTRICTIVE, 0016) sigue combinándose con AND: tenant Y permiso del
-- movimiento Y movimiento de esta transacción.
-- ---------------------------------------------------------------------
DROP POLICY tenant_access_insert ON app.movement_cost_allocations;

CREATE POLICY allocations_insert ON app.movement_cost_allocations
  FOR INSERT WITH CHECK (app.can_allocate_cost_to_movement(movement_id));
