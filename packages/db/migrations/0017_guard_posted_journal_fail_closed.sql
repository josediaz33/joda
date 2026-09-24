-- =====================================================================
-- 0017_guard_posted_journal_fail_closed.sql  (WP-B10, hallazgo de la
-- revisión cruzada del PR #58)
--
-- DEFECTO, introducido por 0016. `guard_posted_journal()` (0009, con
-- search_path fijado en 0015) impone RN-CTB-06: "Un asiento contabilizado
-- no se modifica". Corría con los permisos de quien edita `journal_lines`
-- y leía `journal_entries.status`. Desde 0016, esa lectura exige tenant Y
-- `accounting.journal:read`. Un staff sin ese permiso (el vendedor) leía
-- "ningún asiento", `v_status` quedaba NULL, `NULL = 'posted'` no es
-- verdadero y el trigger DEJABA PASAR la edición. Reproducido como
-- `joda_api`: `UPDATE 1` y `DELETE 1` sobre líneas de un asiento
-- contabilizado. Fallaba ABIERTO.
--
-- CORRECCIÓN.
--   1. SECURITY DEFINER: el trigger verifica integridad, no expone datos,
--      así que tiene que ver el asiento sin importar los permisos de quien
--      edita.
--   2. FALLA CERRADO: si el asiento no se encuentra, RAISE. Nunca se
--      compara contra un valor que podría ser NULL por falta de
--      visibilidad (principio de docs/data-model.md y
--      .claude/rules/database.md).
--   3. Tenant: con SECURITY DEFINER el trigger ve asientos de TODOS los
--      tenants, y la FK `entry_id` no evalúa RLS (lección de B08). Se exige
--      que el `tenant_id` de la línea coincida con el del asiento.
--   4. UPDATE verifica el asiento de OLD y, si `entry_id` cambia, también
--      el de NEW. La versión anterior miraba solo
--      `COALESCE(NEW.entry_id, OLD.entry_id)`: en un UPDATE eso es NEW, así
--      que mover una línea FUERA de un asiento contabilizado pasaba.
--   5. search_path = app, pg_temp, y nombres calificados con `app.`. En una
--      función SECURITY DEFINER, `pg_temp` se busca PRIMERO si no se lo
--      nombra: quien la dispara podría crear una tabla temporal
--      `journal_entries` con status 'draft' y hacer que el trigger la lea
--      en lugar de la real. Nombrarlo al final lo impide (manual de
--      Postgres, "Writing SECURITY DEFINER Functions Safely").
--
-- CONSECUENCIA DELIBERADA del punto 2. Un DELETE sobre `journal_entries`
-- borra sus líneas por `ON DELETE CASCADE`, y en ese momento el asiento ya
-- no existe: el trigger no lo encuentra y rechaza. O sea que un asiento con
-- líneas ya no se puede borrar de un solo golpe, ni siquiera un borrador
-- (tampoco un tenant, que cascada hasta acá). Para borrar un borrador hay
-- que borrar primero sus líneas (el asiento todavía existe y está en
-- 'draft', pasa) y después el asiento. Nada lo hace hoy: `joda_api` no
-- tiene DELETE sobre `journal_entries` (0010), y ni el seed ni los tests
-- borran asientos. Un asiento contabilizado nunca se borra: se reversa.
-- =====================================================================
SET search_path = app, public;

CREATE OR REPLACE FUNCTION app.guard_posted_journal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE
  v_entry_id    uuid;
  v_line_tenant uuid;
  v_status      app.journal_status;
  v_tenant_id   uuid;
BEGIN
  -- Asiento de la fila tal como estaba (UPDATE/DELETE), y además el de
  -- destino si un UPDATE mueve la línea a otro asiento.
  FOR v_entry_id, v_line_tenant IN
    SELECT OLD.entry_id, OLD.tenant_id
    UNION
    SELECT NEW.entry_id, NEW.tenant_id WHERE TG_OP = 'UPDATE'
  LOOP
    SELECT e.status, e.tenant_id INTO v_status, v_tenant_id
      FROM app.journal_entries e
     WHERE e.id = v_entry_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Asiento % no encontrado: no se puede verificar que la línea sea editable', v_entry_id
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF v_tenant_id IS DISTINCT FROM v_line_tenant THEN
      RAISE EXCEPTION
        'La línea (tenant %) no pertenece al tenant del asiento % (tenant %)',
        v_line_tenant, v_entry_id, v_tenant_id
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- `status` es NOT NULL y el caso "no encontrado" ya se rechazó arriba:
    -- esta comparación nunca ve un NULL por falta de visibilidad. Se
    -- conserva la semántica de 0009 (solo 'posted' bloquea); si un asiento
    -- 'reversed' también debe bloquearse es una regla que RN-CTB-06 no
    -- escribe, fuera de este WP.
    IF v_status = 'posted' THEN
      RAISE EXCEPTION
        'El asiento ya está contabilizado: no se modifica, se reversa'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END $$;
