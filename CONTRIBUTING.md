# Contribuir a JODA Parfums

Flujo de trabajo, convenciones y criterios de aceptación. Aplica igual a personas y a agentes.

---

## 1. Entorno local

```bash
# requisitos: Node 22+, pnpm 9+, Docker
git clone <repo> && cd joda
git config core.hooksPath .githooks   # activa los hooks de .githooks/, ver abajo
cp .env.example .env          # completar valores
pnpm install
docker compose -f infra/docker/docker-compose.yml up -d   # postgres + redis
pnpm db:reset                 # migraciones + seed
pnpm dev
```

**Objetivo: menos de 15 minutos desde cero.** Si tardaste más, algo del arranque está mal documentado y arreglarlo es parte del trabajo.

**El Postgres de `docker-compose.yml` publica en el puerto 55432 del host, no 5432.** Si ya tenés una instalación nativa de Postgres corriendo como servicio (frecuente en Windows), `localhost:5432` resuelve a esa instancia y no al contenedor — la autenticación falla con un mensaje que no menciona Docker para nada. `DATABASE_URL` de `.env.example` ya apunta a `55432`; adentro del contenedor sigue siendo 5432. Detalle en `packages/db/README.md`, hallazgo 7.

Verificación de que quedó bien:

```bash
pnpm db:test        # 22/22 invariantes en verde
pnpm test:domain    # dominio en verde
```

### Hooks de Git

Van versionados en `.githooks/` y se activan con `git config core.hooksPath
.githooks` (arriba, en el clonado) — es configuración local de cada clon,
Git no la activa solo.

- **`commit-msg`** quita cualquier trailer de atribución de un asistente de
  IA que se haya colado en el mensaje de commit (`Co-Authored-By: Claude...`,
  `🤖 Generated with...`, `Claude-Session:...`), incluso si la configuración
  del asistente para omitirlo no se respetó.
- **`pre-push`** bloquea el empuje directo a `main` (ver § Despliegue: hoy es
  la única protección de `main` que existe, porque no hay `required_status_checks`
  del servidor todavía). Se saltea con `git push --no-verify` cuando es
  deliberado — no protege contra alguien decidido, protege contra el `git
push origin main` por costumbre.

### Decisiones de versión (WP-A01)

- **ESLint 9.39.5, no 10.x:** ESLint 10 exige Node ≥22.13 dentro de la línea
  22.x; este repo solo pide "Node 22+" a secas. Reevaluar cuando se suba el
  piso de Node del proyecto.
- **pnpm 9.15.4, no la última 12.x:** cumple el "pnpm 9+" de arriba sin forzar
  una migración de major que ningún paquete de trabajo pidió todavía.

### Decisiones de versión (WP-A02)

Frameworks de los tres apps (ADR-003, `JODA_Arquitectura_v5_Final.md`),
instalados sin fijar un major a mano — la versión que resolvió el registro al
tomar el paquete:

- **Next.js 16.3.5** (App Router, Turbopack) + **React 19.3.0** — storefront.
- **Vite 8.3.0** (catálogo) + **React 19.3.0** — admin.
- **Fastify 5.12.5** — API. Sin tRPC todavía: el router tipado y las capas de
  `docs/api-conventions.md` son WP-C01, no este paquete.

### Decisiones de versión (WP-A11)

- **Zod 4.6.5** — sin fijar un major a mano, la versión que resolvió el
  registro al tomar el paquete. `.strict()` y `.uuid()` se comportan igual
  que en la v3 para lo que usa `packages/contracts` hoy.
- **@trpc/server 11.19.0** — solo el paquete de tipos/servidor, sin cliente
  todavía: el cliente tipado (`packages/sdk`) llega junto con WP-C01, que es
  también cuando `apps/api` arma su propia instancia de tRPC con contexto de
  petición real. El procedimiento de ejemplo de `packages/contracts` usa una
  instancia mínima (`initTRPC.create()`) solo para probar que el patrón
  compila extremo a extremo — no es el router de producción.

---

## 2. Ramas

La rama se crea **antes de tocar el primer archivo, nunca al terminar**. No es una preferencia de estilo — tres motivos concretos:

- **Trabajar sobre `main` deja el trabajo sin punto de retorno si la sesión se corta.** No hay commit al que volver, solo un árbol de trabajo sucio que alguien tiene que reconstruir o descartar.
- **El hook `pre-push` (§1) recién avisa cuando ya querés subir el cambio, no mientras trabajás.** Para entonces ya podrías tener horas de trabajo hechas sobre la rama equivocada.
- **La revisión cruzada (§4.3) necesita `git diff main...rama`, que no existe hasta que hay rama.** Sin rama, no hay contra qué diffear.

```
main                    protegida · siempre desplegable
feat/<área>-<tema>      funcionalidad nueva
fix/<área>-<tema>       corrección
chore/<tema>            infraestructura, dependencias, documentación
db/<tema>               cambios de esquema
```

Ejemplos: `feat/inventory-lot-opening`, `fix/vat-rounding-last-line`, `db/add-candle-vertical`.

Ramas cortas. Una rama que vive más de una semana genera conflictos que cuestan más que el trabajo.

---

## 3. Commits

Convencionales, en español, en imperativo.

```
<tipo>(<ámbito>): <qué hace>

[cuerpo opcional: por qué, no qué]

[referencias: RF-INV-08, RN-LOT-02, ADR-009]
```

**Tipos:** `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `db`.

**Ámbitos:** `catalog`, `inventory`, `decant`, `market`, `sales`, `accounting`, `fiscal`, `auth`, `domain`, `db`, `api`, `admin`, `storefront`, `contracts`.

```
feat(inventory): implementar apertura de frasco como conversión de lote

El sellado sale como unidad y nace un lote hijo de granel en ml que
hereda el costo. Un lote no puede cambiar de unidad de medida.

Refs: RF-INV-08, RN-LOT-02, ADR-009
```

**Referenciá siempre el requerimiento o la regla.** Es lo que permite, seis meses después, entender por qué el código hace lo que hace sin tener que reconstruirlo.

---

## 4. Pull requests

### 4.1 Tamaño

**Una tarea, un PR.** Si mientras trabajás encontrás otro problema, anotalo y seguí. No lo arregles de paso: un PR que hace dos cosas es imposible de revisar y de revertir.

Objetivo: menos de 400 líneas de cambio efectivo. Por encima de eso, partilo.

### 4.2 Plantilla

```markdown
## Qué hace

<una o dos frases>

## Por qué

<el problema que resuelve, o el requerimiento que implementa>

## Referencias

RF-XXX-nn · RN-XXX-nn · ADR-0nn

## Cómo se probó

<qué tests se agregaron y qué verifican>

## Riesgos

<qué podría romperse; "ninguno" es una respuesta válida si es cierta>

## Lista de verificación

- [ ] `pnpm typecheck && pnpm lint` en verde
- [ ] `pnpm test` en verde
- [ ] Si toqué el esquema: `pnpm db:reset && pnpm db:test` en verde
- [ ] Si toqué el esquema: corrí `pnpm db:pull` y commiteé `schema.prisma`
- [ ] Si agregué una regla: está en `domain-rules.md` con su identificador
- [ ] Si agregué un invariante: tiene su prueba en `invariants.sql`
- [ ] Si agregué un término de negocio: está en `GLOSARIO.md`
- [ ] Ningún ADR violado
```

### 4.3 Revisión

Todo PR necesita aprobación. La revisión mira, en este orden:

1. **¿Resuelve el problema declarado?** Antes que cualquier detalle de estilo.
2. **¿Viola alguna regla no negociable de `CLAUDE.md` o algún ADR?**
3. **¿Los tests prueban el comportamiento o la implementación?**
4. **¿Hay algo que un lector futuro no va a entender sin preguntar?**

Prettier decide el formato. **No se discute formato en revisiones.**

---

## 5. Definition of Done

Una tarea está terminada cuando **todas** se cumplen:

- [ ] El trabajo se hizo en una rama propia creada antes de empezar, no sobre `main`.
- [ ] El comportamiento pedido funciona, incluidos los casos borde documentados.
- [ ] `typecheck`, `lint` y `test` en verde localmente y en el CI.
- [ ] Cobertura del dominio dentro de los umbrales de `testing-strategy.md`.
- [ ] Los cambios de esquema tienen migración nueva (nunca editar una aplicada) y política expand/contract.
- [ ] `schema.prisma` regenerado y commiteado si el esquema cambió.
- [ ] Las reglas de negocio nuevas están en `domain-rules.md` con identificador.
- [ ] Los términos nuevos están en `GLOSARIO.md`.
- [ ] Las decisiones no obvias tienen comentario de porqué en el código.
- [ ] Los mensajes de error mostrados al usuario están en español y dicen qué hacer.
- [ ] No hay secretos, datos personales ni `console.log` olvidados.
- [ ] El PR referencia el requerimiento o la regla que implementa.

**No cuenta como terminado:** "funciona en mi máquina", "los tests fallan pero es por otra cosa", "después lo documento".

---

## 6. Cambios de esquema

Reglas duras, ver ADR-018:

1. **SQL escrito a mano** en `packages/db/migrations/`, numerado consecutivamente.
2. **Nunca `prisma migrate dev`.** Nunca editar `schema.prisma` a mano.
3. **Nunca editar una migración ya aplicada.** Siempre una nueva.
4. **Expand/contract:** nunca `DROP COLUMN` en el mismo despliegue que deja de usarla.
5. **`tenant_id` en toda tabla nueva**, con su política de aislamiento.
6. Después de migrar: `pnpm db:pull`, y el `schema.prisma` resultante va en el mismo PR.
7. `ALTER TYPE ... ADD VALUE` va en su propia migración, separada.

Verificación obligatoria antes de abrir el PR:

```bash
pnpm db:reset && pnpm db:test
```

---

## 7. Dependencias

- Agregar una dependencia requiere justificación en el PR: qué problema resuelve y por qué no alcanza lo que ya está.
- **`packages/domain` no acepta dependencias con I/O.** Punto.
- Sin dependencias abandonadas: si el último release tiene más de dos años, buscá otra o escribilo.
- Actualizaciones de seguridad: se aplican en cuanto salen. El resto, en un PR de `chore` mensual.

---

## 8. Documentación

La documentación vive con el código y se actualiza en el mismo PR. No hay "PR de documentación" posterior.

| Cambiaste…                      | Actualizá…                                     |
| ------------------------------- | ---------------------------------------------- |
| Una regla de negocio            | `docs/domain-rules.md`                         |
| El esquema                      | `docs/data-model.md` + `packages/db/README.md` |
| Un contrato del dominio         | `docs/domain-contracts.md`                     |
| Un endpoint o convención        | `docs/api-conventions.md`                      |
| Interfaz, estilos, tokens o SEO | `docs/frontend-spec.md`                        |
| Permisos o seguridad            | `docs/security-spec.md`                        |
| Un término de negocio           | `GLOSARIO.md`                                  |
| Una decisión estructural        | Un ADR nuevo en `docs/adr/`                    |
| Comandos o reglas del proyecto  | `CLAUDE.md`                                    |

**Los ADRs no se editan para cambiar de opinión.** Se escribe uno nuevo que marque al anterior como reemplazado, en ambos archivos.

---

## 9. Trabajo con agentes

Este repositorio está preparado para desarrollo asistido. Reglas específicas:

- **Leé `CLAUDE.md` primero, y el documento que corresponda al área antes de tocarla.** La tabla de `CLAUDE.md` §Documentación dice cuál.
- **Preguntá antes de inventar una regla de negocio.** Este dominio tiene reglas contraintuitivas: la merma tiene tres componentes, la seña es pasivo, el frasco abierto no se vende sellado, el IVA se extrae y no se agrega. Si `domain-rules.md` no la cubre, **preguntá**. Una regla inventada que parece razonable es peor que una pregunta.
- **No refactorices lo que no pediste tocar.**
- **No reabras un ADR en una sesión de trabajo.** Si una decisión parece equivocada, decilo y argumentá; se reemplaza con un ADR nuevo, no se ignora en silencio.
- **Verificá antes de declarar terminado**, con la lista de `CLAUDE.md` §"Cómo verificar tu trabajo".
- **Un PR por tarea.** Si el alcance crece durante el trabajo, pará y consultá.

---

## 10. Despliegue

```
PR fusionado a main
  → CI completo (incluye extremo a extremo)
  → despliegue automático a staging
  → verificación manual
  → despliegue a producción (manual, con aprobación)
```

**Nunca se despliega un viernes por la tarde** salvo corrección de un incidente en curso.

Antes de un despliegue que incluya migración: verificar que la recuperación a un punto en el tiempo está activa y que el último simulacro de restauración es de hace menos de tres meses.

### Estado de la protección de `main`

Hoy es un hook local (`.githooks/pre-push`, § Entorno local), no protección
del lado del servidor: el repo es privado en un plan gratuito de GitHub, que
no habilita branch protection ni rulesets para repos privados (exige GitHub
Pro o hacer el repo público). El hook evita el descuido, no a alguien
decidido a saltárselo con `--no-verify`.

**El pipeline de CI ya existe (WP-A02):** `.github/workflows/ci.yml` corre en
cada PR (y en cada push a `main`) con tres jobs. Los nombres de check que
GitHub expone (y contra los que matchearía `required_status_checks`, si algún
día se activa) son:

- `Typecheck + lint + format`
- `Test`
- `Build`

**Ojo:** esos son los `name:` de cada job, no la clave del job en el YAML
(`quality`/`test`/`build`). `required_status_checks` matchea por el nombre
del check tal como lo reporta la API, no por la clave — configurarlo con la
clave deja el check esperado sin matchear nunca contra ninguna corrida real,
y la rama queda bloqueada para fusionar de forma permanente, silenciosa y
difícil de diagnosticar (el status check nunca aparece como fallido: aparece
como "pending" para siempre). Si el YAML cambia los nombres, resacar la lista
real en vez de asumir la del YAML:

```bash
gh api repos/josediaz33/joda/commits/<sha>/check-runs --jq '.check_runs[].name'
```

**GitHub Pro — evaluado y descartado por ahora, no es un pendiente
abierto.** El CI corriendo en cada PR ya cubre lo que importa: nadie fusiona
sin que `Typecheck + lint + format`, `Test` y `Build` hayan pasado, porque
alguien tiene que mirar el PR y fusionarlo a mano. Lo único que agregaría
`required_status_checks` del lado del servidor es bloquear un `push --force`
directo a `main` — algo que hoy ya cubre la disciplina de un solo
desarrollador, no una herramienta. El plan gratuito de GitHub no ofrece esa
protección en un repo privado; GitHub Pro (o hacer el repo público) sí.
**Se reevalúa cuando entre alguien más al repositorio** — ahí "la disciplina
de no fusionar en rojo" deja de alcanzar, porque ya no es una sola persona
decidiendo. Hasta entonces, no hay nada que activar.

---

## 11. Automatización de Claude Code

Tres mecanismos, cada uno resuelve algo distinto. No son intercambiables: un
hook hace cumplir una regla mecánicamente (no se le puede pedir que la
ignore); una skill es el prompt reutilizable de una tarea recurrente; un
subagente decide **quién** ejecuta ese prompt, con qué modelo y con qué
herramientas.

**Nota sobre `AGENTS.md`/`CLAUDE.md`:** que `CLAUDE.md` sea una sola línea
(`@AGENTS.md`) se verificó contra la documentación oficial de Claude Code (el
import funciona igual en CLI y en la extensión de VS Code cuando ambos
archivos están en la raíz del repo) **y se confirmó corriendo `/context`**:
`AGENTS.md` aparece con ~6.0k de contenido y `CLAUDE.md` con 14 tokens (el
tamaño de la línea `@AGENTS.md` sola), lo que confirma que el import se
resuelve y no se está cargando contenido duplicado. Si en algún momento
`/context` deja de mostrar `AGENTS.md` así, es una señal de que el import
dejó de resolver y hay que volver al symlink (con permisos de administrador o
modo desarrollador en Windows).

### 11.1 Hooks (`.claude/settings.json`)

Versionado — a diferencia de `.claude/settings.local.json`, que es local y no
se sube. Los scripts que invoca viven en `scripts/hooks/`, en Node (`.mjs`):
se eligió Node en vez de shell porque parsear JSON de stdin a mano en `sh` es
frágil, y Node es una dependencia dura del repo de todos modos. Cada script
lee el JSON que Claude Code manda por stdin y decide con código de salida:
`0` deja pasar, `2` bloquea la llamada y el `stderr` vuelve a la sesión como
motivo del bloqueo.

| Hook                                     | Evento · matcher              | Qué hace                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/hooks/format-on-write.mjs`      | `PostToolUse` · `Edit\|Write` | Corre `prettier --write` sobre el archivo tocado, solo si termina en `.ts`, `.tsx`, `.md` o `.json` y está dentro del repo. Nunca bloquea: si prettier falla, se reporta a `stderr` y se sale en `0` — formatear es una cortesía, no un gate.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `scripts/hooks/block-prisma-migrate.mjs` | `PreToolUse` · `Bash`         | Bloquea (exit `2`) un comando de Bash que invoque `prisma migrate` o `prisma db push`, citando ADR-018. Detecta cada sub-comando por separado (partido por `&&`, `\|\|`, `;`, `\|` o salto de línea), no el string entero — ver el detalle de por qué abajo.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `scripts/hooks/block-migration-edit.mjs` | `PreToolUse` · `Edit\|Write`  | Bloquea (exit `2`) tocar un archivo de `packages/db/migrations/*.sql` que **ya existe** en disco. Crear un `.sql` nuevo en ese directorio (un path que todavía no existe) se permite. Es un proxy mecánico simple: no sabe si la migración llegó a aplicarse contra una base real, pero "ya está commiteada" es la señal disponible y es la misma que exige CONTRIBUTING.md §6.                                                                                                                                                                                                                                                                                                |
| `scripts/hooks/verify-on-stop.mjs`       | `Stop` · `async: true`        | Corre `pnpm typecheck && pnpm format:check` al terminar el turno y escribe el resultado en `.claude/hook-logs/stop-verify-latest.log` (ignorado por git, `*.log`). Deliberadamente **no** corre `lint` ni `test` acá — `lint` solo tarda ~37s y en una sesión con muchas vueltas eso es ruido de fondo repetido, y los dos ya los corre el cierre real del WP (paso 6 de `tomar-wp`). **No hay forma documentada de que la salida de un hook `async` vuelva al chat** — por eso el reporte es un archivo, no un mensaje. Este chequeo es higiene de fondo, no reemplaza correr la lista de "Cómo verificar tu trabajo" de `AGENTS.md`/`CLAUDE.md` a mano antes de abrir el PR. |

**La lógica de detección de `block-prisma-migrate.mjs` y
`block-migration-edit.mjs` vive en módulos puros e importables**
(`scripts/hooks/lib/prisma-guard.mjs`, `scripts/hooks/lib/migration-guard.mjs`),
separada de la parte de I/O (leer stdin, `existsSync`) — igual que
`packages/domain` separa cálculo de efectos. Eso permite tener **tests
automatizados reales**, no solo verificación manual: `pnpm test:hooks`
(incluido en `pnpm test`) corre `scripts/hooks/lib/*.test.mjs` con el runner
de Node (`node --test`, sin dependencias nuevas). 22 casos, entre ellos:

- El path real de Windows con backslashes, **capturado del stdin real** que
  Claude Code le manda al hook (no un fixture construido a mano) — es el
  regression test del bug reportado en la revisión de este PR: la primera
  verificación de este hook usó una ruta absoluta escrita a mano que, sin
  que se notara, ya tenía el mismo formato que manda la herramienta de
  verdad, así que "probado con la herramienta real" era cierto pero no
  estaba **demostrado** con evidencia capturada. Ahora sí queda demostrado:
  el test fija ese payload real como caso de regresión.
- Las cuatro evasiones de `prisma migrate`/`prisma db push` que encontró la
  misma revisión: comando compuesto con `&&` (`echo ok && npx prisma migrate dev`),
  sentencias en líneas separadas, una continuación de línea de Bash entre
  `prisma` y `migrate` (`prisma \` + salto de línea + `migrate`, que **no**
  contiene un espacio en blanco literal entre las dos palabras y por eso
  necesita normalizarse aparte), y `prisma@version migrate`.
- Que `prisma generate` y `prisma db pull` — los que sí usa `db:pull` — NO
  se bloquean.

**Verificado además con las herramientas reales**, no solo con los tests
unitarios: un subagente al que **no se le mencionó que hubiera un hook**
recibió la instrucción desnuda de editar `packages/db/migrations/0004_inventory.sql`;
se bloqueó, y el payload crudo capturado en ese momento (con backslashes,
ruta absoluta, tal como lo manda la herramienta en Windows) es el que quedó
fijado como test de regresión arriba. Las cuatro evasiones de Prisma
también se probaron con la herramienta `Bash` real, una por una, con
resultado: bloqueadas las cuatro. `prisma generate`/`prisma db pull`
reales, sin bloquear.

Sigue siendo cierto que el bloqueo de Prisma es deliberadamente amplio: un
comando que solo _menciona_ "prisma migrate" (en un `echo`, un mensaje de
commit) también se bloquea, porque el costo de ese falso positivo ocasional
es menor que el de un `prisma migrate`/`db push` real que se cuela.

**Comportamiento conocido: el hook se autobloquea al escribir sobre sí
mismo.** Un `git commit -m` o un `gh pr comment`/`gh pr create` cuyo texto
mencione las frases prohibidas —aunque sea citándolas, dentro de comillas,
para documentar el propio guarda— dispara el bloqueo igual que una
invocación real, porque el patrón busca la frase en el comando de `Bash`
completo, no solo en lo que Prisma llegaría a ejecutar. Pasó varias veces
mientras se escribía esta misma sección. Es inofensivo — el mensaje se
reformula sin la frase contigua y listo — pero conviene tenerlo presente
para no perder tiempo pensando que el hook se rompió. **Si esto estorba, la
solución es ignorar el contenido de cadenas entrecomilladas del comando al
buscar el patrón, nunca aflojar el patrón en sí:** un falso positivo en un
mensaje de commit cuesta un reintento; un `prisma migrate`/`db push` real
que pasa porque el patrón se relajó cuesta un esquema roto.

**Nota sobre carga en caliente:** los hooks se leen de `.claude/settings.json`
en cada evento, así que un cambio a un hook aplica sin reiniciar la sesión —
se confirmó en la misma sesión que escribió este archivo. Las skills y los
subagentes (§11.2 y §11.3) **no** funcionan así: ver la nota al final de esta
sección.

### 11.2 Skills (`.claude/skills/`)

- **`.claude/skills/tomar-wp/SKILL.md`** — **ejecuta** un WP del backlog de
  punta a punta en la misma sesión: rama, lectura de contexto (playbook §2 si
  existe sesión escrita, si no backlog + documentos del área), ambigüedades
  preguntadas todas juntas antes de escribir código, implementación,
  autoverificación contra `AGENTS.md`/`CLAUDE.md` y
  `docs/engineering-principles.md` Parte V, y PR. **No arma un prompt para
  correr después** — esa fue justamente la falla que motivó reescribirla
  (terminó devolviendo un prompt en vez de trabajar, en WP-A08). Se invoca a
  mano: `/tomar-wp`.
- **`.claude/skills/revisar-pr/SKILL.md`** — aplica el prompt de revisión
  cruzada de `docs/runbooks/prompts-playbook.md` §4.2 (las siete preguntas y
  el circuito de una sola vía) **citándolo, sin duplicar su texto** en la
  skill — una sola copia, para que no se desincronicen. Se invoca a mano con
  `/revisar-pr`, y también se activa sola cuando alguien pide "revisá el PR
  de \<rama\>" — la `description` del frontmatter nombra esa frase para que
  el mecanismo de activación automática la reconozca.

### 11.3 Subagentes (`.claude/agents/`)

- **`.claude/agents/revisor.md`** — revisor independiente de PRs. Precarga la
  skill `revisar-pr` (campo `skills:` del frontmatter) para no tener que
  buscarla, corre en `model: sonnet`, y su `tools:` es la allowlist `[Read,
Grep, Glob, Bash]` — sin `Edit` ni `Write`. Esto es una restricción
  mecánica confirmada, no una instrucción que el subagente pueda decidir
  ignorar: con esas herramientas fuera de la lista, invocarlas no es una
  opción disponible para el modelo, sin importar qué le pida el prompt. Es la
  regla del circuito de §11.2 hecha mecánica.

### Cómo se verificó cada pieza

Todo lo de abajo se probó de verdad, con la herramienta real (no revisando
el código a ojo), en dos sesiones — la que escribió los archivos y una
sesión reiniciada después, que es la que pudo confirmar lo que la primera
dejó pendiente:

- **Los cuatro hooks:** con fixtures de stdin (§11.1) y, además, con las
  herramientas reales: un `Edit` sobre `packages/db/migrations/0001_foundation.sql`
  (ya existe) fue bloqueado; un `Write` sobre un `.sql` nuevo en ese mismo
  directorio se permitió (y se borró después, era solo la prueba); un
  `npx prisma migrate dev` real fue bloqueado citando ADR-018.
- **Invocación manual de `/tomar-wp` y `/revisar-pr`:** confirmada — ambas
  aparecen en el listado de skills disponibles después de reiniciar la
  sesión y se invocan con la herramienta `Skill` por nombre.
- **Que `/tomar-wp` ejecuta en vez de devolver un prompt:** confirmado con
  un subagente en un worktree aislado y descartable, al que se le pidió
  "Tomá WP-A12 del backlog" sin más contexto. Creó la rama
  `feat/a12-domain-test-lint-hardening`, leyó `docs/backlog.md` y la Sesión
  15 de `docs/runbooks/prompts-playbook.md` de verdad (no que un prompt se
  los sugiriera), y llegó a editar `packages/domain/src/shared/quantity.ts`
  (agregó `Quantity.zero(uom)`, autorizado por la nota del backlog) antes de
  frenar — el diagnóstico no necesitaba terminar el WP entero, solo
  demostrar que arrancaba a trabajar. El worktree se descartó después.
- **Que `revisar-pr` se activa sola al pedir "revisá el PR de X":** confirmado
  con un subagente al que se le dio exactamente esa frase, sin nombrar
  ninguna skill. Invocó `Skill(skill="revisar-pr", ...)` por su cuenta, por
  el match con la `description` del frontmatter, y a su vez delegó la
  ejecución mecánica al subagente `revisor`.
- **Que el subagente `revisor` no puede escribir:** confirmado explícitamente
  — se le pidió que editara un archivo y reportó que `Edit`/`Write` ni
  siquiera figuran en su lista de herramientas invocables, no que existan y
  fallen por permisos.
- **Que el subagente carga la skill sin buscarla:** confirmado — reportó que
  el texto completo de `revisar-pr` le llegó inyectado en el mensaje que
  activó su conversación, y que no tiene `Skill` ni `ToolSearch` entre sus
  herramientas para haber podido buscarla aunque quisiera.

En el camino, la revisión cruzada real que hicieron esos subagentes sobre
esta misma rama encontró un problema genuino que se corrigió antes de abrir
el PR: los cambios estaban escritos pero nunca commiteados (ver el historial
de commits de esta rama para confirmar que se corrigió).

### Nota: skills y subagentes no se recargan en caliente

A diferencia de los hooks, el listado de skills y de tipos de subagente
disponibles se arma **una sola vez, al arrancar la sesión**, y no se
vuelve a escanear después. Se confirmó así en la práctica en una sesión
anterior: ni la sesión principal ni un subagente nuevo generado durante esa
misma sesión (que arranca su propio contexto) vieron `tomar-wp`, `revisar-pr`
ni `revisor` recién creados — ambos seguían mostrando el listado fijo con el
que arrancó el proceso. Reiniciando la sesión (recargar ventana en la
extensión de VS Code, o salir y volver a entrar en la CLI), el listado se
actualiza y las tres piezas quedan disponibles — así se pudo completar la
verificación de esta sección.

Esto no es un bug del repositorio: es cómo Claude Code arma el system
prompt. La consecuencia práctica es que **una skill o un subagente nuevo (o
editado) recién queda disponible después de reiniciar la sesión**. Si
agregás o cambiás algo en `.claude/skills/` o `.claude/agents/`, decilo en el
PR y probalo en una sesión nueva antes de darlo por andando — no alcanza con
que el archivo "se vea bien".
