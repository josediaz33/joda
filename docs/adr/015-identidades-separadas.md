# ADR-015 — Identidades separadas: customers y staff_users

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Seguridad

---

## Contexto

La opción simple era una tabla `users` con un discriminador `user_type`. La alternativa, dos tablas.

## Decisión

**Dos tablas: `customers` y `staff_users`**, con audiencias, cookies, dominios y políticas de sesión distintas.

|           | Cliente           | Staff                                |
| --------- | ----------------- | ------------------------------------ |
| Dominio   | `jodaparfums.com` | `admin.jodaparfums.com`              |
| Cookie    | `__Host-joda_c`   | `__Host-joda_a`, scope al subdominio |
| Audiencia | `customer`        | `staff`                              |
| MFA       | Opcional          | **Obligatoria**                      |
| Sesión    | 30 días           | 8 h + refresh rotativo               |

## Consecuencias

**Positivas.** Que un cliente no pueda tener un rol de staff pasa a ser un **invariante de esquema**: no existe fila donde ponérselo. Es más barato y más seguro que una validación en runtime que hay que recordar en cada punto de escritura. La separación de cookies significa que un XSS en el storefront no alcanza la sesión del admin.

**Negativas.** Dos flujos de autenticación. Con un proveedor único (Supabase Auth) se mapean ambos a `auth.users` con perfiles separados, así que el costo real es bajo.

## Alternativas descartadas

- **Tabla única con discriminador:** convierte la separación de privilegios en una condición que se puede olvidar.
