---
name: tomar-wp
description: Usar cuando el usuario pide tomar un paquete de trabajo del backlog, implementar un WP, o arrancar WP-XXX (por ejemplo "tomá WP-A07", "arrancá el WP-B04", "implementá el paquete de decants"). Ejecuta el WP de punta a punta —rama, contexto, implementación, autoverificación y PR— en esta misma sesión. No arma un prompt para correr después: hace el trabajo.
---

# Tomar un paquete de trabajo

**Esta skill NO devuelve un prompt. Ejecuta el trabajo.** Si en algún momento el resultado de seguir estos pasos es un bloque de texto listo para pegar en otra sesión en vez de una rama con commits, algo se torció — volvé a leer este archivo, no sigas por ese camino. Ya pasó una vez, al tomar WP-A08 (reportado por José al pedir esta reescritura; no hay registro escrito del incidente en el repo, así que si vuelve a pasar vale la pena dejar constancia en el PR): la skill terminó redactando un prompt en vez de implementar.

Seguí estos siete pasos, en orden, para el WP que el usuario nombró:

1. **Crear la rama antes de tocar nada.** `git checkout -b feat/<área>-<tema>` (o `fix/`/`db/` según corresponda, CONTRIBUTING.md §2). Nunca trabajar sobre `main`.

2. **Buscar si hay una sesión escrita para este WP.** Revisá `docs/runbooks/prompts-playbook.md` §2: si tiene una sesión para este WP, leerla primero — trae las trampas específicas del área y los números concretos del criterio de aceptación, y la tabla "Trampas por área" de §3 si hace falta completar el panorama. Si no hay sesión escrita, armar el contexto desde la fila del backlog y los documentos del área (paso siguiente).

3. **Leer la fila del WP en `docs/backlog.md`** y los documentos del área que correspondan (la tabla de `AGENTS.md` §Documentación, más el archivo de `.claude/rules/` de esa área — nombralo explícitamente, no asumas que se cargó solo).

   **Si el criterio de aceptación del playbook (paso 2) y el del backlog no coinciden, no elijas uno de los dos.** Parate y reportá la diferencia. El backlog es la fuente de verdad; el playbook es una guía que puede haber quedado atrás.

4. **Identificar las ambigüedades antes de escribir código, y preguntarlas todas juntas.** No implementes media tarea, te topes con una regla de negocio contraintuitiva a mitad de camino, y ahí recién preguntes — juntá las dudas primero (¿una regla que `docs/domain-rules.md` no cubre? ¿un criterio ambiguo? ¿una decisión de negocio que no es tuya, como las del playbook §7?) y consultalas de una vez.

5. **Implementar.** Solo el alcance del WP. Si en el camino aparece otro problema, anotalo y seguí — no lo arregles de paso.

6. **Autoverificar sin arreglar todavía.** Recorré la lista de `AGENTS.md`/`CLAUDE.md` "Cómo verificar tu trabajo" y la de `docs/engineering-principles.md` Parte V "Lista de verificación antes de abrir un PR", y reportá cada punto con la salida real de los comandos. Si algo no cumple, listalo — no lo corrijas todavía ni lo des por bueno en silencio.

7. **Abrir el PR con la plantilla de `CONTRIBUTING.md` §4.2.**

## Si el WP no existe, ya está hecho, o tiene dependencias sin cumplir

Decilo y parate ahí — no inventes un WP parecido ni sigas adelante con un `☑` de dependencia sin verificar en `docs/backlog.md`.
