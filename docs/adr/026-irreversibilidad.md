# ADR-026 — La base impone la irreversibilidad; la matriz de transiciones vive en el dominio

- **Estado:** Aceptada
- **Fecha:** 2026-09-30
- **Ámbito:** Base de datos
- **Reemplaza:** ADR-017 (entero). El principio "la base hace cumplir invariantes, la aplicación calcula decisiones" se conserva; cambia la regla sobre las máquinas de estado y desaparecen sus tres excepciones anotadas.

---

## Contexto

ADR-017 dejó una regla y tres excepciones anotadas. La regla sacaba de la base las "transiciones de máquinas de estado". Las excepciones eran la proyección de saldos, la inmutabilidad contable (WP-B14) y el lote sellado terminal (WP-B08c).

Las dos últimas son el mismo caso, un estado del que no se vuelve. Una regla que suma una excepción por cada estado así está trazada en el lugar equivocado. La proyección de saldos nunca fue excepción a la regla de las transiciones: era una salvedad al título ("solo para invariantes"), porque no es un invariante en sí sino lo que hace efectivo el `CHECK` de no-negatividad.

Reescribir ADR-017 no es una opción: las migraciones `0018` y `0023` citan sus excepciones, `0020` cita su regla, y ninguna se puede editar (ya están aplicadas). Por eso esta decisión lo reemplaza, y ADR-017 queda intacto con su redacción original.

## Decisión

> **La base de datos hace cumplir invariantes. La aplicación calcula decisiones.**

**Sí van a la base:** inmutabilidad del ledger y de la auditoría, irreversibilidad de los estados en los que se apoyan otros invariantes, cuadre de asientos (constraint diferida), cuadre de capas de costo, no-negatividad del stock, coherencia de unidad de medida, `updated_at`, proyección de saldos.

**No van a la base:** qué lote consumir, cómo prorratear un flete, qué asiento generar, cómo calcular un margen, la matriz de transiciones de las máquinas de estado. Todo eso vive en `packages/domain` en TypeScript testeable.

### Irreversibilidad en la base, matriz en el dominio

**La base impone la irreversibilidad: los estados de los que no se vuelve. La matriz completa de transiciones —qué estado puede seguir a cuál, cuándo y por decisión de quién— vive en el dominio.**

"No se vuelve" cubre dos casos: los terminales, que no se abandonan (`reversed`; el lote sellado en `open_for_decant`), y los definitivos, que solo avanzan (`posted` pasa a `reversed` y nunca vuelve a `draft`). "Irreversible" significa acá que no hay vuelta a un estado anterior; no tiene que ver con los "efectos irreversibles" de RN-EST ni con el estado `reversed` como tal.

La línea cae ahí por lo que cuesta cada lado. Una transición común se puede equivocar, corregir y rehacer: cambiarla es cambiar código con su test. Un estado del que no se vuelve es inmutabilidad aplicada a una columna de estado: si la base no lo impone, cualquiera con permiso de escritura reabre lo que estaba cerrado, lo edita y lo vuelve a cerrar sin rastro.

**Cuándo lo impone la base.** Cuando volver atrás desarmaría otros invariantes de la base, porque se apoyan en que ese estado no se abandone. Hoy son dos. El estado del asiento es la premisa de que sus líneas no cambien (`guard_posted_journal`). El del lote sellado abierto es la premisa de que no admita ningún movimiento (`assert_sealed_lot_not_open`, RN-LOT-03). Para un caso nuevo alcanza una pregunta: **¿volver de este estado desarmaría algún invariante de la base?** Si sí, la base impone que no se vuelva. Si no, es del dominio, aunque el estado sea terminal y aunque sea una regla importante: que importe, o que sea terminal, no alcanza.

Por eso los terminales de la orden de compra (`received`, `cancelled`), el pedido de venta (`cancelled`, `refunded`) y la orden de fraccionamiento (`done`, `cancelled`) siguen en el dominio, con su máquina en `packages/domain`: si una de esas órdenes volviera atrás, ningún invariante de la base se desarmaría. Alguno lee su estado —`decant_done_requires_actuals` exige los datos reales para `done`—, pero se sigue cumpliendo si la orden retrocede: exigir datos para entrar a un estado no es apoyarse en que no se salga de él. Si eso cambiara, rige la misma pregunta.

Para sostener la irreversibilidad la base lleva las aristas que hacen falta y no más. En el asiento, que tiene tres estados, eso la deja con el mapa entero (ver más abajo). El dominio lo replica para consultarlo antes de intentar la transición, y lo que decide —qué generar, cuándo, con qué líneas— sigue siendo suyo.

## Casos de estado y proyección que hoy están en la base

No es un inventario de los triggers de la base.

### Proyección de saldos

La de `inventory_balances` la mantiene un trigger. No es lógica de negocio ni una transición: es la materialización de una suma, con el `CHECK` de no-negatividad como invariante real. La alternativa —mantenerla en el servicio— dejaría el invariante a merced de que nadie escriba por fuera.

### Asiento contable

WP-B14, 2026-09-25. `trg_journal_entry_guard` (`0020_journal_immutability.sql`). El asiento tiene tres estados y la base lleva su mapa completo: nace en `draft`, y rechaza toda arista que no sea `draft → draft`, `draft → posted` y `posted → reversed`. Esta última no toca ninguna otra columna y exige que exista su reversión contabilizada, porque RN-CTB-06 deshace un asiento con un asiento inverso, no con una marca. Las líneas de un asiento que no es borrador tampoco cambian (`guard_posted_journal`). Es la inmutabilidad del libro contable: sin impedir que `posted` vuelva a `draft`, cualquiera con `accounting.journal:write` reabre el asiento, lo edita y lo vuelve a contabilizar sin rastro.

Sigue en el dominio qué asiento generar, cuándo contabilizarlo, cuándo revertirlo y con qué líneas. El mapa está replicado en `packages/domain/src/accounting/journalEntry.ts`, y la aplicación lo consulta antes de intentar la transición.

### Lote sellado abierto

WP-B08c, 2026-09-25. `trg_sealed_lot_terminal` (`0023_cross_tenant_fks.sql`): un lote **sellado** no sale de `open_for_decant`. Es inmutabilidad física, no una regla importante: un frasco abierto no se desabre. Si se permitiera, alcanzaría un UPDATE del estado a `available` para eludir `assert_sealed_lot_not_open` y:

- vender como sellado un frasco abierto (RN-LOT-03);
- abrir dos veces el mismo frasco (caso borde 5).

El granel hijo, que también está en `open_for_decant`, no queda alcanzado: sigue a `depleted` (RN-LOT-04). Sigue en el dominio cuándo abrir un frasco, cuál, y cómo separar la unidad de un lote de varios (caso borde 21, WP-C11).

José decidió el 2026-09-25 que el lote sellado abierto "es terminal y rechaza cualquier movimiento", y el 2026-09-30 confirmó que "terminal" incluye el estado, no solo los movimientos: el trigger que impide sacarlo de `open_for_decant` es parte de la regla.

## Consecuencias

**Positivas.** La lógica es visible, testeable y depurable. Los invariantes se cumplen incluso cuando alguien abre `psql` a las dos de la mañana, que es exactamente el escenario para el que existen. El argumento "la API es el único escritor, así que no hace falta" es cierto hasta que deja de serlo. Los estados terminales que la base no cuida dejan de ser una excepción que justificar: tienen un criterio.

**Negativas.** Los errores de invariante llegan a la aplicación como excepciones de PostgreSQL y hay que traducirlos a mensajes útiles. Se resuelve con un mapeador de `ERRCODE` en el middleware de errores. Cada estado que se imponga en la base cuesta además un trigger que falla cerrado y su prueba en `invariants.sql`: por eso el criterio es estrecho. Y ninguna prueba ata hoy el mapa del asiento en la base al del dominio: cada lado prueba su copia.

## Alternativas descartadas

- **Sumar una cuarta excepción a ADR-017.** Cada estado terminal nuevo pediría la suya, y la regla perdería contenido.
- **Reescribir ADR-017 en el lugar.** Las migraciones `0018`, `0020` y `0023` citan su texto y no se pueden editar; sus citas apuntarían a algo que ya no existe.
- **Llevar a la base la matriz de todas las máquinas de estado.** Cada estado costaría un trigger, su prueba y su mapeo de `ERRCODE`, y cambiar una matriz pasaría a ser una migración en vez de código con su test. Además, ningún invariante de la base lee hoy esos estados.
- **El criterio "¿esta transición reabre algo ya cerrado?".** Da "sí" para cualquier salida de un terminal (`received`, `done`, `refunded`), justo lo que esta decisión deja en el dominio. Lo que separa los casos es si volver atrás desarmaría un invariante de la base.

## Mapa de las excepciones de ADR-017

ADR-017 queda intacto, así que las citas a sus excepciones siguen siendo ciertas. Esta tabla las traduce al vocabulario de esta decisión.

| En ADR-017 (y donde se cita)                                          | Acá                                               |
| --------------------------------------------------------------------- | ------------------------------------------------- |
| "Excepción anotada" — proyección de saldos (`0018`)                   | Proyección de saldos                              |
| "Segunda excepción anotada" — WP-B14 (`docs/backlog.md`)              | Asiento contable                                  |
| "Tercera excepción anotada" — WP-B08c (`0023`, `docs/backlog.md`)     | Lote sellado abierto                              |
| Regla: "transiciones de máquinas de estado" no van a la base (`0020`) | Irreversibilidad en la base, matriz en el dominio |
