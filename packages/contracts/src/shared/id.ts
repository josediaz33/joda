// Identificadores en la frontera — uuid (docs/data-model.md: "Identificadores
// | uuid con gen_random_uuid(), salvo tablas de alto volumen que usan bigint
// identity"). Esas tablas de alto volumen (inventory_movements, journal_lines,
// audit_log) no exponen su id bigint suelto por la API hoy; si eso cambia,
// ese caso necesita su propio esquema, no una ampliación de este.
import { z } from "zod";

export const idSchema = z.string().uuid();

export type Id = z.infer<typeof idSchema>;
