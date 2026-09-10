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

## Expand/contract

Nunca `DROP COLUMN` en el mismo despliegue que deja de usarla.
`ALTER TYPE ... ADD VALUE` va en su propia migración, separada.

## Antes del PR

`pnpm db:reset && pnpm db:test` en verde. Todo invariante nuevo lleva su prueba
en `tests/invariants.sql` en el mismo PR. Un invariante sin prueba es una
creencia.
