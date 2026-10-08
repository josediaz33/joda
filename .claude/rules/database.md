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
- El número de migración y de invariante se fija **al fusionar**, no al empezar: el trabajo de DB no se paraleliza (`CONTRIBUTING.md` §6, regla de proceso).

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

Una política de permiso va **por comando, nunca `FOR ALL`**: un `FOR ALL`
también cubre `SELECT` y le abre la lectura a quien solo debía escribir
(invariante 92). Y `INSERT ... RETURNING` y los `UPDATE`/`DELETE` que leen
columnas (con `WHERE` o `RETURNING`) evalúan también la política de lectura,
así que todo permiso de escritura de una tabla sensible viene con el de
lectura de esa tabla (invariante 94). Una excepción deliberada: el vendedor
escribe movimientos `sale` sin poder leer el ledger (WP-B11f, invariante 129):
los registra **sin `RETURNING`**. La política de lectura de una tabla de alto
volumen va como `(SELECT app.has_permission(...))`, para que se evalúe una vez
por sentencia y no por fila. Al probar una política de escritura,
probá la operación que emite Prisma, con el rol real conectado como
`joda_api`; y la denegación de un rol sin lectura, con las formas que no leen
(`INSERT` sin `RETURNING`, `UPDATE` sin `WHERE`): con las otras ese rol queda
afuera por la lectura y la prueba pasa aunque la política de escritura no
exista (`test/integration/write_permissions.test.ts`).

## Expand/contract

Nunca `DROP COLUMN` en el mismo despliegue que deja de usarla.
`ALTER TYPE ... ADD VALUE` va en su propia migración, separada.

## Antes del PR

`pnpm db:reset && pnpm db:test` en verde. Todo invariante nuevo lleva su prueba
en `tests/invariants.sql` en el mismo PR. Un invariante sin prueba es una
creencia.
