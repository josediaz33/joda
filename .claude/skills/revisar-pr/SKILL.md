---
name: revisar-pr
description: Usar cuando el usuario pide revisar un PR, revisar la rama de alguien, hacer la revisión cruzada de un cambio, o dice "revisá el PR de <rama/persona/WP>" o "hacé la revisión cruzada de <rama>". Aplica el prompt de docs/runbooks/prompts-playbook.md §4.2 (las siete preguntas y el circuito) y solo reporta — nunca corrige código.
---

# Revisión cruzada de un PR

**No dupliques el prompt acá.** `docs/runbooks/prompts-playbook.md` §4.2 ya tiene las siete preguntas, en orden, y la línea del circuito. Esta skill existe para que se aplique siempre igual, no para llevar una segunda copia que se pueda desincronizar de la primera.

## Cómo revisar

1. Abrí `docs/runbooks/prompts-playbook.md` y leé §4.2 completo, tal como está escrito ahí.
2. Identificá la rama a revisar (la que el usuario nombró, o preguntá si no la nombró).
3. Aplicá el prompt de §4.2 contra esa rama, palabra por palabra: las siete preguntas en el orden en que están, y la línea del circuito al final.

**Importa que sea una mirada nueva y limpia, sin el sesgo de quien escribió el código:** un agente que acaba de escribir el código está sesgado a validarlo. Si esta sesión ya trabajó en la rama que va a revisar, decilo antes de arrancar — el sesgo no desaparece porque se lo nombre, pero al menos queda declarado.

**No arregles nada. Solo reportá** — es literalmente lo que dice §4.2, y es la primera cosa que se pierde si alguien empieza a "ayudar" corrigiendo lo que encuentra.

## El circuito, en la práctica

Si esta skill corre dentro del subagente `revisor` (ver `.claude/agents/revisor.md`), el circuito de §4.2 además es mecánico, no solo una instrucción: el subagente no tiene `Edit` ni `Write` entre sus herramientas, así que no podría aplicar un arreglo aunque quisiera. Los hallazgos vuelven a la sesión de desarrollo, que es la que tiene la rama y el contexto de por qué cada cosa quedó como quedó.
