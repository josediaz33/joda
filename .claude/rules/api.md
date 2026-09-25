---
paths:
  - "apps/api/**/*.ts"
---

# Reglas de `apps/api`

Detalle completo: `docs/api-conventions.md`, `docs/security-spec.md`.

## Conexión y contexto

La API usa el rol `joda_api` (`NOBYPASSRLS`). **Nunca** `service_role` ni el
owner de las tablas en runtime: con credencial privilegiada RLS no se evalúa.

Toda transacción abre con el contexto, antes de la primera consulta:

```ts
SELECT set_config('app.user_id', $1, true),
       set_config('app.tenant_id', $2, true),
       set_config('app.audience', $3, true),
       set_config('app.session_id', $4, true)
```

`app.session_id` (WP-B13) es la fila de `staff_sessions` que respalda el
contexto: sin una sesión viva de ese usuario en ese tenant, `has_permission()`
da `false`. Solo `withTenantTx` fija estos valores, siempre desde una sesión
resuelta, nunca desde la entrada del cliente (`sessionContextAudit.test.ts`
falla si aparece otro lugar).

El `true` final es obligatorio: hace el valor local a la transacción para que no
se filtre por el pool a otra petición.

## Autorización

Todo procedimiento declara `meta.permission`. Rutas administrativas no
autorizadas devuelven **404, no 403**. Los permisos se resuelven server-side con
caché en Redis, no viajan en el JWT.

## Capas

`router` valida y autoriza · `service` orquesta la transacción ·
`repository` accede a datos · `packages/domain` calcula.
**Leer, decidir, escribir.** Nunca consultar la base dentro de un bucle.

## Verificación de pertenencia

Todo id de entidad relacionada que llegue desde el cliente y se use en un
`INSERT`/`UPDATE` se lee primero **bajo RLS**, dentro de la transacción, para
confirmar que pertenece al tenant de la sesión. Las comprobaciones de
integridad referencial de Postgres corren con privilegio interno y **no
evalúan RLS**: una FK al padre no protege nada. Patrón correcto:
`assertCategoryAndTagIdsExist`/`findProductRow` en
`apps/api/src/modules/catalog/service.ts` (docs/api-conventions.md §8.4).

## Concurrencia

Bloqueo de lotes en **orden ascendente de `lot_id`**, en una sola sentencia. Sin
orden determinístico hay interbloqueo en pedidos multilínea. Dejá el comentario
en el código: es el tipo de detalle que alguien "limpia" en un refactor.

## Otras

- Zod `.strict()` en toda entrada. Los importes viajan como string.
- Mutación irreversible acepta `Idempotency-Key`.
- Auditoría en la misma transacción que el efecto.
- Ningún mensaje de PostgreSQL llega al usuario. Errores en español.
- `$queryRawUnsafe` prohibido.
