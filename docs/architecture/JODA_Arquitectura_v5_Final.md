# JODA Parfums — Arquitectura del Ecosistema

**Documento de arquitectura · versión 5 · consolidado y final**
Encarnación, Paraguay — 9 de septiembre de 2026

> Este documento **reemplaza** a v3, v4, Sonnet v1 y a los análisis comparativos de Gemini y GPT. Es la referencia única del proyecto. Si algo contradice un documento anterior, vale esto.
>
> Las decisiones marcadas **[V]** fueron verificadas ejecutando el esquema contra PostgreSQL 16, no solo razonadas. El detalle está en el Anexo A.

---

## Índice

1. [Visión y alcance](#1-visión-y-alcance)
2. [Decisiones arquitectónicas](#2-decisiones-arquitectónicas)
3. [Topología del sistema](#3-topología-del-sistema)
4. [Modelo de datos](#4-modelo-de-datos)
5. [Reglas de negocio críticas](#5-reglas-de-negocio-críticas)
6. [Monorepo y estructura de código](#6-monorepo-y-estructura-de-código)
7. [Seguridad y control de acceso](#7-seguridad-y-control-de-acceso)
8. [Integraciones externas](#8-integraciones-externas)
9. [Migración desde Dexie](#9-migración-desde-dexie)
10. [Operación](#10-operación)
11. [Roadmap](#11-roadmap)
12. [Riesgos](#12-riesgos)
13. [Anexo A — Hallazgos de la validación](#anexo-a--hallazgos-de-la-validación)
14. [Anexo B — Índice de ADRs](#anexo-b--índice-de-adrs)

---

## 1. Visión y alcance

### 1.1 Punto de partida

JODA Parfums opera hoy sobre un ERP construido a medida: React 19 + TypeScript + Vite + Dexie.js (IndexedDB), sin backend. Cubre inventario con costeo FIFO/promedio ponderado, producción de decants, ventas, logística, órdenes de proveedor con cascada de fletes, presupuestos, multi-moneda y un comparador de cotizaciones. Funciona, y la lógica de negocio que contiene es el activo más valioso del proyecto.

Su límite es estructural: una base de datos que vive en el navegador de una persona no puede sostener una tienda pública, ni varios usuarios, ni un catálogo indexable.

### 1.2 Destino

Un ecosistema de cuatro piezas sobre una base de datos central en la nube:

| Pieza          | Qué es                                                                       | Quién la usa        |
| -------------- | ---------------------------------------------------------------------------- | ------------------- |
| **Storefront** | E-commerce público con catálogo, carrito, checkout y seguimiento             | Clientes            |
| **Backoffice** | ERP completo: inventario, ventas, logística, compras, sourcing, contabilidad | Staff               |
| **Market**     | Módulo del backoffice: proveedores, abastecimiento, canales, sourcing        | Staff               |
| **API**        | Único origen de escritura. Contiene todos los casos de uso                   | Las tres anteriores |

### 1.3 Verticales de producto

El sistema deja de ser "de perfumería". Hoy soporta perfumes y relojes; mañana accesorios. Cada vertical tiene atributos propios y, más importante, **comportamiento propio**: un perfume se fracciona en mililitros y genera merma; un reloj lleva número de serie y garantía.

### 1.4 Lo que este proyecto NO es

- No es multi-tenant real todavía. `tenant_id` está en el esquema desde el día uno para no pagar una segunda reescritura, pero no hay onboarding de terceros ni aislamiento operativo probado.
- No es microservicios. Es un monolito modular. Con el volumen y el equipo actuales, cualquier otra cosa es costo sin beneficio.
- No es un reemplazo de tu contador. Genera asientos, libros y balances; la interpretación fiscal es humana.

---

## 2. Decisiones arquitectónicas

| #   | Área         | Decisión                                                                         | Fundamento en una línea                                                                 |
| --- | ------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | Catálogo     | **CTI + facetas JSONB + categorías N:N + tags**                                  | Lo que participa en cálculos necesita tipos; lo descriptivo no.                         |
| 2   | Repositorio  | **Monorepo pnpm + Turborepo**                                                    | El contrato de tipos compartido es el activo, y el `tsc` del CI lo protege.             |
| 3   | Storefront   | **Next.js (App Router)**                                                         | Un SPA arranca perdiendo el long-tail de búsqueda, que es donde compite el nicho.       |
| 4   | Backoffice   | **React 19 + Vite** (evolución del código actual)                                | SEO irrelevante, DX rápido, y ya existe.                                                |
| 5   | Backend      | **Fastify + tRPC + Prisma**, monolito modular                                    | Un caso de uso de venta toca ocho tablas: necesita una capa de aplicación explícita.    |
| 6   | Plataforma   | **Supabase para Postgres + Auth**; **Cloudflare R2** para imágenes públicas      | Auth y Postgres gestionados salen más baratos que construirlos; R2 no cobra egress.     |
| 7   | Escrituras   | **Solo la API escribe.** El storefront lee vistas estables                       | Si el storefront leyera tablas, el esquema interno sería API pública.                   |
| 8   | Inventario   | **Kardex append-only** + proyección de saldos + capas de costo                   | Es la única forma de auditar mililitros, mermas y stock comprometido.                   |
| 9   | Dinero       | **`bigint` en guaraníes enteros** + snapshot de FX por transacción               | El PYG no tiene subdivisión operativa; el costo importado sí es multi-moneda.           |
| 10  | Contabilidad | **Partida doble desde el día 1**, asientos **derivados** por reglas de posteo    | Retrofitear el libro mayor es carísimo; exigir que el usuario sepa contabilidad, fatal. |
| 11  | Fiscal       | `fiscal_documents` + **puerto** `FiscalProvider` con adaptadores                 | Construir el integrador SIFEN es un producto en sí mismo. No lo construimos.            |
| 12  | Identidades  | **`customers` y `staff_users` en tablas separadas**                              | Que un cliente no pueda tener rol de staff es invariante de esquema, no validación.     |
| 13  | RLS          | La API conecta con rol **`NOBYPASSRLS`**; `service_role` solo en CI **[V]**      | Con credencial privilegiada, RLS no se evalúa y es decorativo.                          |
| 14  | Triggers     | **Solo invariantes.** Nunca lógica de negocio                                    | La base garantiza lo que debe seguir siendo cierto; la app decide.                      |
| 15  | Reservas     | El carrito **no** reserva; la reserva nace en checkout con TTL por medio de pago | Reservar en carrito permite bloquear piezas únicas abriendo pestañas.                   |
| 16  | Pagos        | Checkout **hospedado** (el PAN nunca toca el sistema) + webhooks idempotentes    | SAQ A en vez de SAQ D; y Bancard reintenta.                                             |
| 17  | Migración    | **Corte único** con ETL idempotente y reconciliación. Sin dual-write             | Un usuario único puede cerrar un domingo; el dual-write agrega divergencia.             |
| 18  | Esquema      | **SQL-first.** Prisma se regenera por introspección                              | Prisma no expresa constraint triggers diferidos, RLS, dominios ni FK compuestas.        |

### 2.1 Principio rector

> **La base de datos hace cumplir invariantes. La aplicación calcula decisiones.**

Esta frase resuelve la mayoría de las discusiones de diseño que aparecieron durante la elaboración de este documento. Qué lote consumir, cómo prorratear un flete, qué asiento generar: eso es decisión, y vive en `packages/domain` en TypeScript testeable. Que el ledger sea inmutable, que un asiento cuadre, que el stock no sea negativo: eso es invariante, y vive en PostgreSQL, porque "la API es el único escritor" es cierto hasta la primera vez que alguien abre `psql` a las dos de la mañana.

---

## 3. Topología del sistema

```
                              INTERNET
                                 │
          ┌──────────────────────┴──────────────────────┐
          │                                             │
   jodaparfums.com                            admin.jodaparfums.com
   ┌──────▼───────┐                            ┌────────▼────────┐
   │  Storefront  │                            │   Backoffice    │
   │  Next.js     │                            │  React 19+Vite  │
   │  (Vercel)    │                            │   (Vercel)      │
   └──┬────────┬──┘                            └────────┬────────┘
      │        │                                        │
      │        │ lectura de catálogo                    │
      │        │ (vistas estables, rol readonly)        │
      │        └──────────────┐                         │
      │ mutaciones            │              mutaciones │
      └───────────┬───────────┼─────────────────────────┘
                  │           │
          ┌───────▼───────────▼──────┐
          │      JODA API            │   Fastify + tRPC
          │   monolito modular       │   ÚNICO ORIGEN DE ESCRITURA
          │   rol joda_api           │   ejecuta packages/domain
          │   NOBYPASSRLS            │
          └───────┬──────────┬───────┘
                  │          │
      ┌───────────▼──┐   ┌───▼──────────┐   ┌──────────────┐
      │  PostgreSQL  │   │  Redis       │   │ Cloudflare R2│
      │  (Supabase)  │   │  BullMQ      │   │ + CDN        │
      │  fuente de   │   │  jobs, caché │   │ imágenes     │
      │  verdad      │   │  de permisos │   │ públicas     │
      └──────────────┘   └──────────────┘   └──────────────┘
              │
      ┌───────▼────────┐  ┌──────────────┐  ┌──────────────┐
      │ Supabase Auth  │  │ Bancard /    │  │ Proveedor    │
      │                │  │ Pagopar      │  │ SIFEN        │
      └────────────────┘  └──────────────┘  └──────────────┘
```

### 3.1 Roles de base de datos

| Rol             | Uso                                  | Privilegios                                                             |
| --------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| `joda_api`      | Proceso que atiende requests         | CRUD, `NOBYPASSRLS`, **sin** `UPDATE`/`DELETE` sobre ledger y auditoría |
| `joda_readonly` | Lectura de catálogo del storefront   | `SELECT` sobre las vistas públicas, nada más                            |
| `service_role`  | Migraciones y ETL, **solo desde CI** | Elevado. Nunca en el runtime de la API.                                 |

Cada transacción de la API abre con:

```sql
SELECT set_config('app.user_id',   $1, true),
       set_config('app.tenant_id', $2, true),
       set_config('app.audience',  $3, true);
```

El tercer parámetro `true` hace el valor local a la transacción, para que no se filtre a otra request que reutilice la conexión del pool.

---

## 4. Modelo de datos

### 4.1 Catálogo multicategoría

Cuatro niveles que no deben confundirse:

| Nivel                         | Qué es                              | Dónde vive                                        |
| ----------------------------- | ----------------------------------- | ------------------------------------------------- |
| **Vertical** (`product_kind`) | Clasificación de **comportamiento** | Enum + tablas `{kind}_details`                    |
| **Categoría comercial**       | Navegación, breadcrumbs, SEO        | `categories` (árbol) + `product_categories` (N:N) |
| **Atributo**                  | Propiedad del producto              | Columna tipada si afecta cálculos; faceta si no   |
| **Tag**                       | Marca transversal de marketing      | `tags` + `product_tags`                           |

Un decant de Layton pertenece a "Perfumes de Nicho" **y** a "Decants" **y** lleva el tag "Best Seller". Por eso la relación con categorías es N:N con una marcada como primaria para el breadcrumb.

**Estructura del producto:**

```
products                       núcleo común + facets jsonb + search_vector
  ├── perfume_details          concentración, volumen nominal, notas,
  │                            decantable, merma en tres componentes
  ├── watch_details            movimiento, material, resistencia, garantía,
  │                            requiere_serial
  └── accessory_details        material, color, talle
```

La coherencia se impone con una FK compuesta: `products` lleva `UNIQUE (id, kind)`, y cada tabla de detalle declara `kind` con un `CHECK` de valor fijo y `FOREIGN KEY (product_id, kind)`. **[V]** Intentar cargar `perfume_details` sobre un producto `watch` es rechazado por la base.

**Por qué no EAV:** un `JOIN` por atributo filtrado, y cero integridad — `resistencia_al_agua = 'azul'` sería un `INSERT` válido. Todo el ERP depende de que `volumen_ml` sea un número.

**Por qué no STI puro:** a la tercera vertical, una tabla con 40 columnas donde el 70% es `NULL`, sin poder declarar `NOT NULL` en nada obligatorio-por-categoría.

**Agregar una vertical** = `ALTER TYPE product_kind ADD VALUE` + una tabla de detalles + un schema Zod + un mapper de facetas. Nada existente se toca. Que requiera una migración no es un defecto: una vertical nueva trae reglas, UI, permisos y tests. Es un cambio de software, no un `INSERT`.

### 4.2 Variantes

El producto no se vende: se vende una **variante**, y las variantes de un perfume tienen unidades de medida distintas entre sí.

| Tipo     | UOM  | Ejemplo                                          |
| -------- | ---- | ------------------------------------------------ |
| `sealed` | unit | Layton 125 ml precintado                         |
| `bulk`   | ml   | Líquido del frasco abierto — no se vende directo |
| `decant` | ml   | Decant de 10 ml                                  |
| `unit`   | unit | Un reloj                                         |
| `supply` | unit | Vial, atomizador, etiqueta                       |
| `tester` | ml   | Tester de exhibición                             |

Cada variante declara además su **modo de producción**: `stocked` (hay lotes propios) o `made_to_order` (se produce al vender, consumiendo granel + BOM). Un decant es típicamente `made_to_order` y apunta a su granel de origen.

### 4.3 Inventario: Kardex append-only

**Regla dura: nunca `UPDATE stock SET cantidad = ...`.**

```
inventory_lots              la unidad física comprada, con su landed cost
      │
      ├── inventory_movements          LIBRO MAYOR — inmutable
      │        │
      │        └── movement_cost_allocations   qué capa consumió cada salida
      │
      ├── inventory_balances           proyección + CHECK on_hand >= 0
      │
      ├── serialized_units             relojes: serial, garantía, dueño
      │
      └── stock_reservations           separadas del ledger
```

Cuatro consecuencias no negociables:

1. **El ledger es inmutable.** Triggers rechazan `UPDATE` y `DELETE`, y la API no tiene el privilegio. Corregir un error es un movimiento de ajuste, no una edición. **[V]**
2. **El saldo es derivado.** `inventory_balances` es una proyección mantenida en la misma transacción, con `CHECK (on_hand >= 0)` como invariante. Una sobreventa es una excepción de base de datos, no un número rojo descubierto tres meses después. **[V]**
3. **Las capas de costo se registran.** Una venta de 3 unidades puede consumir dos lotes con costos distintos; sin `movement_cost_allocations`, el COGS es una aproximación y el asiento no cierra contra existencias.
4. **Disponible = saldo − reservas vivas.** La vista `v_stock_available` lo calcula; `v_balance_drift` verifica la proyección contra el ledger y debe devolver cero filas siempre.

**Política de asignación** configurable por variante: `fifo`, `fefo`, `serial`, `manual`. Los perfumes suelen ir FIFO; los relojes, por serial.

### 4.4 Dinero

```
PYG        →  bigint de guaraníes enteros. Nunca float, nunca numeric(x,2).
Extranjera →  amount_minor (bigint) + currency + fx_rate_to_pyg + amount_pyg
```

`amount_pyg` es un **snapshot** tomado al momento de la transacción, no un cálculo en vivo. Si el dólar se mueve, el historial de caja no se reescribe solo.

El redondeo vive en **una sola función**, `app.round_pyg()`, usada idénticamente por API, admin y storefront. Duplicarla es garantía de descuadre.

### 4.5 Contabilidad de partida doble

```
chart_of_accounts  →  journal_entries  →  journal_lines
                            ▲
                      posting_rules  (plantillas declarativas por evento)
                            │
                      unposted_events (bandeja de lo que aún no postea)
```

**Los asientos se derivan, no se cargan.** El operador confirma una venta; el motor de posteo genera el asiento a partir de la plantilla del evento. Un ERP que exige saber contabilidad para operar es un ERP que no se usa.

Las reglas nacen **apagadas** y se encienden de a una. Mientras una regla esté apagada, el evento cae en `unposted_events`: visible, reprocesable, nunca perdido en silencio. Así la estructura existe desde el día uno sin que la contabilidad bloquee el arranque.

Invariante en la base: `SUM(debe) = SUM(haber)` por asiento, con constraint **diferida** — se valida al `COMMIT`, cuando ya están insertadas todas las líneas. **[V]**

Un asiento contabilizado no se modifica: se reversa con otro asiento. **[V]**

### 4.6 Documentos fiscales

Una venta puede generar 0, 1 o N documentos fiscales. Una nota de crédito referencia la factura original. **Nunca colapsar `sale_order` y `factura` en la misma tabla.**

`fiscal_documents` guarda CDC, estado, XML, KuDE y el desglose de IVA que el documento debe declarar. `fiscal_events` es la bitácora append-only del intercambio con SIFEN.

---

## 5. Reglas de negocio críticas

Estas son las reglas que ningún ERP genérico resuelve y que constituyen la ventaja del sistema. Viven en `packages/domain`, testeadas.

### 5.1 Apertura de frasco: una conversión, no un cambio de estado **[V]**

Un frasco sellado es 1 unidad. Un frasco abierto son 125 mililitros. **No son el mismo lote.** No se pueden restar mililitros de un lote medido en unidades sin mezclar peras con ml, y cualquier atajo ahí destruye la trazabilidad del Kardex.

```
lote sellado (unit)                  lote granel (ml)
  transfer_out  −1        ────────►    transfer_in  +125
  status = open_for_decant             parent_lot_id = lote sellado
  1.496.500 Gs.                        11.972 Gs./ml
```

El lote sellado abierto deja de ser vendible como sellado — eso es el "stock comprometido" del módulo de Logística, y la base lo impone. **[V]**

### 5.2 El decant tiene dos momentos

| Momento                   | Cuándo      | Qué pasa                                                |
| ------------------------- | ----------- | ------------------------------------------------------- |
| **Compromiso comercial**  | Checkout    | Se reserva granel + insumos. Nadie tocó una pipeta.     |
| **Transformación física** | Fulfillment | Alguien llena el vial. **Acá se conoce la merma real.** |

`decant_work_orders` es el puente. Guarda `waste_expected` y `waste_actual`, y una orden marcada como ejecutada **debe** declarar merma real y ejecutor.

### 5.3 La merma tiene tres componentes

| Componente           | Naturaleza                 | Campo                                    |
| -------------------- | -------------------------- | ---------------------------------------- |
| Trasvase             | Proporcional al volumen    | `waste_factor` (%)                       |
| Fondo no recuperable | Fijo por frasco            | `unusable_residue_ml`                    |
| Evaporación          | Función del tiempo abierto | `evaporation_ml_year` + ajuste periódico |

Modelar solo el porcentaje deja un faltante fantasma de 3–5 ml por frasco que se termina tapando con ajustes manuales, y esos ajustes son el ruido que hace inauditable un Kardex.

**Dato de la validación:** con `waste_factor = 2%`, la merma esperada de un decant de 10 ml es 0,200 ml. En el escenario de prueba la merma real fue 0,350 — un 75% más. La vista `v_decant_yield` expone esa relación por producto y por operador. Sobre cientos de decants al año, es plata que hoy no aparece en ningún reporte.

### 5.4 Costo puesto en Encarnación

El costo de un lote no es el precio del proveedor. Es precio + flete + despacho + comisiones, prorrateado por el criterio elegido (`by_value`, `by_unit`, `by_volume`, `manual`) y con el FX **real de esa recepción**, no el estimado de la orden.

El costo de un decant sale del landed cost real de **ese** frasco, más el BOM, más la merma. No de un promedio de catálogo. Eso es lo que hace confiables las alertas de margen.

### 5.5 BOM: el decant no es solo líquido

Un decant de 10 ml consume: 10 ml de fragancia + 1 vial + 1 atomizador + 1 etiqueta. Sin `bom_components`, el margen está sistemáticamente sobreestimado y el stock de insumos es invisible hasta que se acaban los atomizadores un viernes.

**Ejemplo verificado:** decant de Layton 10 ml a 245.000 Gs. con costo real completo → margen 41,1%. Contando solo el líquido, el margen aparente sería otro.

### 5.6 La seña es pasivo, no ingreso

Una seña es plata que se debe, no que se ganó. Acredita `2.1.02.001 Señas de clientes` y se aplica explícitamente a un pedido. La base impide aplicar o devolver más de lo recibido. **[V]**

### 5.7 IVA paraguayo sobre precio con impuesto incluido

```
IVA 10% = total / 11        IVA 5% = total / 21        Exenta = 0
```

Con `bigint` en guaraníes esto **nunca divide exacto**. Tres definiciones obligatorias antes de emitir el primer documento:

1. Redondeo a nivel de **documento** — es lo que valida SIFEN.
2. Regla única de redondeo (medio arriba), en `app.round_pyg()` y su espejo en `packages/domain`.
3. La diferencia entre la suma de líneas y el total se imputa a la última línea, documentado.

Sin esto en un solo lugar, el XML se rechaza por descuadre.

---

## 6. Monorepo y estructura de código

```
joda/
├── apps/
│   ├── storefront/          Next.js · público · SSR/ISR
│   ├── admin/               React 19 + Vite · privado
│   └── api/                 Fastify + tRPC · único escritor
│       └── src/
│           ├── modules/<dominio>/{router,service,repository}.ts
│           ├── middleware/{auth,rbac,rateLimit,audit,idempotency}.ts
│           ├── adapters/{fiscal,payments,storage}/
│           └── jobs/        BullMQ: reservas vencidas, FX, imágenes, drift
│
├── packages/
│   ├── contracts/           Zod + tipos tRPC — FUENTE DE VERDAD DE TIPOS
│   ├── domain/              LÓGICA PURA, sin I/O
│   │   └── src/{money,decant,costing,margin,stock,tax,posting}.ts
│   ├── db/                  migraciones SQL · seed · ETL · schema.prisma
│   ├── ui/                  design system compartido
│   ├── sdk/                 cliente tipado generado
│   └── config/              tsconfig · eslint · tailwind preset
│
├── infra/{supabase,docker,deployment}/
├── docs/{adr,architecture,runbooks}/
├── turbo.json
└── pnpm-workspace.yaml
```

### 6.1 Las cuatro reglas estructurales

1. **`packages/domain` no importa nada.** Ni Prisma, ni React, ni `fetch`. Funciones puras y testeadas. Es el corazón del sistema y lo que se reusa si mañana esto se vende como producto.
2. **`packages/contracts` es la única fuente de verdad de tipos.** El schema Zod valida en la API _y_ tipa los clientes. Un campo renombrado rompe la compilación de los tres apps a la vez, que es exactamente lo deseado.
3. **`apps/*` no se importan entre sí.** Enforced con `eslint-plugin-boundaries`.
4. **El código de contabilidad y sourcing nunca entra al bundle del storefront.** Son apps separadas; además, los DTO públicos y administrativos son **dos schemas Zod distintos**, no el mismo con campos opcionales.

### 6.2 Esquema: SQL-first

Las migraciones son SQL escrito a mano en `packages/db/migrations/`. `schema.prisma` se **regenera por introspección** (`prisma db pull`) después de cada migración y se commitea. Prisma es el cliente tipado, no el dueño del esquema.

Motivo: Prisma no puede expresar constraint triggers diferidos (el cuadre de asientos, el cuadre de capas de costo), políticas RLS, dominios, columnas generadas ni FK compuestas. Si el esquema lo definiera Prisma, todos los invariantes de este documento desaparecerían.

**Política de migraciones: expand/contract.** Nunca `DROP COLUMN` en el mismo deploy que deja de usarla. Agregar → escribir en ambas → migrar datos → dejar de leer la vieja → borrar en un deploy posterior.

---

## 7. Seguridad y control de acceso

### 7.1 Separación de superficies

|                     | Cliente           | Staff                                |
| ------------------- | ----------------- | ------------------------------------ |
| Dominio             | `jodaparfums.com` | `admin.jodaparfums.com`              |
| Identidad           | `customers`       | `staff_users`                        |
| Cookie              | `__Host-joda_c`   | `__Host-joda_a`, scope al subdominio |
| Audiencia del token | `customer`        | `staff`                              |
| MFA                 | Opcional          | **Obligatoria**                      |
| Sesión              | 30 días           | 8 h + refresh rotativo               |

Tablas separadas, no un discriminador: que un cliente no pueda tener rol de staff es un invariante de esquema. La separación de cookies importa porque un XSS en el storefront no debe alcanzar la sesión del admin.

### 7.2 RBAC

`permissions` (catálogo global) → `role_permissions` → `roles` → `staff_user_roles`. Permisos con forma `recurso.subrecurso:acción`.

Roles base: `owner`, `manager`, `vendedor`, `deposito`.

Nota de diseño: **`vendedor` no tiene `accounting.cashbox:read`**. Que alguien cargue una venta no implica que vea el flujo de caja ni lo que cuesta cada frasco. **`deposito`** mueve mercadería sin ver precios de compra ni márgenes.

### 7.3 Tres capas de aplicación

| Capa               | Dónde      | Qué hace                                                   |
| ------------------ | ---------- | ---------------------------------------------------------- |
| **1 — RLS**        | PostgreSQL | Aislamiento por tenant + permisos. Deny-by-default.        |
| **2 — Middleware** | API        | `requirePermission()` en cada ruta. **Defensa principal.** |
| **3 — Servicio**   | API        | Reglas dependientes del recurso concreto.                  |
| _Guardas de React_ | Frontend   | **UX, no seguridad.**                                      |

Dos detalles:

- **Las rutas administrativas devuelven 404, no 403**, para no confirmar la existencia del endpoint a un no autorizado.
- **Los permisos no viajan en el JWT.** El token lleva `user_id`, `tenant_id`, `session_id`, `audience`; los permisos se resuelven server-side con caché en Redis (TTL 60 s). Revocar un rol tiene efecto en un minuto, no cuando expire el token.

**La corrección que hace que la capa 1 exista de verdad [V]:** si la API se conecta con `service_role` o con el owner de las tablas, RLS **no se evalúa**. Por eso `joda_api` es un rol `NOBYPASSRLS`, las tablas llevan `FORCE ROW LEVEL SECURITY`, y `service_role` queda restringido a migraciones y ETL desde CI. Verificado: sin `tenant_id` en contexto, cero filas; con otro tenant, cero filas; `UPDATE` sobre el ledger, `permission denied`.

### 7.4 Endurecimiento

- **Validación en el borde:** todo body/query/param pasa por Zod desde `packages/contracts`, con `.strict()` para rechazar campos no declarados (evita mass-assignment tipo `{ role: 'owner' }`).
- **Inyección SQL:** Prisma parametriza. `$queryRawUnsafe` prohibido por regla de ESLint que falla el build.
- **Sesiones:** cookies `httpOnly`, `Secure`, `SameSite`. Access token 15 min, refresh rotativo con detección de reúso — si reaparece un refresh ya usado, se invalida toda la familia.
- **CSRF:** double-submit token en mutaciones del admin.
- **Rate limiting:** login 5/min por IP+usuario, checkout 10/min, resto 100/min.
- **Uploads:** validar por _magic bytes_, no por `Content-Type`. Reprocesar toda imagen con `sharp` (elimina EXIF y payloads). Nombre por hash. Nunca servidas desde el origen del admin.
- **Auditoría:** `audit_log` append-only sobre toda mutación de contabilidad, inventario y market. Es la defensa cuando una cifra no cuadra. **[V]**
- **Secretos:** variables de entorno validadas con Zod al arrancar; si falta una, el proceso no levanta.

---

## 8. Integraciones externas

### 8.1 Pagos

Stripe no opera con cuentas domiciliadas en Paraguay. El camino es **Bancard vPOS** para tarjetas y **Pagopar** como agregador (billeteras y boca de cobranza). Vale la pena aceptar transferencia SIPAP con confirmación: para tickets altos de nicho, mucha gente lo prefiere y no paga comisión.

**Dos reglas no negociables:**

1. **El PAN nunca toca el sistema.** Checkout hospedado o iframe. La diferencia entre SAQ A y SAQ D es la diferencia entre un formulario y una auditoría anual. Se guardan `card_last4` y `card_brand`, que no son datos de tarjeta bajo PCI. Lista negra de campos en el logger (`card`, `cvv`, `token`, `authorization`).
2. **Los webhooks son idempotentes por esquema.** `UNIQUE (provider, external_event_id)` en `payment_events`; `INSERT ... ON CONFLICT DO NOTHING` y, si no insertó, devolver el resultado guardado. **[V]** Además, el webhook nunca es fuente de verdad del monto: se confirma contra la API del proveedor antes de dar la venta por pagada.

### 8.2 Facturación electrónica (SIFEN / e-Kuatia)

La obligatoriedad avanza por grupos: los grupos 19 a 24 —pequeños contribuyentes— entre junio de 2026 y septiembre de 2027, y quien se inscribió desde 2025 emite electrónicamente de inmediato. **Averiguar el grupo del RUC de JODA es tarea previa al diseño del checkout**, no posterior.

**Decisión: no construimos el integrador.** Es SOAP con firma digital, CDC de 44 dígitos, eventos de cancelación e inutilización, contingencia, KuDE y reintentos. Es un producto en sí mismo.

```ts
// packages/domain/src/ports/fiscal.ts — el contrato, sin I/O
export interface FiscalProvider {
  issue(doc: FiscalDocumentDraft): Promise<{ cdc: string; status: FiscalStatus }>;
  cancel(cdc: string, reason: string): Promise<void>;
  status(cdc: string): Promise<FiscalStatus>;
}
```

Fase 1: adaptador `manual` — se registra el CDC emitido en e-Kuatia'i. Fase 2: adaptador del proveedor homologado que se elija. El resto del sistema no se entera.

### 8.3 Almacenamiento de imágenes

| Recurso                        | Acceso                           | Por qué                                                             |
| ------------------------------ | -------------------------------- | ------------------------------------------------------------------- |
| Fotos de catálogo publicadas   | **Público, inmutable, CDN (R2)** | Firmar rompe el caché del CDN y las previsualizaciones de WhatsApp. |
| Fotos de productos en `draft`  | Firmada, TTL 5 min               | Todavía no se filtra un lanzamiento.                                |
| Comprobantes, reportes de caja | Firmada, TTL 60 s                | Datos financieros.                                                  |
| Originales sin procesar        | Privado                          | Se sirven derivados, no originales.                                 |

Buckets separados con políticas distintas. Uno solo con reglas por prefijo termina en un error de configuración algún día.

---

## 9. Migración desde Dexie

### Fase 0 — Congelar y fotografiar (1 día)

Etiquetar `v2.x-final`. Escribir `exportSnapshot.ts` que recorra todas las tablas Dexie y produzca `snapshot-YYYYMMDD.json` con `{ schemaVersion, exportedAt, tables }`. Verificar conteos y guardarlo en dos lugares. **Es la red de seguridad**: si el ETL sale mal, se reimporta y se sigue operando.

### Fase 1 — ETL idempotente (3–5 días)

Tabla `legacy_map(legacy_table, legacy_id, new_id)` como clave de la idempotencia: cada entidad se importa una vez, y el script se puede re-ejecutar sin duplicar.

Orden obligatorio: `tenants → staff_users → brands → categories → products → *_details → variants → suppliers → purchase_orders → lots → movements → sales → cash`.

**Conversión de saldos a ledger.** Hoy hay cantidades, no historial. Por cada producto con stock se genera **un movimiento `adjustment` de apertura** fechado al día del corte, con nota `Saldo inicial migración v3` y el costo conocido. No se inventa historia retroactiva: un asiento de apertura es lo honesto y lo auditable.

**Dinero.** Todo importe en `float` se convierte con regla explícita y **toda diferencia se loguea**. Nada de conversiones silenciosas en caja.

### Fase 2 — Imágenes (2–3 días)

Por cada base64: decodificar, hashear con SHA-256 (deduplica), validar que sea imagen real con `sharp`, subir original + derivados AVIF/WebP en 320/640/1024/1600 px, crear fila en `media`, reemplazar el campo base64 por `media_id`. El campo base64 se elimina **recién después de la reconciliación**.

### Fase 3 — Reconciliación y corte (1 día)

Script que compara Dexie contra Postgres y **falla** si algo no cuadra:

- Conteo de productos, variantes, proveedores, ventas
- **Stock por variante** (unidades y mililitros) — tolerancia 0
- **Saldo de caja en guaraníes** — tolerancia 0
- **Señas pendientes** — monto y cantidad
- Imágenes migradas vs. base64 en origen

Salida: `reconciliation-report.md` con ✅/❌ por métrica.

**Corte único, sin dual-write.** El dual-write existe para sistemas que no pueden parar; acá se puede cerrar un domingo a la mañana, y agrega una clase entera de bugs de divergencia a cambio de nada.

Secuencia: última venta en v2 → export → ETL → reconciliación → verificación manual de 10 productos y del arqueo → DNS. **Rollback:** v2 sigue funcionando en el navegador con su IndexedDB intacta, porque el ETL solo lee.

### Fase 4 — Recuperar el offline como caché (posterior)

Se pierde algo real al salir de Dexie: en una feria con mala señal, un admin puro-nube no sirve. La solución no es volver atrás, es el **patrón outbox**: Dexie pasa a ser caché de lectura del admin (PWA), las mutaciones offline se encolan con `Idempotency-Key`, y al recuperar conexión se envían en orden. **El stock nunca se resuelve en el cliente**: el servidor recalcula desde el ledger y, si no hay disponible, rechaza y la operación aparece en una bandeja de conflictos.

---

## 10. Operación

### 10.1 Estrategia de pruebas

| Nivel              | Qué cubre                                                        | Herramienta                            |
| ------------------ | ---------------------------------------------------------------- | -------------------------------------- |
| Unitario           | `packages/domain`: costeo, decants, merma, IVA, redondeo, posteo | Vitest — cobertura alta, no negociable |
| Integración        | Transacciones, constraints, triggers, RLS                        | Testcontainers con Postgres real       |
| **Dataset dorado** | ~20 operaciones reales con resultados calculados a mano          | Corre en CI                            |
| Invariantes        | Cada guarda intenta la operación inválida y espera rechazo       | `packages/db/tests/invariants.sql`     |
| E2E                | Flujos críticos de checkout y venta en mostrador                 | Playwright                             |

El dataset dorado es lo que permite refactorizar el costeo sin miedo.

### 10.2 Respaldos

PITR contratado **antes** del corte, con un **simulacro de restauración** a un proyecto nuevo antes de migrar datos reales, repetido cada trimestre. Un backup que nunca se restauró es una creencia.

### 10.3 Observabilidad

Logs estructurados con `request_id`, Sentry, y **alertas de negocio**, que valen más que cualquier dashboard de CPU:

- Saldo negativo en cualquier variante (no debería poder ocurrir — si ocurre, algo se escribió por fuera del flujo)
- `v_balance_drift` devuelve filas
- Asiento descuadrado
- Evento en `unposted_events` con más de 24 h
- Webhook de pago fallido
- Margen de venta negativo
- Diferencia de arqueo de caja

### 10.4 Entornos

`dev` local con Docker · `staging` contra copia anonimizada de producción · `prod`.

---

## 11. Roadmap

| Bloque | Contenido                                                        | Salida                               |
| ------ | ---------------------------------------------------------------- | ------------------------------------ |
| **A**  | Monorepo, `packages/domain` extraído del v2 con tests, contratos | Lógica de negocio aislada y testeada |
| **B**  | Esquema Postgres + migraciones + seed                            | Base ejecutable                      |
| **C**  | API: auth, RBAC, catálogo, inventario, ventas, compras           | Backend funcional                    |
| **D**  | ETL, imágenes, reconciliación                                    | Datos migrados y verificados         |
| **E**  | Admin migrado módulo a módulo                                    | Backoffice sobre la nube             |
| **F**  | **Corte a la nube**                                              | Operación real en producción         |
| **G**  | Storefront: catálogo, PDP, carrito, checkout, pagos              | Tienda pública                       |
| **H**  | Motor de posteo activo + integración fiscal                      | Contabilidad y facturación           |
| **I**  | RMA, CRM, canales adicionales                                    | Según demanda real                   |

**El corte a la nube (F) va antes del storefront (G).** Un sistema en producción vale más que tres a medias, y el storefront sobre un ERP que ya opera en la nube es mucho más simple que ambos a la vez.

---

## 12. Riesgos

| Riesgo                                     | Mitigación                                                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| La migración corrompe stock o caja         | Reconciliación obligatoria + snapshot + v2 intacta como rollback                                                                        |
| Sobreventa de piezas únicas                | Reservas con TTL + `SELECT FOR UPDATE` en orden ascendente de `lot_id` (el orden determinístico evita deadlocks en pedidos multi-línea) |
| Fuga de costos o proveedores al storefront | DTO separados por audiencia + tests que verifican la forma de la respuesta pública + RLS                                                |
| Descalce de FX en compras                  | `fx_rate` congelado por recepción, nunca recalculado                                                                                    |
| Obligatoriedad SIFEN antes de lo previsto  | Confirmar el grupo del RUC ahora; adaptador `manual` disponible desde el inicio                                                         |
| Deriva silenciosa de proyecciones          | `v_balance_drift` + job nocturno con alerta                                                                                             |
| Scope creep                                | El esquema acomoda todo; el código se implementa por bloques, y F es la meta intermedia                                                 |

---

## Anexo A — Hallazgos de la validación

El esquema completo se ejecutó contra PostgreSQL 16 antes de cerrar este documento: 61 tablas, 104 `CHECK`, 138 claves foráneas, 128 índices, 36 tablas con RLS activo, 45 políticas, y 18 de 18 pruebas de invariantes en verde. El flujo de negocio corre de punta a punta —compra en USD con flete, apertura de frasco, fraccionamiento con merma real, venta, asiento— y cierra con deriva cero.

Tres cosas cambiaron por haberlo ejecutado:

### A.1 Un lote no puede cambiar de unidad de medida

Descrito en 5.1. Obligó a agregar el tipo de variante `bulk` y `inventory_lots.parent_lot_id`. Ningún documento previo lo había detectado, y sin esa conversión explícita el modelo de decants no cierra.

### A.2 `ON CONFLICT DO UPDATE` no protege contra un `CHECK`

La proyección de saldos estaba escrita como `INSERT ... ON CONFLICT (lot_id) DO UPDATE SET on_hand = on_hand + excluded.on_hand`. Parece correcto y **falla en la primera salida de stock**: PostgreSQL evalúa los `CHECK` de la fila propuesta _antes_ de detectar el conflicto por índice único, así que `on_hand = -10` viola la restricción de no-negatividad antes de que el `ON CONFLICT` llegue a sumar.

Corrección: la fila de saldo nace en cero junto con el lote, y la proyección es siempre un `UPDATE` puro. Beneficio no buscado: desaparece la carrera entre dos movimientos concurrentes creando la misma fila.

### A.3 La merma estimada estaba muy por debajo de la real

Descrito en 5.3. Con números reales, `waste_actual / waste_expected = 1.75`. Es el argumento empírico para separar merma esperada de merma real en `decant_work_orders`.

**Ubicación del artefacto:** `packages/db/{migrations,seed,tests}` — SQL ejecutable, no pseudocódigo.

---

## Anexo B — Índice de ADRs

Cada uno en `docs/adr/`, formato corto: contexto / decisión / consecuencias.

| ADR | Decisión                                                          |
| --- | ----------------------------------------------------------------- |
| 001 | Monolito modular, no microservicios                               |
| 002 | Monorepo con pnpm + Turborepo                                     |
| 003 | Next.js para storefront, Vite para admin                          |
| 004 | Supabase como plataforma, API propia como autoridad de negocio    |
| 005 | CTI + facetas JSONB para el catálogo multicategoría               |
| 006 | Taxonomía de cuatro niveles: vertical, categoría, atributo, tag   |
| 007 | Kardex append-only; el saldo es proyección                        |
| 008 | Capas de costo explícitas (`movement_cost_allocations`)           |
| 009 | Apertura de frasco como conversión de lote                        |
| 010 | Decant en dos momentos + BOM + merma en tres componentes          |
| 011 | `bigint` PYG y snapshot de FX por transacción                     |
| 012 | Partida doble desde el día 1, asientos derivados, reglas apagadas |
| 013 | Señas como pasivo                                                 |
| 014 | Frontera fiscal con puerto y adaptadores                          |
| 015 | Identidades separadas: `customers` / `staff_users`                |
| 016 | RBAC en tres capas; la API con rol `NOBYPASSRLS`                  |
| 017 | Triggers solo para invariantes                                    |
| 018 | SQL-first; Prisma por introspección                               |
| 019 | Reserva en checkout, no en carrito                                |
| 020 | Checkout hospedado + webhooks idempotentes                        |
| 021 | Corte único sin dual-write                                        |
| 022 | `tenant_id` desde el día 1                                        |
| 023 | Stack de frontend y sistema de diseño                             |
