# CLAUDE.md

Contexto del proyecto para Claude Code. Se lee al inicio de cada sesión.
Si algo acá contradice tu criterio general, **gana esto**. Si algo acá contradice un ADR, gana el ADR y hay que corregir este archivo.

---

## Qué es JODA Parfums

Ecosistema ERP + e-commerce para una perfumería y relojería de nicho en Encarnación, Paraguay. Migra desde una PWA offline-first (React + Dexie/IndexedDB, sin backend) a una plataforma cloud desacoplada.

**Cuatro piezas:** storefront público (Next.js), backoffice/ERP (React+Vite), API central (Fastify+tRPC, único origen de escritura), PostgreSQL como fuente de verdad.

**Lo que hace único a este dominio:** se venden fracciones de perfume ("decants"). Un frasco de 125 ml se abre y se vende de a 5, 10 o 30 ml, descontando mililitros y merma de un lote con costo real de importación. Ningún ERP comercial resuelve esto. Es el corazón del sistema y el lugar donde los errores cuestan plata.

---

## Documentación

Antes de trabajar en un área, leé lo que corresponde. **No inventes decisiones que ya están tomadas.**

| Documento | Cuándo leerlo |
|---|---|
| `docs/architecture/JODA_Arquitectura_v5_Final.md` | Referencia maestra. Ante cualquier duda estructural. |
| `docs/adr/*.md` | 23 decisiones cerradas, con su fundamento. **No las reabras.** |
| `GLOSARIO.md` | Siempre. Define el lenguaje ubicuo del dominio. |
| `docs/domain-rules.md` | Antes de tocar costeo, decants, merma, IVA o contabilidad. |
| `docs/data-model.md` | Antes de tocar el esquema. |
| `docs/api-conventions.md` | Antes de agregar endpoints. |
| `docs/frontend-spec.md` | Antes de tocar interfaz, estilos, SEO o `packages/ui`. |
| `docs/security-spec.md` | Antes de tocar auth, permisos o RLS. |
| `packages/db/README.md` | Antes de escribir una migración. |

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
- **Nunca mezcles unidades de medida en un lote.** Un lote es `unit` o es `ml`, para siempre. Abrir un frasco es una *conversión* entre dos lotes (ADR-009), no un cambio de estado.
- **Todo movimiento de salida registra sus capas de costo** en `movement_cost_allocations`. Sin eso el COGS es una aproximación y no cierra contra contabilidad.

### Dinero

- **Los guaraníes son `bigint` de unidades enteras.** Nunca `float`, nunca `numeric(x,2)`, nunca `number` de JavaScript para acumular.
- **Toda operación en moneda extranjera guarda cuatro campos:** `amount_minor`, `currency`, `fx_rate_to_pyg`, `amount_pyg`. El último es un snapshot, no un cálculo en vivo.
- **El redondeo vive en un solo lugar:** `packages/domain/src/money.ts` y su espejo `app.round_pyg()`. Si escribís `Math.round` sobre un importe fuera de ahí, está mal.
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
2. `pnpm test` — en verde. Si tocaste `packages/domain`, agregaste tests.
3. Si tocaste el esquema: `pnpm db:reset && pnpm db:test`. Las 18 pruebas de invariantes tienen que seguir pasando, y agregaste una por cada invariante nuevo.
4. Si tocaste inventario o contabilidad: verificá que `v_balance_drift` devuelva cero filas y que los asientos cuadren.
5. Si tocaste algo que un ADR menciona, releé el ADR y confirmá que no lo violaste.

---

## Cómo trabajar

- **Preguntá antes de asumir una regla de negocio.** Este dominio tiene reglas contraintuitivas (la merma tiene tres componentes, la seña es pasivo, el frasco abierto no se vende sellado). Si `docs/domain-rules.md` no la cubre, preguntá en lugar de inventar. Una regla inventada que parece razonable es peor que una pregunta.
- **Alcance acotado.** Una tarea, un PR. Si mientras trabajás encontrás otro problema, anotalo y seguí; no lo arregles de paso.
- **No refactorices lo que no pediste tocar.**
- **Cambios de esquema: siempre una migración nueva.** Nunca edites una migración ya aplicada.
- **Si una decisión te parece equivocada, decilo.** Los ADRs se pueden reemplazar con otro ADR, pero no se ignoran en silencio. Argumentá primero, cambiá después.
- **Español para nombres de negocio en documentación y UI; inglés para identificadores de código y base de datos.** El `GLOSARIO.md` mapea ambos.

---

## Estado actual

| Bloque | Estado |
|---|---|
| A — Monorepo, `packages/domain`, contratos | Pendiente |
| B — Esquema Postgres | **Validado** contra PG16 (61 tablas, 18/18 invariantes) |
| C — API: auth, RBAC, catálogo, inventario, ventas, compras | Pendiente |
| D — ETL, imágenes, reconciliación | Pendiente |
| E — Admin migrado a la API | Pendiente |
| F — **Corte a la nube** | Meta intermedia |
| G — Storefront | Posterior al corte |
| H — Motor de posteo + integración fiscal | Posterior |

El sistema v2 (Dexie) sigue en producción hasta el bloque F. Nada de lo que se escriba acá lo afecta: el ETL solo lee.

---

## Pendientes que bloquean decisiones

1. **Grupo SIFEN del RUC de JODA.** Determina si la facturación electrónica entra al MVP.
2. **Validación del plan de cuentas con el contador.** El de `packages/db/seed/` es una base razonable, no una verdad revelada.
3. **PITR contratado y simulacro de restauración** antes de migrar datos reales.
