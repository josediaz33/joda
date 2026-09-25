-- =====================================================================
-- 0020_journal_immutability.sql  (WP-B14, RN-CTB-06)
--
-- "Un asiento contabilizado no se modifica. Se genera un asiento inverso
-- que lo referencia por `reverses_id`." Hasta acá la base lo imponía a
-- medias (verificado en la segunda revisión cruzada de B10):
--   · `guard_posted_journal` bloqueaba UPDATE/DELETE de líneas de un
--     asiento `posted`, pero en INSERT solo verificaba el tenant. Cualquier
--     staff del tenant podía colgar un par de líneas compensadas de un
--     asiento contabilizado: cuadra, así que nada más lo frenaba.
--   · Nada gobernaba `journal_entries.status`. Quien tenía
--     `accounting.journal:write` podía pasar un asiento de `posted` a
--     `draft`, editarlo y volver a contabilizarlo sin rastro.
--   · Un asiento `reversed` no bloqueaba nada: sus líneas se editaban como
--     las de un borrador.
--
-- LA REGLA, sin excepciones:
--   · Un asiento NACE en `draft`. Se le insertan las líneas y pasa a
--     `posted`, en la misma transacción; la constraint diferida
--     `trg_journal_balanced` valida el cuadre al COMMIT.
--   · Transiciones válidas:
--       draft  → draft   (editar el borrador)
--       draft  → posted
--       posted → reversed, SOLO si existe un asiento de reversión, del
--                mismo tenant y ya `posted`, que lo referencia por
--                `reverses_id`. Ninguna otra columna cambia en esa
--                transición.
--     `reversed` es terminal: ningún UPDATE.
--   · `posted` y `reversed` son inmutables: ni el asiento ni sus líneas
--     (ni INSERT, ni UPDATE, ni DELETE de líneas; ni DELETE del asiento).
--   · El `tenant_id` de un asiento no cambia, y `reverses_id` apunta a un
--     asiento contabilizado del MISMO tenant (la FK no evalúa RLS; con
--     SECURITY DEFINER este trigger ve todos los tenants).
--
-- POR QUÉ VA A LA BASE, frente a ADR-017. ADR-017 saca de la base las
-- "transiciones de máquinas de estado" y deja en ella la "inmutabilidad del
-- ledger". Esto es lo segundo: que `posted` nunca vuelva a `draft` y que un
-- asiento contabilizado no cambie ES la inmutabilidad del libro contable,
-- no una decisión de flujo. Qué asiento generar, cuándo contabilizarlo o
-- cuándo revertirlo sigue siendo de packages/domain
-- (`accounting/journalEntry.ts` refleja el mismo mapa de transiciones).
--
-- CONSECUENCIA DELIBERADA (ya presente desde 0017, se deja escrita).
-- Borrar un borrador con líneas exige borrar primero las líneas y después
-- el asiento. En un DELETE del asiento, el `ON DELETE CASCADE` borra las
-- líneas cuando el asiento ya no existe, y `guard_posted_journal`, que
-- falla cerrado, no lo encuentra y rechaza. En ese momento no puede
-- distinguir una línea huérfana por cascada de una línea colgada de un
-- asiento de otro tenant: las dos se ven igual (asiento no encontrado en
-- el tenant de la línea). Aflojarlo para la cascada abriría el otro caso.
-- Hoy nada borra asientos (`joda_api` no tiene DELETE sobre
-- `journal_entries`, 0010).
-- =====================================================================
SET search_path = app, public;

-- ---------------------------------------------------------------------
-- Líneas: solo un borrador las recibe, las cambia o las pierde.
-- Misma estructura que 0017; cambia que el estado se verifica en TODA
-- operación (antes, INSERT solo miraba el tenant) y que bloquea todo lo
-- que no sea `draft` (antes, solo `posted`).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.guard_posted_journal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE
  v_entry_id    uuid;
  v_line_tenant uuid;
  v_status      app.journal_status;
BEGIN
  -- Asiento de la fila tal como estaba (UPDATE/DELETE) y de la fila nueva
  -- (INSERT/UPDATE). El UNION deduplica un UPDATE que no cambia entry_id ni
  -- tenant_id; uno que los cambia verifica los dos asientos.
  FOR v_entry_id, v_line_tenant IN
    SELECT OLD.entry_id, OLD.tenant_id WHERE TG_OP <> 'INSERT'
    UNION
    SELECT NEW.entry_id, NEW.tenant_id WHERE TG_OP <> 'DELETE'
  LOOP
    -- "No existe" y "es de otro tenant" dan el MISMO rechazo (0017).
    SELECT e.status INTO v_status
      FROM app.journal_entries e
     WHERE e.id = v_entry_id
       AND e.tenant_id = v_line_tenant;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Asiento % no encontrado en el tenant de la línea: no se puede verificar que sea editable',
        v_entry_id
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- `status` es NOT NULL y el "no encontrado" ya se rechazó.
    IF v_status <> 'draft' THEN
      RAISE EXCEPTION
        'El asiento ya está contabilizado: no se modifica, se reversa'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END $$;

-- ---------------------------------------------------------------------
-- Asientos: nacimiento en draft, transiciones, inmutabilidad, tenant de
-- `reverses_id`.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.guard_journal_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE
  v_target_status app.journal_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION
        'El asiento % no está en borrador: no se borra, se reversa', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION
        'Un asiento nace en borrador: se contabiliza después de cargarle las líneas'
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSE
    -- UPDATE
    IF OLD.status = 'reversed' THEN
      RAISE EXCEPTION
        'El asiento % está revertido: es definitivo', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.tenant_id <> OLD.tenant_id THEN
      RAISE EXCEPTION
        'El tenant de un asiento no cambia'
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.status = 'posted' THEN
      -- La única salida de `posted` es `reversed`, sin tocar nada más.
      IF NEW.status <> 'reversed'
         OR to_jsonb(NEW) - 'status' <> to_jsonb(OLD) - 'status' THEN
        RAISE EXCEPTION
          'El asiento ya está contabilizado: no se modifica, se reversa'
          USING ERRCODE = 'restrict_violation';
      END IF;

      PERFORM 1
         FROM app.journal_entries r
        WHERE r.reverses_id = OLD.id
          AND r.tenant_id = OLD.tenant_id
          AND r.status = 'posted';

      IF NOT FOUND THEN
        RAISE EXCEPTION
          'El asiento % no tiene un asiento de reversión contabilizado: no se puede marcar como revertido',
          OLD.id
          USING ERRCODE = 'restrict_violation';
      END IF;

      RETURN NEW;
    END IF;

    -- OLD.status = 'draft'
    IF NEW.status = 'reversed' THEN
      RAISE EXCEPTION
        'Un borrador no se revierte: se contabiliza o se borra'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- INSERT o UPDATE de un borrador: si revierte otro asiento, ese asiento
  -- tiene que ser del mismo tenant y estar contabilizado. Falla cerrado: un
  -- asiento de otro tenant da el mismo rechazo que uno inexistente.
  IF NEW.reverses_id IS NOT NULL THEN
    SELECT t.status INTO v_target_status
      FROM app.journal_entries t
     WHERE t.id = NEW.reverses_id
       AND t.tenant_id = NEW.tenant_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Asiento a revertir % no encontrado en el tenant del asiento', NEW.reverses_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF v_target_status <> 'posted' THEN
      RAISE EXCEPTION
        'Solo se revierte un asiento contabilizado: % está en %',
        NEW.reverses_id, v_target_status
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_journal_entry_guard
  BEFORE INSERT OR UPDATE OR DELETE ON app.journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.guard_journal_entry();
