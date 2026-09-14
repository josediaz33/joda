---
name: revisar-pr
description: Usar cuando el usuario pide revisar un PR, revisar la rama de alguien, hacer la revisión cruzada de un cambio, o dice "revisá el PR de <rama/persona/WP>" o "hacé la revisión cruzada de <rama>". Aplica el prompt de docs/runbooks/prompts-playbook.md §4.2 con las siete preguntas y solo reporta — nunca corrige código.
---

# Revisión cruzada de un PR

Esta skill es el prompt de `docs/runbooks/prompts-playbook.md` §4.2, para que corra siempre igual sin que alguien tenga que copiarlo a mano cada vez.

**Importa que sea una sesión nueva y limpia, sin el contexto de quien escribió el código:** un agente que acaba de escribir el código está sesgado a validarlo. Si esta sesión ya trabajó en la rama que va a revisar, decilo antes de arrancar — el sesgo no desaparece porque se lo nombre, pero al menos queda declarado.

## Cómo revisar

Revisá el PR de la rama indicada **como si no lo hubieras escrito vos**.

Leé `AGENTS.md`/`CLAUDE.md`, `docs/engineering-principles.md` y los documentos del área que toca el cambio (la tabla de `AGENTS.md` §Documentación dice cuáles).

Decime, en este orden:

1. ¿Resuelve el problema declarado en el PR?
2. ¿Viola alguna regla no negociable de `AGENTS.md`/`CLAUDE.md` o algún ADR? Citá cuál.
3. ¿Los tests prueban comportamiento o implementación?
4. ¿Qué no va a entender alguien que lea esto en seis meses?
5. Verificá las afirmaciones sobre el esquema, los documentos o el comportamiento de terceros que haga el código o el PR. No las des por buenas: abrí `packages/db/migrations`, los tests SQL y los documentos citados, y confirmá que dicen lo que el PR dice que dicen.
6. Si el PR declara algo como "anotado en el backlog", "pendiente de otra WP" o "fuera de alcance", verificá que exista realmente, con ID y criterio de aceptación. Un comentario que promete una WP inexistente es peor que un pendiente declarado.
7. Si algo no se puede verificar con la evidencia disponible, decilo así. No completes con la explicación más plausible.

**No arregles nada. Solo reportá.**

## El circuito

El revisor solo reporta. Los hallazgos vuelven a la sesión de desarrollo, que es la que tiene la rama y el contexto de por qué cada cosa quedó como quedó. Una vez entregado el análisis, la sesión de revisión se cierra: dos sesiones opinando sobre el mismo código se contradicen.

Si esta skill corre dentro del subagente `revisor` (ver `.claude/agents/revisor.md`), el circuito además es mecánico: el subagente no tiene `Edit` ni `Write` entre sus herramientas, así que no podría aplicar un arreglo aunque quisiera.
