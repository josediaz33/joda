# AGENTS.md

Contexto del proyecto para Codex. Se lee al inicio de cada sesión.
Si algo acá contradice tu criterio general, **gana esto**. Si algo acá contradice un ADR, gana el ADR y hay que corregir este archivo.

---

## Qué es JODA Parfums

Ecosistema ERP + e-commerce para una perfumería y relojería de nicho en Encarnación, Paraguay. Migra desde una PWA offline-first (React + Dexie/IndexedDB, sin backend) a una plataforma cloud desacoplada.

**Cuatro piezas:** storefront público (Next.js), backoffice/ERP (React+Vite), API central (Fastify+tRPC, único origen de escritura), PostgreSQL como fuente de verdad.

**Lo que hace único a este dominio:** se venden fracciones de perfume ("decants"). Un frasco de 125 ml se abre y se vende de a 5, 10 o 30 ml, descontando mililitros y merma de un lote con costo real de importación. Ningún ERP comercial resuelve esto. Es el corazón del sistema y el lugar donde los errores cuestan plata.

---

## Documentación

Antes de trabajar en un área, leé lo que corresponde. **No inventes decisiones que ya están tomadas.**

| Documento                                         | Cuándo leerlo                                                  |
| ------------------------------------------------- | -------------------------------------------------------------- |
| `docs/architecture/JODA_Arquitectura_v5_Final.md` | Referencia maestra. Ante cualquier duda estructural.           |
| `docs/adr/*.md`                                   | 23 decisiones cerradas, con su fundamento. **No las reabras.** |
| `GLOSARIO.md`                                     | Siempre. Define el lenguaje ubicuo del dominio.                |
| `docs/domain-rules.md`                            | Antes de tocar costeo, decants, merma, IVA o contabilidad.     |
| `docs/data-model.md`                              | Antes de tocar el esquema.                                     |
| `docs/api-conventions.md`                         | Antes de agregar endpoints.                                    |
| `docs/frontend-spec.md`                           | Antes de tocar interfaz, estilos, SEO o `packages/ui`.         |
| `docs/security-spec.md`                           | Antes de tocar auth, permisos o RLS.                           |
| `packages/db/README.md`                           | Antes de escribir una migración.                               |

Además, `.claude/rules/` contiene reglas con alcance por ruta que se cargan solas cuando trabajás con archivos que coincidan. Llevan los no negociables de cada área; la profundidad sigue estando en los documentos de arriba. El nombre del directorio es un resto de cuando solo existía Claude Code — las reglas no son específicas de esa herramienta, aplican igual acá.

**Codex no tiene carga automática por ruta.** Los seis archivos son estos — abrí el que corresponda antes de tocar esa área:

| Archivo                      | Alcance (paths)                                                                   | Qué cubre                                                                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude/rules/domain.md`    | `packages/domain/**/*.ts`                                                         | Pureza mecánica (sin Prisma, React, `fetch`, `Date`, `Math.random`, etc.), `Result` vs. excepción, `Money`/`Quantity` en vez de `number`, dónde vive el redondeo, umbrales de cobertura 100% por módulo.                |
| `.claude/rules/database.md`  | `packages/db/**`                                                                  | SQL-first: prohibición de `prisma migrate dev` y de editar `schema.prisma` a mano o una migración ya aplicada, `tenant_id` obligatorio en tabla nueva, triggers solo para invariantes, expand/contract.                 |
| `.claude/rules/api.md`       | `apps/api/**/*.ts`                                                                | Rol `joda_api` (`NOBYPASSRLS`, nunca `service_role` en runtime), `set_config` con tercer parámetro `true`, 404 en vez de 403, capas router/service/repository/domain, bloqueo de lotes en orden ascendente de `lot_id`. |
| `.claude/rules/frontend.md`  | `apps/storefront/**`, `apps/admin/**`, `packages/ui/**`                           | Server components por defecto y `"use client"` lo más abajo posible, presupuesto de rendimiento, formateo solo desde `packages/ui/format`, stock mostrado como estado, defaults visuales genéricos prohibidos.          |
| `.claude/rules/contracts.md` | `packages/contracts/**/*.ts`                                                      | Zod `.strict()` en todo esquema, dinero como `string` (nunca número), DTOs públicos y administrativos como esquemas distintos con su test de claves prohibidas.                                                         |
| `.claude/rules/testing.md`   | `**/*.test.ts`, `**/*.test.tsx`, `**/*.spec.ts`, `e2e/**`, `packages/db/tests/**` | Cada `describe` cita la regla (`RN-XXX-nn`) que verifica, sin lógica dentro del test, determinismo (reloj e ids inyectados), integración con Postgres real vía Testcontainers.                                          |

## Herramientas por agente

- **Claude Code** carga solo `AGENTS.md` (vía el import de `CLAUDE.md`) y los archivos de `.claude/rules/` que coincidan por ruta, y tiene skills, subagentes y hooks configurados en `.claude/`.
- **Codex** carga solo `AGENTS.md`. No descubre `.claude/skills/`, `.claude/agents/`, `.claude/rules/` ni los hooks. Todo lo que necesite leer hay que nombrarlo explícitamente en el prompt.
- **Los guardas mecánicos** —prettier automático, bloqueo de `prisma migrate`, bloqueo de edición de migraciones aplicadas— **no protegen a Codex.** Los hooks de git (`commit-msg`, `pre-push`) sí, porque son de git y no del agente.
- **No se mantienen espejos de la configuración de `.claude/` para otras herramientas.** Si Codex necesita una instrucción, se le nombra el archivo en el prompt — no se copian `.claude/skills/` ni `.claude/agents/` a un directorio propio de Codex. Que Codex regenere algo como `.codex/` por su cuenta no es problema mientras quede en `.gitignore` y nadie lo trate como fuente de verdad, pero una copia de las skills no puede volver a versionarse: una skill duplicada y desactualizada es peor que ninguna, porque Codex la sigue creyendo vigente.
- **Next.js 16 también escribe `AGENTS.md`/`CLAUDE.md` por su cuenta, y es el mismo problema que `.codex/`.** Su feature `agentRules` regenera esos dos archivos dentro de `apps/storefront/` en cada `next dev`/`next build` (ver `node_modules/next/dist/server/lib/generate-agent-files.js`), compitiendo con este archivo como fuente única de reglas para agentes. Desactivada con `agentRules: false` en `apps/storefront/next.config.ts` (WP-A02) — si alguien actualiza Next sin saber de esa opción, o la borra al tocar `next.config.ts` por otro motivo, el archivo reaparece en silencio en el próximo `dev`/`build`. Verificar que siga en `false` si ese archivo cambia.

Esa penúltima línea es la importante: quien trabaje con Codex tiene que saber que las reglas que en Claude Code son mecánicas, ahí vuelven a ser de confianza. Por eso Codex no trabaja sobre `packages/db/`.

---

## Estructura del repositorio

```
apps/
  storefront/   Next.js App Router · público · SSR/ISR
  admin/        React 19 + Vite · privado
  api/          Fastify + tRPC · ÚNICO ESCRITOR
packages/
  contracts/    Zod + tipos tRPC — fuente de verdad de tipos
  domain/       lógica pura, SIN I/O
  db/           migraciones SQL + seed + ETL + schema.prisma
  ui/           design system compartido
  sdk/          cliente tipado
  config/       tsconfig · eslint · tailwind
infra/          supabase · docker · deployment
docs/           architecture · adr · runbooks
```

---

## Comandos

```bash
pnpm install
pnpm dev                 # todos los apps
pnpm dev --filter=api    # uno solo
pnpm build
pnpm test                # vitest en todos los paquetes
pnpm test:domain         # solo packages/domain (rápido, corré esto seguido)
pnpm lint
pnpm typecheck

# base de datos
pnpm db:migrate          # aplica migrations/*.sql en orden
pnpm db:seed
pnpm db:pull             # regenera schema.prisma por introspección
pnpm db:test             # smoke_business_flow.sql + invariants.sql
pnpm db:reset            # drop + create + migrate + seed
```

---

## Reglas no negociables

Estas no son preferencias de estilo. Romper cualquiera de ellas produce pérdida de datos, fuga de información o descuadre contable.

### Inventario

- **Nunca `UPDATE stock SET cantidad = ...`.** El inventario es un ledger append-only (`inventory_movements`). El saldo es una proyección derivada. Corregir un error es insertar un movimiento de ajuste, jamás editar uno existente.
- **Nunca mezcles unidades de medida en un lote.** Un lote es `unit` o es `ml`, para siempre. Abrir un frasco es una _conversión_ entre dos lotes (ADR-009), no un cambio de estado.
- **Todo movimiento de salida registra sus capas de costo** en `movement_cost_allocations`. Sin eso el COGS es una aproximación y no cierra contra contabilidad.

### Dinero

- **Los guaraníes son `bigint` de unidades enteras.** Nunca `float`, nunca `numeric(x,2)`, nunca `number` de JavaScript para acumular.
- **Toda operación en moneda extranjera guarda cuatro campos:** `amount_minor`, `currency`, `fx_rate_to_pyg`, `amount_pyg`. El último es un snapshot, no un cálculo en vivo.
- **El redondeo vive en un solo lugar:** `packages/domain/src/shared/money.ts` y su espejo `app.round_pyg()`. Si escribís `Math.round` sobre un importe fuera de ahí, está mal.
- **IVA paraguayo va sobre precio con impuesto incluido:** 10% = total/11, 5% = total/21. Nunca `total * 0.10`.

### Seguridad

- **Solo `apps/api` escribe en la base.** El storefront lee vistas estables (`v_catalog_*`), nunca tablas.
- **Tres roles de base, y cada uno tiene su lugar.** `joda_api` (`NOBYPASSRLS`) para el runtime de la API; `joda_readonly` para la lectura del catálogo público desde el storefront, limitado a las vistas de `public`; `service_role` **solo** para migraciones y ETL desde CI. Nunca uses `service_role` ni el owner de las tablas en código de runtime: con credencial privilegiada RLS no se evalúa y toda la capa de aislamiento desaparece.
- **Toda transacción abre con `set_config('app.user_id'|'app.tenant_id'|'app.audience', ..., true)`.** El `true` final es obligatorio: hace el valor local a la transacción para que no se filtre por el pool.
- **Rutas administrativas no autorizadas devuelven 404, no 403.**
- **Los permisos no van en el JWT.** Se resuelven server-side con caché en Redis.
- **El número de tarjeta nunca toca este sistema.** Checkout hospedado. Solo se guardan `card_last4` y `card_brand`.
- **Los DTO públicos y administrativos son schemas Zod distintos**, no el mismo con campos opcionales. Costos, proveedores y márgenes jamás salen en una respuesta pública.

### Base de datos

- **SQL-first.** Las migraciones son SQL escrito a mano en `packages/db/migrations/`. `schema.prisma` se regenera con `pnpm db:pull`. **Nunca uses `prisma migrate dev`** ni edites `schema.prisma` a mano.
- **Triggers solo para invariantes**, nunca para lógica de negocio. Qué lote consumir, cómo prorratear un flete, qué asiento generar: eso va en `packages/domain` en TypeScript.
- **Migraciones expand/contract.** Nunca `DROP COLUMN` en el mismo deploy que deja de usarla.
- **`tenant_id` en toda tabla nueva**, sin excepción.

### Código

- **`packages/domain` no importa nada con I/O.** Ni Prisma, ni React, ni `fetch`, ni `process.env`. Si necesitás datos, se pasan por parámetro.
- **`packages/contracts` es la única fuente de verdad de tipos.** Todo body/query/param se valida con Zod `.strict()`.
- **`apps/*` no se importan entre sí.** Si dos apps necesitan lo mismo, va a `packages/`.
- **`$queryRawUnsafe` está prohibido** y el lint falla el build. Para SQL crudo, `Prisma.sql` con placeholders.
- **Sin `localStorage` para tokens.** Cookies `httpOnly`.

### Frontend

- **Componentes de servidor por defecto** en el storefront. `"use client"` lo más abajo posible del árbol.
- **Toda imagen lleva `width` y `height`** (o `aspect-ratio`). Sin eso hay salto de layout.
- **El formateo de guaraníes, cantidades y fechas sale de `packages/ui/format`**, nunca de un `toLocaleString` suelto.
- **Los formularios usan los esquemas Zod de `packages/contracts`**, nunca una copia.
- **El stock se muestra como estado** (Disponible / Últimas unidades / Agotado), nunca como cantidad exacta.
- **Framer Motion fuera del camino crítico del storefront.** Pesa 30–50 kB y fuerza `"use client"`.
- **El presupuesto de rendimiento bloquea la fusión**, igual que un test que falla.

---

## Cómo verificar tu trabajo

No des una tarea por terminada sin esto:

1. `pnpm typecheck && pnpm lint` — en verde.
2. `pnpm format:check` — en verde. No es decorativo: si queda en rojo por defecto, nadie distingue lo preexistente de lo que rompiste vos.
3. `pnpm test` — en verde. Si tocaste `packages/domain`, agregaste tests.
4. Si tocaste el esquema: `pnpm db:reset && pnpm db:test`. Las pruebas de invariantes existentes (20 al cierre de WP-C03, `packages/db/tests/invariants.sql`) tienen que seguir pasando, y agregaste una por cada invariante nuevo.
5. Si tocaste código que **escribe** en el ledger o genera asientos (`apps/api`, ETL): verificá que `v_balance_drift` devuelva cero filas y que los asientos cuadren. No aplica a lógica pura de dominio (`packages/domain`), que no tiene forma de escribir nada.
6. Si tocaste algo que un ADR menciona, releé el ADR y confirmá que no lo violaste.

---

## Cómo trabajar

- **Toda tarea empieza creando la rama. Nunca trabajes sobre `main`.**
- **Preguntá antes de asumir una regla de negocio.** Este dominio tiene reglas contraintuitivas (la merma tiene tres componentes, la seña es pasivo, el frasco abierto no se vende sellado). Si `docs/domain-rules.md` no la cubre, preguntá en lugar de inventar. Una regla inventada que parece razonable es peor que una pregunta.
- **Alcance acotado.** Una tarea, un PR. Si mientras trabajás encontrás otro problema, anotalo y seguí; no lo arregles de paso.
- **No refactorices lo que no pediste tocar.**
- **Cambios de esquema: siempre una migración nueva.** Nunca edites una migración ya aplicada.
- **Si una decisión te parece equivocada, decilo.** Los ADRs se pueden reemplazar con otro ADR, pero no se ignoran en silencio. Argumentá primero, cambiá después.
- **Español para nombres de negocio en documentación y UI; inglés para identificadores de código y base de datos.** El `GLOSARIO.md` mapea ambos.

---

## Estado actual

| Bloque                                                     | Estado                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------- |
| A — Monorepo, `packages/domain`, contratos                 | Pendiente                                               |
| B — Esquema Postgres                                       | **Validado** contra PG16 (63 tablas, 23/23 invariantes) |
| C — API: auth, RBAC, catálogo, inventario, ventas, compras | Pendiente                                               |
| D — ETL, imágenes, reconciliación                          | Pendiente                                               |
| E — Admin migrado a la API                                 | Pendiente                                               |
| F — **Corte a la nube**                                    | Meta intermedia                                         |
| G — Storefront                                             | Posterior al corte                                      |
| H — Motor de posteo + integración fiscal                   | Posterior                                               |

El sistema v2 (Dexie) sigue en producción hasta el bloque F. Nada de lo que se escriba acá lo afecta: el ETL solo lee.

---

## Pendientes que bloquean decisiones

1. **Grupo SIFEN del RUC de JODA.** Determina si la facturación electrónica entra al MVP.
2. **Validación del plan de cuentas con el contador.** El de `packages/db/seed/` es una base razonable, no una verdad revelada.
3. **PITR contratado y simulacro de restauración** antes de migrar datos reales.
