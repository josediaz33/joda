# Registro de Decisiones de Arquitectura (ADR)

Decisiones cerradas del proyecto JODA Parfums. **No se reabren en una sesión de trabajo**: si una parece equivocada, se argumenta y se reemplaza con un ADR nuevo que la marque como superada.

Formato: contexto → decisión → consecuencias → alternativas descartadas.

| ADR                                          | Decisión                                                                                | Ámbito                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------- |
| [ADR-001](001-monolito-modular.md)           | Monolito modular, no microservicios                                                     | Arquitectura general          |
| [ADR-002](002-monorepo.md)                   | Monorepo con pnpm y Turborepo                                                           | Repositorio                   |
| [ADR-003](003-frontends.md)                  | Next.js para storefront, Vite para admin                                                | Frontend                      |
| [ADR-004](004-supabase-plataforma.md)        | Supabase como plataforma, API propia como autoridad de negocio                          | Infraestructura               |
| [ADR-005](005-cti-facetas.md)                | CTI más facetas JSONB para el catálogo multicategoría                                   | Modelo de datos               |
| [ADR-006](006-taxonomia.md)                  | Taxonomía de cuatro niveles                                                             | Modelo de datos               |
| [ADR-007](007-kardex.md)                     | Kardex append-only; el saldo es proyección                                              | Inventario                    |
| [ADR-008](008-capas-de-costo.md)             | Capas de costo explícitas                                                               | Inventario · Contabilidad     |
| [ADR-009](009-apertura-frasco.md)            | La apertura de frasco es una conversión de lote                                         | Inventario · Decants          |
| [ADR-010](010-decant-dos-momentos.md)        | El decant tiene dos momentos, más BOM y merma en tres componentes                       | Decants                       |
| [ADR-011](011-dinero-pyg.md)                 | Guaraníes en bigint, FX con snapshot                                                    | Dinero                        |
| [ADR-012](012-partida-doble.md)              | Partida doble desde el día uno, con asientos derivados                                  | Contabilidad                  |
| [ADR-013](013-senas-pasivo.md)               | La seña es un pasivo, no un ingreso                                                     | Contabilidad · Ventas         |
| [ADR-014](014-frontera-fiscal.md)            | Frontera fiscal con puerto y adaptadores                                                | Fiscal                        |
| [ADR-015](015-identidades-separadas.md)      | Identidades separadas: customers y staff_users                                          | Seguridad                     |
| [ADR-016](016-rbac-tres-capas.md)            | RBAC en tres capas, con la API en un rol NOBYPASSRLS                                    | Seguridad                     |
| [ADR-017](017-triggers.md)                   | Triggers solo para invariantes                                                          | Base de datos                 |
| [ADR-018](018-sql-first.md)                  | SQL-first; Prisma se regenera por introspección                                         | Base de datos                 |
| [ADR-019](019-reserva-checkout.md)           | La reserva de stock nace en el checkout, no en el carrito                               | Ventas · Inventario           |
| [ADR-020](020-pagos.md)                      | Checkout hospedado y webhooks idempotentes                                              | Pagos                         |
| [ADR-021](021-corte-unico.md)                | Corte único, sin dual-write                                                             | Migración                     |
| [ADR-022](022-tenant-id.md)                  | tenant_id desde el día uno                                                              | Modelo de datos               |
| [ADR-023](023-stack-frontend.md)             | Stack de frontend y sistema de diseño                                                   | Frontend                      |
| [ADR-024](024-objetos-de-valor-en-shared.md) | Los objetos de valor de dinero y cantidad viven en packages/domain/src/shared/          | Estructura de packages/domain |
| [ADR-025](025-imagenes-supabase-storage.md)  | Imágenes de catálogo en Supabase Storage, no Cloudflare R2 (reemplaza parte de ADR-004) | Infraestructura               |

---

## Cómo agregar un ADR

1. Copiar el formato de cualquiera de los existentes.
2. Numerar consecutivamente.
3. Si reemplaza a otro, marcarlo en el encabezado de ambos (`Reemplazado por ADR-0XX`).
4. Un ADR se escribe cuando la decisión es difícil de revertir o cuando alguien la va a cuestionar en seis meses. Las decisiones triviales no llevan ADR.
5. Si lo que cambia es una **referencia incidental** de la decisión —una ruta de
   archivo, un nombre, una sección citada en otro documento— y no el
   contenido de la decisión en sí, no hace falta un ADR de reemplazo.
   Alcanza con una nota en el encabezado del ADR original:
   `**Corrección (<fecha>):** <qué cambió y por qué>, ver <documento o ADR de respaldo>.`
   Reservá `Reemplazado por ADR-0XX` para cuando la decisión misma
   cambia: se elige otra alternativa, se revierte una consecuencia
   aceptada, se contradice una prohibición. La pregunta que separa un
   caso del otro: ¿alguien tendría que volver a evaluar el trade-off
   original para entender el cambio, o alcanza con corregir un dato que
   estaba mal escrito desde el principio?
