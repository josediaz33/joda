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
- Cada transacción abre con `set_config('app.user_id'|'app.tenant_id'|'app.audience', ..., true)`. El `true` final hace el valor local a la transacción para que no se filtre por el pool.

**Detalles de diseño:** las rutas administrativas no autorizadas devuelven **404, no 403**, para no confirmar la existencia del endpoint. Los permisos **no viajan en el JWT**: se resuelven server-side con caché en Redis (TTL 60 s), así revocar un rol tiene efecto en un minuto y no cuando expire el token.

## Verificado

Conectado como `joda_api`: sin `tenant_id` en contexto, cero filas; con otro tenant, cero filas; `UPDATE` sobre el ledger, `permission denied`.

## Consecuencias

**Negativas.** Hay que gestionar un rol de base de datos propio y recordar el `set_config` en cada transacción. Se resuelve en un middleware único.
