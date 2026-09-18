# ADR-018 — SQL-first; Prisma se regenera por introspección

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Base de datos

---

## Contexto

El flujo habitual con Prisma es definir `schema.prisma` y generar migraciones con `prisma migrate dev`.

## Decisión

**El SQL es la fuente de verdad.** Las migraciones se escriben a mano en `packages/db/migrations/`. `schema.prisma` se regenera con `prisma db pull` después de cada migración y se commitea. Prisma es el cliente tipado, no el dueño del esquema.

```bash
pnpm db:migrate   # aplica migrations/*.sql en orden, y encadena pnpm db:pull
pnpm db:pull      # prisma db pull + parche de schema + prisma generate + verificación
```

**Nota de implementación (WP-B04).** No hay un `db:generate` separado: `db:pull` hace introspección, parche y generación en un solo script, así nadie tiene que acordarse de encadenar tres pasos a mano. El "parche de schema" existe porque Prisma no introspecciona la unicidad transitiva de la FK compuesta `(product_id, kind)` de las verticales (ver `packages/db/README.md`, hallazgo 4) — no es una regla de negocio nueva, es un ajuste de la herramienta para que refleje lo que la FK compuesta ya hace cumplir en Postgres.

## Consecuencias

**Positivas.** Este esquema depende de cosas que Prisma no expresa: constraint triggers diferidos (cuadre de asientos, cuadre de capas de costo), políticas RLS, dominios, columnas generadas (`tsvector`), `CHECK` compuestos y FK compuestas para la coherencia de verticales. Si el esquema lo definiera Prisma, **todos los invariantes de ADR-007, 008, 012 y 016 desaparecerían**, o quedarían en un `migration.sql` editado a mano, que es lo peor de ambos mundos.

**Negativas.** Se escribe SQL a mano y hay que recordar correr `db:pull`. Se automatiza en el script de migración.

## Prohibiciones

`prisma migrate dev`, editar `schema.prisma` a mano, y editar una migración ya aplicada.

## Política de migraciones

**Expand/contract.** Nunca `DROP COLUMN` en el mismo deploy que deja de usarla: agregar → escribir en ambas → migrar datos → dejar de leer la vieja → borrar en un deploy posterior.
