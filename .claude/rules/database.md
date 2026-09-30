---
paths:
  - "packages/db/**"
---

# Reglas de `packages/db`

Detalle completo: `packages/db/README.md`, `docs/data-model.md`, ADR-018.

## SQL primero

Las migraciones son SQL escrito a mano, numeradas consecutivamente.
`schema.prisma` se **regenera** con `pnpm db:pull`.

- **Nunca** `prisma migrate dev`.
- **Nunca** editar `schema.prisma` a mano.
- **Nunca** editar una migración ya aplicada. Siempre una nueva.

Prisma no expresa constraint triggers diferidos, RLS, dominios ni FK compuestas:
si el esquema lo definiera Prisma, los invariantes desaparecerían.

## Obligatorio en toda tabla nueva

`tenant_id uuid NOT NULL REFERENCES tenants(id)`, más su política de
aislamiento RLS. Sin excepciones.

## Triggers

Solo invariantes. Nunca lógica de negocio. La base hace cumplir lo que debe
seguir siendo cierto; la aplicación calcula decisiones.

**Todo trigger que impone un invariante FALLA CERRADO:** si no puede leer lo
que necesita para decidir, rechaza. Nunca compara contra un valor que podría
ser NULL por falta de visibilidad. Se escribe con `IF NOT FOUND THEN RAISE`,
no con una comparación que se evalúe a falso. Ejemplo y motivo en
`docs/data-model.md` §4.2 (`guard_posted_journal`, WP-B10).

## Vistas

Toda vista nueva de `app` revoca en su misma migración `INSERT, UPDATE, DELETE`
de `joda_api`: el default de 0010 no distingue vistas de tablas. Una vista
materializada de `app` no puede ser legible por `joda_api`: RLS no se aplica
a las materializadas y mostraría las filas de todos los tenants, así que
también revoca `SELECT`. El invariante 78 falla si se olvida, nombrando la
vista.

## RLS

`tenant_isolation` va `AS RESTRICTIVE`, con una permisiva base `tenant_access`
`USING (true)` al lado. Esa permisiva nunca va sin la restrictiva: sola, abre
la tabla entera. El invariante 23 lo verifica. Detalle en
`docs/data-model.md` §7.

## Expand/contract

Nunca `DROP COLUMN` en el mismo despliegue que deja de usarla.
`ALTER TYPE ... ADD VALUE` va en su propia migración, separada.

## Antes del PR

`pnpm db:reset && pnpm db:test` en verde. Todo invariante nuevo lleva su prueba
en `tests/invariants.sql` en el mismo PR. Un invariante sin prueba es una
creencia.
