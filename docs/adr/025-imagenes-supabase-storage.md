# ADR-025 — Imágenes de catálogo en Supabase Storage

- **Estado:** Aceptada
- **Fecha:** 2026-09-22
- **Ámbito:** Infraestructura
- **Reemplaza parcialmente:** ADR-004 (la parte de "las imágenes públicas van a Cloudflare R2" — el resto de ADR-004 sigue en pie sin cambios: Supabase provee Postgres y Auth, la API en Fastify sigue siendo el único origen de escritura)

---

## Contexto

ADR-004 eligió Cloudflare R2 para las imágenes públicas de catálogo por un motivo puntual: "el egress de Supabase Storage se factura y un catálogo de perfumería es tráfico de imágenes. R2 no cobra egress."

Esa razón no se sostiene a la escala que el propio proyecto ya fijó como supuesto de diseño (`docs/especificacion-software.md` §4.2):

- **S-02.** Menos de 500 ventas mensuales en el primer año.
- **S-04.** El catálogo no supera 2.000 productos activos.

Con esos números, el volumen de tráfico de imágenes es chico. Los planes de Supabase Storage (verificado contra `supabase.com/pricing`, 2026-09-22) incluyen:

| Plan                                                                          | Storage incluido        | Egress incluido           | Egress cacheado incluido  | Overage       |
| ----------------------------------------------------------------------------- | ----------------------- | ------------------------- | ------------------------- | ------------- |
| Free                                                                          | 1 GB                    | 5 GB/mes                  | 5 GB/mes                  | no disponible |
| Pro (USD 25/mes, el mismo plan que ADR-004 ya presupuestó para Postgres+Auth) | 100 GB (+USD 0,0213/GB) | 250 GB/mes (+USD 0,09/GB) | 250 GB/mes (+USD 0,03/GB) | pay-as-you-go |

Los derivados que genera WP-C09 (AVIF/WebP, 320/640/1024/1600px, `packages/domain/src/catalog/media.ts`) pesan del orden de decenas a ~150 KB cada uno. Aun con una estimación generosa (2.000 productos × 5 imágenes × ~150 KB de storage; tráfico mensual muy por debajo de las decenas de GB, con la enorme mayoría cacheable porque son URLs inmutables por hash), el uso queda cómodo dentro de los 250 GB de egress cacheado del plan Pro — el mismo plan que ADR-004 ya paga por Postgres y Auth, sin costo marginal adicional relevante.

Lo que ADR-004 no pesó es el costo del otro lado: **un segundo proveedor tiene costo operativo real para quien opera solo.** Cuenta propia, credenciales propias (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` en `.env.example`, nunca provisionadas), panel propio, facturación propia, y una superficie más para desconfigurar o rotar mal. Con un solo operador (`AGENTS.md`, sin equipo de plataforma dedicado), consolidar en la plataforma que ya se paga y ya se administra pesa más que un ahorro de egress que, a esta escala, es indistinguible de cero.

## Decisión

**Las imágenes de catálogo van a Supabase Storage, no a Cloudflare R2.**

- **Catálogo público** (derivados AVIF/WebP de WP-C09): bucket público de Supabase Storage. URLs inmutables (nombradas por hash, `packages/domain/src/catalog/media.ts`) y cacheables — la misma propiedad que ADR-004 ya pedía de R2.
- **Documentos privados** (comprobantes, reportes de caja): bucket privado con URLs firmadas — esto no cambia, ADR-004 ya lo tenía así.

`R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_PUBLIC` salen de `.env.example` — nunca se provisionaron, y con esta decisión no hace falta que se provisionen.

## Consecuencias

**Positivas.** Una sola plataforma para Postgres, Auth y Storage: una cuenta, un panel, una facturación, un lugar donde rotar credenciales. La propiedad de "servido desde dominio distinto al del admin" (`docs/security-spec.md` §5) se cumple **sola**, sin ningún componente adicional: los archivos salen del dominio del proyecto de Supabase, que nunca es el dominio del admin ni el de la API. El segundo proceso Fastify de desarrollo (`apps/api/src/mediaServer.ts`, WP-C09) queda **solo para desarrollo local** — en producción no hay nada análogo que mantener, porque Supabase ya sirve desde su propio dominio.

**Negativas.** Si el supuesto S-02/S-04 se rompe (el catálogo crece mucho más allá de 2.000 productos activos, o el tráfico de imágenes crece de forma desproporcionada al volumen de ventas — por ejemplo, tráfico orgánico de buscadores de imágenes, no solo compradores) el egress sin cobrar de R2 vuelve a ser relevante. No se está apostando a que eso nunca pase — se está apostando a que, si pasa, migrar no cuesta caro. Ver la condición de reversión.

**Por qué esto no rompe nada de WP-C09.** El puerto `ObjectStorage` (`packages/domain/src/ports/storage.ts`, ya especificado en `docs/domain-contracts.md` §5 antes de esta decisión) no sabe qué proveedor hay detrás. WP-C09 implementó el único adaptador que existe hoy, disco local (`apps/api/src/adapters/storage/localDiskStorage.ts`), con una guarda explícita que impide usarlo en producción (`assertLocalDiskStorageAllowedInProduction`) — nunca asumió R2 en código, solo en la documentación de ADR-004. Nada de `apps/api` ni de `packages/domain` cambia por esta decisión.

## Condición de reversión

**Si el egress mensual medido se acerca a la cuota incluida del plan** (250 GB egress / 250 GB egress cacheado en Pro), se implementa un adaptador de R2 detrás del mismo puerto `ObjectStorage` y se migra el contenido — el resto del sistema no se entera, porque nunca conoció a Supabase Storage directamente, solo al puerto. El puerto es lo que hace barata esta decisión: no es una apuesta irreversible, es la opción con menos partes móviles **mientras** los supuestos S-02/S-04 sigan siendo ciertos.

No hay una métrica automatizada que dispare esto todavía — es una revisión manual cuando se provisione el proyecto real de Supabase (**WP-F00b**, sin dueño) y se pueda medir egress real, no estimado.

## Alternativas descartadas

- **Mantener R2 como estaba en ADR-004.** Correcto en el margen (el egress es más barato), pero optimiza el costo equivocado: a esta escala, el egress no es el costo que importa, la complejidad operativa de un segundo proveedor sí.
- **R2 solo para el catálogo público, Supabase Storage solo para lo privado (el diseño original de ADR-004).** Es el statu quo que esta decisión reemplaza — dos proveedores, dos credenciales, dos paneles, para un ahorro de egress que a esta escala no se nota.
