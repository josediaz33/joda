# ADR-004 — Supabase como plataforma, API propia como autoridad de negocio

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Infraestructura

---

## Contexto

Se planteó como dilema: o se usa Supabase "a la Supabase" (PostgREST + RLS + Edge Functions), o se arma un backend propio y entonces Supabase queda degradado a un Postgres administrado caro.

Es un falso dilema. Supabase no es un estilo arquitectónico, es un paquete de servicios gestionados.

## Decisión

**Supabase provee Postgres y Auth. La API en Fastify contiene todos los casos de uso y es el único origen de escritura.** Las imágenes públicas van a Cloudflare R2.

## Consecuencias

**Positivas.** Auth con MFA, recuperación de contraseña y OAuth resueltos, más Postgres gestionado con pooling, por ~USD 25/mes. Construir eso cuesta más en plata y mucho más en horas. RLS sigue siendo útil y no redundante: es la capa que protege la lectura directa del catálogo por el storefront.

**Nota (WP-C04, 2026-09-21) — el MFA de personal no usa todavía el de Supabase Auth.** Esta decisión sigue en pie (Supabase provee Postgres y Auth; la API sigue siendo la única autoridad de negocio), pero el segundo factor obligatorio de personal (`docs/security-spec.md` §4.3) se implementó con TOTP propio (`apps/api/src/adapters/totp.ts`, RFC 6238) en vez de la MFA nativa de GoTrue que esta consecuencia da por resuelta. No hay proyecto Supabase provisionado todavía (**WP-F00b**, sin dueño) ni el adaptador real de `StaffAuthProvider` verificado contra uno (**WP-C03b**, depende de F00b) — ninguno de los dos es dependencia declarada de WP-C04, así que no se podía esperar. El secreto TOTP queda cifrado en `staff_users.mfa_secret_encrypted`, detrás de la misma lógica pura (`packages/domain/src/security/totp.ts`) que ya decide el estado de la sesión — si en algún momento se migra al MFA de Supabase, esa es la capa que se reemplaza, no el resto del flujo. No amerita un ADR de reemplazo: no se está revirtiendo "Supabase provee Auth", solo posponiendo el uso de una de sus funciones por una dependencia externa (una cuenta que crea José), documentado en `docs/backlog.md` WP-C04.

**Negativas.** Dependencia de plataforma. Se mitiga con disciplina de portabilidad: Prisma como capa de acceso, cero SDK de Supabase dentro de `packages/domain`, auth encapsulada tras una interfaz. Migrar a Neon o RDS costaría días, no meses.

**Por qué R2 y no Supabase Storage para el catálogo.** El egress de Supabase Storage se factura y un catálogo de perfumería es tráfico de imágenes. R2 no cobra egress. Los documentos privados (comprobantes, reportes) sí van a Supabase Storage con URLs firmadas.

## Alternativas descartadas

- **Supabase como backend total:** la lógica de negocio quedaría repartida entre RLS, RPC en PL/pgSQL, Edge Functions y el cliente React. Imposible de testear y de depurar.
- **Todo propio (Neon + Clerk + S3):** más caro y más tiempo, sin beneficio proporcional hoy.
