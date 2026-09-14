---
name: tomar-wp
description: Usar cuando el usuario pide tomar un paquete de trabajo del backlog, implementar un WP, o arrancar WP-XXX (por ejemplo "tomá WP-A07", "arrancá el WP-B04", "implementá el paquete de decants"). Arma el prompt de tarea completo con rama, documentación a leer, criterio de aceptación y trampas del área, siguiendo docs/runbooks/prompts-playbook.md.
---

# Tomar un paquete de trabajo

Esta skill arma el prompt de tarea para un WP del backlog, siguiendo la anatomía de `docs/runbooks/prompts-playbook.md` §1. No es una descripción libre: son seis puntos fijos, y el punto 0 va antes que cualquier otra cosa.

## Los seis puntos de la anatomía (§1 del playbook)

```
0. RAMA          crearla antes de tocar cualquier archivo
1. QUÉ LEER      los documentos específicos del área (CLAUDE.md/AGENTS.md no los carga)
2. QUÉ HACER     el identificador del paquete, no una descripción libre
3. CUÁNDO ESTÁ   el criterio de aceptación, repetido explícitamente
4. TRAMPAS       lo que este agente probablemente va a hacer mal en esta área
5. LÍMITE        el alcance, y qué hacer si crece
```

El punto 0 es aparte de los otros cinco porque es lo único que hay que hacer **antes de leer siquiera la documentación**: no depende de qué WP es. Trabajar sobre `main` deja el trabajo sin punto de retorno si la sesión se corta, y `git diff main...rama` no existe hasta que hay rama (CONTRIBUTING.md §2).

El punto 4 (trampas) es el que más rinde: cada área tiene un error predecible — en dinero es usar `number`, en la API es olvidar el tercer parámetro de `set_config`, en el esquema es correr `prisma migrate`. Anticiparlo cuesta dos líneas y ahorra una sesión.

**No repitas lo que ya está en `AGENTS.md`/`CLAUDE.md`.** Si el prompt empieza a parecerse a la documentación permanente, la documentación no se está leyendo.

## Cómo arrancar

1. Si el usuario nombró un WP-XXX, buscalo en `docs/backlog.md`. Si no nombró ninguno, preguntá cuál toca (no elijas el "siguiente" por tu cuenta salvo que el usuario lo pida explícitamente).
2. Identificá el área del WP (dominio, esquema, API, ventas, frontend, etc.) para saber qué regla de `.claude/rules/` y qué documentos de la tabla de `AGENTS.md` §Documentación aplican.
3. Armá el prompt con la plantilla de abajo, completando cada punto contra el backlog real — no inventes criterio de aceptación ni trampas que el backlog no sustenta.
4. Si el WP toca una regla de negocio que `docs/domain-rules.md` no cubre, no la inventes: decilo y preguntá antes de escribir el prompt.
5. Ejecutá el punto 0 (crear la rama) antes de tocar cualquier archivo.

## Plantilla (docs/runbooks/prompts-playbook.md §3)

```
Antes de tocar nada: git checkout -b <tipo>/<área>-<tema>

Tomá WP-<id> del backlog.

Leé primero: .claude/rules/<área>.md y <documentos del área>.

Objetivo: <una frase, tomada del backlog>.

Criterio de aceptación: <el del backlog, con los números concretos si los hay>.

TRAMPAS DE ESTA TAREA:
· <el error predecible de esta área>
· <el invariante que se suele olvidar>

Alcance: solo WP-<id>. Si el alcance crece, pará y consultá.
```

`<tipo>` sigue la convención de CONTRIBUTING.md §2: `feat/` para funcionalidad nueva, `fix/` para corrección, `chore/` para infraestructura, `db/` para esquema.

## Trampas por área, para completar la plantilla

| Área                | Lo que hay que advertir                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dominio             | Nada de I/O. `Result` para fallos esperados, excepción para bugs. `Money`, no `number`.                                                                            |
| Esquema             | Nunca `prisma migrate`. Nunca editar una migración aplicada. `tenant_id` en toda tabla. Todo invariante nuevo lleva su prueba.                                     |
| API                 | `set_config` con tercer parámetro en `true`. Todo procedimiento declara su permiso. 404, no 403. Bloqueo en orden ascendente de `lot_id`.                          |
| Ventas              | El inventario se consume al confirmar el pago, no al crear el pedido. Anular es revertir, no editar.                                                               |
| Pagos               | El PAN no toca el sistema. Webhook idempotente por clave única. Confirmar el monto contra el proveedor.                                                            |
| DTO públicos        | Esquema distinto, no el mismo con opcionales. Test que verifica que no filtra costos ni cantidades.                                                                |
| Contabilidad        | Los asientos se derivan de reglas, no se cargan. Un asiento contabilizado se reversa, no se edita.                                                                 |
| ETL                 | Idempotente con `legacy_map`. No inventar historial: movimientos de apertura. El ETL solo lee del v2.                                                              |
| Frontend admin      | Las guardas son UX, no seguridad. Carga diferida para que el bundle no viaje. Densidad alta: no es una landing.                                                    |
| Frontend storefront | Componentes de servidor por defecto. Framer Motion fuera del camino crítico. `width` y `height` en toda imagen. El stock se muestra como estado, no como cantidad. |
| Diseño visual       | Pegá la lista de defaults genéricos de `frontend-spec.md` §3.3. Sin ella vas a recibir crema + serif + terracota.                                                  |
| SEO                 | Facetas combinadas siempre `noindex`. Los datos estructurados deben coincidir con lo que ve el usuario.                                                            |

## Al terminar

Antes de dar el WP por cerrado, corré el checklist de "Cómo verificar tu trabajo" de `AGENTS.md`/`CLAUDE.md` y reportá cada punto con la salida real de los comandos — no lo des por hecho de memoria.
