# ADR-026 — La base impone la irreversibilidad; la matriz de transiciones vive en el dominio

- **Estado:** Aceptada
- **Fecha:** 2026-09-30
- **Ámbito:** Base de datos
- **Reemplaza:** ADR-017 (entero). El principio "la base hace cumplir invariantes, la aplicación calcula decisiones" se conserva; cambia la regla sobre las máquinas de estado y desaparecen sus tres excepciones anotadas.
- **Nota (2026-10-01):** la lista de guardas que impone hoy la base salió de este ADR y vive en `docs/data-model.md` §4.6. Cambia con cada caso nuevo y un ADR no se reescribe por eso. No cambia la decisión ni el criterio.

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

**Cuándo lo impone la base.** Cuando volver atrás desarmaría otros invariantes de la base, porque se apoyan en que ese estado no se abandone. Para un caso nuevo alcanza una pregunta: **¿volver de este estado desarmaría algún invariante de la base?** Si sí, la base impone que no se vuelva. Si no, es del dominio, aunque el estado sea terminal y aunque sea una regla importante: que importe, o que sea terminal, no alcanza.

Apoyarse en un estado es más que leerlo. Una restricción que exige datos para entrar a un estado lo lee, pero se sigue cumpliendo si la fila sale de él: no es una premisa de que no se salga. Lo que se desarma al volver atrás es lo que da por hecho que el estado no se abandona.

Para sostener la irreversibilidad la base lleva las aristas que hacen falta y no más: el mapa entero cuando el estado es chico y todas sus aristas importan, una sola entrada cuando alcanza con eso. El dominio replica el mapa para consultarlo antes de intentar la transición, y lo que decide —qué generar, cuándo, con qué líneas— sigue siendo suyo.

**Dónde está la lista.** Qué guardas impone hoy la base, y qué estados terminales se evaluaron y quedaron en el dominio, está en `docs/data-model.md` §4.6, «Guardas de irreversibilidad vigentes». Esa lista cambia con cada caso nuevo; este ADR cambia solo si cambia el criterio. Sumar una guarda, o decidir que un terminal no la lleva, se anota ahí, con la respuesta a la pregunta de arriba.

## Proyección de saldos

La de `inventory_balances` la mantiene un trigger. No es lógica de negocio ni una transición: es la materialización de una suma, con el `CHECK` de no-negatividad como invariante real. La alternativa —mantenerla en el servicio— dejaría el invariante a merced de que nadie escriba por fuera. No es un caso de irreversibilidad y no figura en la lista de `docs/data-model.md` §4.6.

## Consecuencias

**Positivas.** La lógica es visible, testeable y depurable. Los invariantes se cumplen incluso cuando alguien abre `psql` a las dos de la mañana, que es exactamente el escenario para el que existen. El argumento "la API es el único escritor, así que no hace falta" es cierto hasta que deja de serlo. Los estados terminales que la base no cuida dejan de ser una excepción que justificar: tienen un criterio.

**Negativas.** Los errores de invariante llegan a la aplicación como excepciones de PostgreSQL y hay que traducirlos a mensajes útiles. Se resuelve con un mapeador de `ERRCODE` en el middleware de errores. Cada estado que se imponga en la base cuesta además un trigger que falla cerrado y su prueba en `invariants.sql`: por eso el criterio es estrecho. Y cuando la base impone parte de una matriz que el dominio también modela, las dos copias pueden divergir: cada lado prueba la suya, salvo que exista una prueba de paridad (`docs/data-model.md` §4.6 dice cuáles).

## Alternativas descartadas

- **Sumar una cuarta excepción a ADR-017.** Cada estado terminal nuevo pediría la suya, y la regla perdería contenido.
- **Reescribir ADR-017 en el lugar.** Las migraciones `0018`, `0020` y `0023` citan su texto y no se pueden editar; sus citas apuntarían a algo que ya no existe.
- **Llevar a la base la matriz de todas las máquinas de estado.** Cada estado costaría un trigger, su prueba y su mapeo de `ERRCODE`, y cambiar una matriz pasaría a ser una migración en vez de código con su test. Además, lo único que la base necesita de un estado es que no se abandone, y eso lo cubre una guarda de irreversibilidad, no la matriz.
- **El criterio "¿esta transición reabre algo ya cerrado?".** Da "sí" para cualquier salida de un terminal (`received`, `done`, `refunded`), que esta decisión deja en el dominio salvo que desarme un invariante de la base. Lo que separa los casos es si volver atrás desarmaría un invariante de la base.

## Mapa de las excepciones de ADR-017

ADR-017 queda intacto, así que las citas a sus excepciones siguen siendo ciertas. Esta tabla las traduce al vocabulario de esta decisión.

| En ADR-017 (y donde se cita)                                          | Acá                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------- |
| "Excepción anotada" — proyección de saldos (`0018`)                   | Proyección de saldos (más arriba)                       |
| "Segunda excepción anotada" — WP-B14 (`docs/backlog.md`)              | Guarda del asiento contable (`data-model.md` §4.6)      |
| "Tercera excepción anotada" — WP-B08c (`0023`, `docs/backlog.md`)     | Guarda del lote sellado terminal (`data-model.md` §4.6) |
| Regla: "transiciones de máquinas de estado" no van a la base (`0020`) | Irreversibilidad en la base, matriz en el dominio       |
