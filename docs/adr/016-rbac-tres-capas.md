# ADR-016 — RBAC en tres capas, con la API en un rol NOBYPASSRLS

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Seguridad

---

## Contexto

El diseño original presentaba RLS como "última línea de defensa" mientras la API escribía con credenciales de servicio. **Eso es un agujero conceptual:** con la `service_role` de Supabase, o con el owner de las tablas, RLS no se evalúa y toda esa capa es decorativa.

## Decisión

**Tres capas de aplicación:**

| Capa               | Dónde      | Qué hace                                                   |
| ------------------ | ---------- | ---------------------------------------------------------- |
| 1 — RLS            | PostgreSQL | Aislamiento por tenant + permisos. Deny-by-default.        |
| 2 — Middleware     | API        | `requirePermission()` en cada ruta. **Defensa principal.** |
| 3 — Servicio       | API        | Reglas dependientes del recurso concreto.                  |
| _Guardas de React_ | Frontend   | **UX, no seguridad.**                                      |

**Y la condición que hace que la capa 1 exista de verdad:**

- La API se conecta con el rol `joda_api`, creado `NOBYPASSRLS`, sin `UPDATE`/`DELETE` sobre ledger y auditoría.
- Las tablas llevan `FORCE ROW LEVEL SECURITY`.
- `service_role` queda restringido a migraciones y ETL desde CI, nunca en el runtime.
- Cada transacción abre con `set_config('app.user_id'|'app.tenant_id'|'app.audience'|'app.session_id', ..., true)`. El `true` final hace el valor local a la transacción para que no se filtre por el pool.

**Detalles de diseño:** las rutas administrativas no autorizadas devuelven **404, no 403**, para no confirmar la existencia del endpoint. Los permisos **no viajan en el JWT**: se resuelven server-side con caché en Redis (TTL 60 s), así revocar un rol tiene efecto en un minuto y no cuando expire el token.

## Modelo de confianza

_Agregado en WP-B13 (2026-09-25). No cambia la decisión: escribe lo que ya se desprendía de ella._

**RLS nos protege de los errores de nuestra propia aplicación. No nos protege de un proceso de API comprometido.** Quien logra ejecutar SQL arbitrario con la credencial de `joda_api` puede fijar el `app.tenant_id` y el `app.user_id` que quiera, y la base le va a creer. Ninguna política puede distinguir un `set_config` legítimo de uno hostil cuando los dos llegan por la misma conexión. Contra ese atacante, las defensas son otras: que la credencial no se filtre, que el proceso no ejecute SQL que no escribimos (`$queryRawUnsafe` prohibido) y que haya auditoría fuera de su alcance.

Lo que sí le pedimos a la capa 1 es que un error de la aplicación necesite **varias cosas mal a la vez** para convertirse en una fuga:

- Un `tenant_id` equivocado no alcanza para ver datos de otro tenant si la consulta pasa por una tabla con `tenant_isolation` RESTRICTIVE.
- Un `user_id` equivocado no alcanza para heredar los permisos de ese usuario: `has_permission()` exige además que `app.session_id` nombre una sesión viva, no revocada y no vencida de **ese** usuario en **ese** tenant.
- Los valores de contexto salen de un solo lugar, `withTenantTx`, siempre a partir de una sesión validada por `resolveRequestSession`. Nunca salen de la entrada del cliente. Una prueba (`apps/api/src/db/sessionContextAudit.test.ts`) falla si aparece otro lugar que los fije.

Así se evalúa cualquier hallazgo futuro sobre esta capa. Por ejemplo, la sombra de tablas en `pg_temp` que encontró WP-B10: si solo sirve a quien ya ejecuta SQL arbitrario, no le da nada que el modelo no le conceda ya. Se corrige igual, porque es barato y porque sin corregirla la verificación de sesión también se podría sombrear. Pero su urgencia se mide contra este modelo, no contra el peor caso imaginable.

## Verificado

Conectado como `joda_api`: sin `tenant_id` en contexto, cero filas; con otro tenant, cero filas; `UPDATE` sobre el ledger, `permission denied`.

## Consecuencias

**Negativas.** Hay que gestionar un rol de base de datos propio y recordar el `set_config` en cada transacción. Se resuelve en un middleware único.
