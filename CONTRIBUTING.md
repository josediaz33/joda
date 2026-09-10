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
docker compose up -d          # postgres + redis
pnpm db:reset                 # migraciones + seed
pnpm dev
```

**Objetivo: menos de 15 minutos desde cero.** Si tardaste más, algo del arranque está mal documentado y arreglarlo es parte del trabajo.

Verificación de que quedó bien:

```bash
pnpm db:test        # 18/18 invariantes en verde
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

---

## 2. Ramas

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

| Cambiaste… | Actualizá… |
|---|---|
| Una regla de negocio | `docs/domain-rules.md` |
| El esquema | `docs/data-model.md` + `packages/db/README.md` |
| Un contrato del dominio | `docs/domain-contracts.md` |
| Un endpoint o convención | `docs/api-conventions.md` |
| Interfaz, estilos, tokens o SEO | `docs/frontend-spec.md` |
| Permisos o seguridad | `docs/security-spec.md` |
| Un término de negocio | `GLOSARIO.md` |
| Una decisión estructural | Un ADR nuevo en `docs/adr/` |
| Comandos o reglas del proyecto | `CLAUDE.md` |

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

Cuando exista el pipeline de CI (WP-A02), evaluar GitHub Pro y activar
`required_status_checks` del lado del servidor con los nombres de los jobs
— eso sí protege contra un force-push, cosa que el hook no puede.
