# Especificación de Frontend

La vidriera es el producto. Este documento cubre el stack, el sistema de diseño, el presupuesto de rendimiento, la estrategia de posicionamiento y los patrones de interfaz propios de este negocio.

Aplica a `apps/storefront`, `apps/admin` y `packages/ui`.

---

## 1. Dos productos, un sistema de diseño

Antes que cualquier decisión técnica: **el storefront y el backoffice no se parecen, y no deben parecerse.**

|            | Storefront                                | Backoffice                            |
| ---------- | ----------------------------------------- | ------------------------------------- |
| Trabajo    | Convencer y vender                        | Operar rápido y sin errores           |
| Usuario    | Alguien que entra una vez desde Instagram | Vos, ocho horas por día               |
| Densidad   | Aire, foco en la imagen                   | Densa, mucha información visible      |
| Motion     | Deliberada, escasa                        | Solo la que confirma una acción       |
| Tipografía | Con personalidad                          | Legible a 13px en tablas              |
| Métrica    | Conversión, LCP, posicionamiento          | Clics por operación, errores evitados |

Comparten **tokens** (color base, escala tipográfica, espaciado, radios) y **primitivas** (Dialog, Popover, Select). No comparten composiciones ni densidad. Un ERP que parece una landing es lento de operar; una tienda que parece un ERP no vende.

---

## 2. Stack

### 2.1 Confirmado

| Capa                 | Elección                  | Nota                                                           |
| -------------------- | ------------------------- | -------------------------------------------------------------- |
| Framework storefront | **Next.js (App Router)**  | SSG/ISR. Ver ADR-003                                           |
| Framework admin      | **React 19 + Vite**       | SPA. SEO irrelevante                                           |
| Estilos              | **Tailwind CSS v4**       | Configuración CSS-first con `@theme`, sin `tailwind.config.js` |
| Componentes          | **shadcn/ui sobre Radix** | Accesibles, sin dependencia pesada, código propio              |
| Iconos               | **Lucide**                | Importar por nombre, nunca el barrel completo                  |

### 2.2 Precisiones sobre lo que propusiste

**Tailwind v4 cambia dónde viven los tokens.** No hay `tailwind.config.js`: la configuración es CSS. Eso encaja bien acá porque el mismo archivo de tokens sirve a los dos apps.

```css
/* packages/ui/src/styles/tokens.css */
@import "tailwindcss";

@theme {
  --color-ink-900: #16151a;
  --color-bone-50: #faf8f5;
  --color-accent-600: #8a5a2b;

  --font-display: "<display>", serif;
  --font-body: "<body>", system-ui, sans-serif;

  --radius-card: 2px;
  --spacing-gutter: 1.5rem;
}
```

**shadcn/ui en monorepo necesita una decisión explícita.** shadcn copia código, no instala paquetes. En monorepo eso significa elegir dónde vive:

- Primitivas genéricas (Button, Dialog, Select, Popover, Toast) → `packages/ui/src/primitives/`
- Composiciones del storefront (ProductCard, PriceTag, CartLine) → `apps/storefront/src/components/`
- Composiciones del admin (DataTable, LotPicker, MovementRow) → `apps/admin/src/components/`

Configurá `components.json` en `packages/ui` con el alias correcto. Si no, cada `npx shadcn add` deposita archivos en el app donde lo corriste y terminás con tres versiones del mismo Button.

**Framer Motion: acá te voy a discutir.** Es una librería excelente y en el admin no tengo objeción. En el storefront tiene dos costos concretos:

1. Pesa entre 30 y 50 kB comprimidos. Sobre 4G paraguaya, en una página de producto donde el presupuesto total es 180 kB, eso es un cuarto del presupuesto gastado en animación.
2. En App Router obliga a `"use client"` en cualquier componente que la use. Si la animás la tarjeta de producto, la grilla entera deja de ser un componente de servidor.

Mi recomendación:

- **Transiciones de página y micro-interacciones de catálogo:** CSS puro y la View Transitions API. Cubre el 80% de lo que necesitás con cero kB.
- **Framer Motion:** solo en islas específicas fuera del camino crítico — el visor de imágenes del producto, el panel del carrito, alguna secuencia de la portada. Nunca en la grilla de catálogo ni por encima del pliegue.
- **Admin:** libre. El presupuesto de bundle no es un problema ahí.

Y una advertencia de criterio, más que de rendimiento: entradas de tipo _fade-and-slide-up_ en cada sección y transiciones al pasar el mouse sobre cada tarjeta son el default genérico y se leen como plantilla. Un solo momento orquestado —la aparición del producto principal, la apertura del carrito— vale más que efectos repartidos por todos lados.

### 2.3 Lo que falta en la tabla

| Necesidad              | Elección                                        | Por qué                                                                                                                             |
| ---------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Formularios            | **react-hook-form + `@hookform/resolvers/zod`** | **Reusa los esquemas de `packages/contracts`.** El mismo Zod valida en el cliente y en el servidor: una sola definición de la regla |
| Datos en el admin      | **tRPC + TanStack Query**                       | Tipado extremo a extremo, caché, invalidación, estado optimista                                                                     |
| Datos en el storefront | **Componentes de servidor + Server Actions**    | Sin cliente de datos en el camino crítico                                                                                           |
| Tablas del admin       | **TanStack Table**                              | Headless: ordenamiento, filtros y virtualización sin imponer estilos                                                                |
| Gráficos de reportes   | **Recharts**                                    | Suficiente para las cuatro visualizaciones del backlog                                                                              |
| Notificaciones         | **sonner**                                      | Ligero, accesible, buen manejo de cola                                                                                              |
| Fechas                 | **date-fns** con locale `es`                    | Zona `America/Asuncion`, formato `dd/mm/aaaa`                                                                                       |
| Búsqueda del admin     | **cmdk**                                        | Paleta de comandos: la diferencia entre 4 clics y 2 teclas                                                                          |
| Virtualización         | **TanStack Virtual**                            | Listas largas de movimientos de inventario                                                                                          |
| Estado de UI           | **Zustand**, solo si hace falta                 | El estado del servidor lo maneja Query; el de UI casi siempre es local                                                              |

**Lo que NO va:** ninguna librería de componentes con estilos propios (MUI, Ant, Chakra). Chocan con Tailwind, pesan, y su estética es reconocible — exactamente lo contrario de lo que necesita una marca.

---

## 3. Dirección visual

JODA Parfums ya tiene identidad. Este documento **no la reemplaza**: define cómo traducirla a tokens y qué evitar.

### 3.1 Derivar los tokens de la marca existente

1. Extraé de los materiales actuales (logo, empaques, contenido de Instagram) entre cuatro y seis colores base con nombre y valor hexadecimal.
2. Definí dos tipografías como máximo, con roles claros: una de display y una de texto. Si son dos, que sean claramente distintas — si se parecen, usá una sola con dos pesos.
3. Fijá una escala tipográfica y una de espaciado. Que sean escalas, no valores sueltos.
4. Un solo radio de borde por jerarquía, no el mismo para todo.

### 3.2 La idea que debería gobernar la estética

El negocio no vende perfume: vende **acceso** a perfume caro. Un decant de 10 ml existe para que alguien pruebe un Layton sin gastar dos millones de guaraníes. Eso da un registro visual propio, más cercano a la precisión —el mililitro, la medida, la transferencia cuidadosa— que al lujo genérico de vidriera.

Aprovechalo: el mililitro como motivo, la medida exacta como dato visible, la fotografía del frasco tratada con la seriedad de un catálogo de instrumentos. Es más distintivo que copiar la estética de una casa de nicho europea, y es honesto respecto de lo que hacés.

### 3.3 Lo que hay que evitar

Si le pedís a un agente que diseñe "un e-commerce de perfumería de lujo", va a producir alguna de estas. Todas son legítimas para algún proyecto y ninguna es una decisión:

- Fondo crema cálido (cercano a `#F4F1EA`) con serif de alto contraste y acento terracota (cercano a `#D97757`).
- Fondo casi negro con un único acento verde ácido o bermellón.
- El kit de tarjetas SaaS: todo picado en tarjetas redondeadas idénticas, el mismo radio en todo sin jerarquía, la misma sombra gris suave debajo de cada una.
- Chrome de plantilla: etiqueta en versalitas espaciadas encima de cada título, cadenas de metadatos unidas con puntos medios, flechitas `→` pegadas al texto de cada enlace.

Poné esta lista en el prompt cuando pidas diseño. Es la advertencia que más rinde.

### 3.4 Piso de calidad, sin anunciarlo

Adaptativo hasta 360 px, foco de teclado visible, `prefers-reduced-motion` respetado, contraste accesible. No se negocia y no se menciona en la interfaz.

---

## 4. `packages/ui`

```
packages/ui/src/
├── styles/
│   ├── tokens.css          @theme de Tailwind v4 — fuente única
│   └── globals.css         reset, tipografía base, utilidades
├── primitives/             shadcn sobre Radix — sin opinión de marca
│   ├── button.tsx  dialog.tsx  select.tsx  popover.tsx
│   └── toast.tsx   sheet.tsx   tooltip.tsx  form.tsx
├── format/                 CRÍTICO: formateo compartido
│   ├── money.ts            Gs. 245.000 — Intl.NumberFormat('es-PY')
│   ├── quantity.ts         10 ml · 1 unidad · 114,65 ml
│   └── date.ts             dd/mm/aaaa, zona America/Asuncion
└── icons.ts                reexport nombrado de Lucide
```

**`format/` merece atención especial.** El formateo de guaraníes tiene que existir en un solo lugar, igual que el redondeo en el dominio. Un `Gs. 245000` sin separador de miles en una pantalla, y `Gs. 245.000` en otra, es el tipo de detalle que hace que un sistema parezca improvisado.

```ts
// packages/ui/src/format/money.ts
const pygFormatter = new Intl.NumberFormat("es-PY", {
  style: "currency",
  currency: "PYG",
  maximumFractionDigits: 0,
});

/** El dinero llega como string desde la API (ver api-conventions §3). */
export function formatPyg(minor: string): string {
  return pygFormatter.format(Number(minor));
}
```

---

## 5. Rendimiento

### 5.1 Presupuesto por ruta

| Ruta               | JS transferido | LCP (4G) | CLS    | INP      |
| ------------------ | -------------- | -------- | ------ | -------- |
| Portada            | ≤ 120 kB       | < 2,0 s  | < 0,05 | < 200 ms |
| Categoría          | ≤ 150 kB       | < 2,5 s  | < 0,1  | < 200 ms |
| Producto           | ≤ 180 kB       | < 2,5 s  | < 0,1  | < 200 ms |
| Checkout           | ≤ 220 kB       | < 3,0 s  | < 0,1  | < 200 ms |
| Admin (cualquiera) | ≤ 400 kB       | < 3,0 s  | —      | < 200 ms |

Se mide con Lighthouse CI en el pipeline. **Exceder el presupuesto bloquea la fusión**, igual que un test que falla. Un presupuesto que se puede ignorar no es un presupuesto.

### 5.2 Tipografías

La causa más común de LCP malo en tiendas de nicho es una tipografía de display que bloquea el renderizado.

```tsx
import localFont from "next/font/local";

export const display = localFont({
  src: "./fonts/display.woff2",
  display: "swap", // nunca 'block'
  preload: true,
  fallback: ["Georgia", "serif"],
  adjustFontFallback: "Times New Roman", // reduce el salto de layout
});
```

Reglas: subconjunto latino con los caracteres que uses realmente, `woff2` únicamente, dos familias como máximo y como mucho tres pesos. Autoalojadas, nunca desde Google Fonts por CDN — es una petición a otro dominio en el camino crítico.

### 5.3 Imágenes

Es el rubro que más pesa en una perfumería, y donde más se gana.

```tsx
<Image
  src={media.url} // Supabase Storage (ADR-025), URL pública inmutable
  alt={`${product.brandName} ${product.name}`}
  width={800}
  height={1000} // SIEMPRE: evita el salto de layout
  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
  priority={isAboveTheFold} // solo la primera imagen
  placeholder="blur"
  blurDataURL={media.blurHash}
/>
```

- Los derivados AVIF y WebP ya se generan en el ETL (WP-D06). El storefront los consume, no los produce.
- `width` y `height` siempre, o `aspect-ratio` en CSS. Sin eso, CLS.
- `priority` solo en la imagen principal del producto. En más de una, compiten entre sí y empeora el LCP.
- Las imágenes de catálogo son **públicas e inmutables con CDN**, no firmadas. Firmarlas rompe el caché y las vistas previas de WhatsApp (ADR-004).

### 5.4 JavaScript

- **Componentes de servidor por defecto.** `"use client"` solo donde hay interactividad real, y lo más abajo posible en el árbol.
- Carga diferida para lo que no está por encima del pliegue: panel del carrito, visor de imágenes, filtros en móvil.
- Lucide se importa por nombre (`import { ShoppingBag } from 'lucide-react'`), nunca el barrel completo.
- En el admin, división por ruta con `React.lazy`. Un `vendedor` no debe descargar el módulo de contabilidad — es rendimiento **y** es la carga diferida que menciona la especificación de seguridad.

---

## 6. Posicionamiento

Esta sección es la que decide si la inversión en el storefront propio se justifica frente a Shopify.

### 6.1 Estrategia de renderizado

| Ruta               | Estrategia | Revalidación |
| ------------------ | ---------- | ------------ |
| Portada            | ISR        | 10 min       |
| Categoría          | ISR        | 10 min       |
| **Producto**       | **ISR**    | **5 min**    |
| Búsqueda y filtros | Dinámica   | —            |
| Carrito y checkout | Cliente    | —            |
| Cuenta             | Dinámica   | —            |

El precio y la disponibilidad cambian, pero no minuto a minuto. Cinco minutos de revalidación en la página de producto es el punto donde el HTML sale del caché y el dato sigue siendo cierto.

### 6.2 Estructura de URLs

```
/                                          portada
/perfumes                                  categoría
/perfumes/nicho                            subcategoría
/perfumes/parfums-de-marly-layton          producto
/relojes/seiko-skx007                      producto
/marcas/parfums-de-marly                   marca
/decants                                   categoría transversal
```

- Slug del producto, nunca el identificador. `/producto/a3f9-...` no posiciona nada.
- El slug es estable. Si cambia, redirección 301 permanente desde el anterior — hace falta una tabla de slugs históricos.
- Sin `.html`, sin mayúsculas, sin parámetros de seguimiento en enlaces internos.

### 6.3 La trampa de la navegación por facetas

Es **el** error de posicionamiento en e-commerce, y con el catálogo multicategoría es fácil caer.

Filtros combinables generan URLs infinitas: familia × concentración × marca × precio × disponibilidad. Google gasta el presupuesto de rastreo en variantes vacías, y termina indexando contenido duplicado en lugar de tus páginas buenas.

**Decidí explícitamente qué faceta es indexable y cuál no:**

| Faceta                                        | Tratamiento                                                     |
| --------------------------------------------- | --------------------------------------------------------------- |
| Categoría, subcategoría                       | Ruta propia, indexable, enlazada en el menú                     |
| Marca                                         | Ruta propia `/marcas/<slug>`, indexable                         |
| Familia olfativa                              | Ruta propia si tiene volumen de búsqueda real; si no, parámetro |
| Concentración, tamaño, precio, disponibilidad | **Parámetro de consulta, `noindex`, canónica a la ruta base**   |
| Orden y paginación                            | Canónica a la página 1 salvo que uses `rel=next/prev`           |
| Combinación de dos o más facetas              | **Siempre `noindex`**                                           |

```tsx
export async function generateMetadata({ searchParams }): Promise<Metadata> {
  const hasFilters = Object.keys(searchParams).some((k) => FILTER_KEYS.includes(k));
  return {
    robots: hasFilters ? { index: false, follow: true } : { index: true, follow: true },
    alternates: { canonical: `/perfumes/nicho` },
  };
}
```

Los enlaces a facetas no indexables llevan `rel="nofollow"` en la navegación, para no gastar rastreo.

### 6.4 Datos estructurados

Sin esto no aparecés con precio y disponibilidad en los resultados de búsqueda, que es la diferencia visible entre un resultado y otro.

```tsx
const productLd = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: `${product.brandName} ${product.name}`,
  description: product.description,
  image: product.images.map((i) => i.url),
  brand: { "@type": "Brand", name: product.brandName },
  offers: variants.map((v) => ({
    "@type": "Offer",
    name: v.label, // "Decant 10 ml"
    price: v.pricePyg,
    priceCurrency: "PYG",
    availability: v.inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    url: `https://jodaparfums.com/${category}/${product.slug}?v=${v.sku}`,
    itemCondition: "https://schema.org/NewCondition",
  })),
};
```

**Regla dura: los datos estructurados deben coincidir con lo que ve el usuario.** Declarar `InStock` en algo agotado, o un precio distinto al de la página, es motivo de penalización manual. Como el `inStock` sale de `v_catalog_variants`, coinciden por construcción — pero si alguien lo cachea aparte, se rompe.

Además: `BreadcrumbList` en cada producto y categoría, `Organization` con datos de contacto en la portada, `WebSite` con `SearchAction`. **`AggregateRating` solo si hay reseñas reales**; inventarlas es riesgo de penalización.

### 6.5 Metadatos y redes sociales

El tráfico llega por WhatsApp e Instagram, así que la vista previa importa más que la meta descripción.

```tsx
export async function generateMetadata({ params }): Promise<Metadata> {
  const p = await getProduct(params.slug);
  return {
    title: `${p.brandName} ${p.name} — Decants y frasco sellado | JODA Parfums`,
    description: p.metaDescription, // única, escrita a mano
    alternates: { canonical: `/${p.categoryPath}/${p.slug}` },
    openGraph: {
      type: "website",
      title: `${p.brandName} ${p.name}`,
      description: p.shortDescription,
      images: [{ url: p.ogImage, width: 1200, height: 630 }],
      locale: "es_PY",
    },
  };
}
```

La imagen de Open Graph va en 1200×630 y por debajo de 300 kB: WhatsApp descarta las más pesadas y el enlace queda sin vista previa.

### 6.6 Contenido único

**El punto de posicionamiento más importante de todos, y el que no se resuelve con código.**

Todas las tiendas de nicho copian la descripción del fabricante. Google trata eso como contenido duplicado y te ubica detrás de sitios con más autoridad. Si tus fichas dicen lo mismo que las de otros veinte revendedores, no vas a posicionar por más impecable que sea el HTML.

Lo que sí funciona en este rubro: descripción propia con tu opinión y tu experiencia, notas de proyección y duración medidas por vos, comparaciones con otros perfumes de tu catálogo, para qué ocasión y qué clima —relevante en Encarnación, donde el verano cambia cómo rinde una fragancia—. Eso es contenido que nadie más tiene, y es el mismo material que ya producís para Instagram.

Marcá en el admin qué fichas tienen descripción propia y cuáles no. Es una métrica de negocio.

### 6.7 Infraestructura técnica

- `sitemap.xml` generado desde la base, solo productos publicados, con `lastmod` real.
- `robots.txt` bloqueando `/carrito`, `/checkout`, `/cuenta` y las rutas de facetas combinadas.
- Enlazado interno: productos relacionados por familia olfativa y por marca. Distribuye autoridad y es útil para el visitante.
- Sin cadenas de redirección: una sola salto, siempre.
- HTTPS con HSTS, ya en la especificación de seguridad.

---

## 7. Accesibilidad

`RNF-USA-04` exige WCAG 2.1 nivel AA en el storefront. Radix resuelve buena parte pero no todo:

- **Contraste 4,5:1** en texto normal, 3:1 en texto grande. Verificá los tokens de marca antes de fijarlos: un gris claro elegante sobre blanco puede no pasar.
- **Foco visible siempre.** Nunca `outline: none` sin reemplazo.
- **Navegación completa por teclado** en checkout y catálogo.
- **Errores de formulario asociados** al campo con `aria-describedby` y anunciados en una región `aria-live`.
- **Texto alternativo real** en las imágenes de producto: `"Frasco de Parfums de Marly Layton 125 ml"`, no `"producto"`.
- **Zonas táctiles de 44×44 px** como mínimo en móvil.
- `prefers-reduced-motion` respetado en toda animación.

`@axe-core/playwright` corre sobre las rutas críticas en el pipeline.

---

## 8. Patrones de interfaz del dominio

Los que son propios de este negocio y ningún tema de tienda resuelve.

### 8.1 Disponibilidad, nunca cantidad

La especificación de seguridad prohíbe exponer el stock exacto: es información competitiva. La interfaz muestra estado, no número.

```
Disponible          available > 3
Últimas unidades    available entre 1 y 3
Agotado             available = 0
Bajo pedido         made_to_order con granel disponible
```

El escalón de "últimas unidades" es honesto y es el mensaje de urgencia real que necesita ADR-019 cuando dos personas compiten por el último frasco.

### 8.2 Selector de variante

Un perfume tiene sellado de 125 ml y decants de 2, 5 y 10 ml. El selector debe mostrar simultáneamente tamaño, precio y **precio por mililitro** — que es exactamente lo que compara un comprador de decants, y no mostrarlo lo obliga a hacer la cuenta.

```
○  2 ml     Gs.  58.000      Gs. 29.000/ml
●  10 ml    Gs. 245.000      Gs. 24.500/ml     ← elegido
○  125 ml   Gs. 2.450.000    Gs. 19.600/ml     sellado
```

### 8.3 Tarjeta de producto por vertical

Un perfume y un reloj no muestran los mismos atributos. La tarjeta se compone según `product_kind`:

- **Perfume:** marca, nombre, familia olfativa, desde qué precio, disponibilidad de decant.
- **Reloj:** marca, nombre, movimiento, diámetro, precio.

Un componente por vertical, no uno genérico con campos opcionales — es el mismo criterio de segregación de interfaces que aplica el backend a los DTO.

### 8.4 Temporizador de reserva en checkout

`RF-ECO-04` exige que el vencimiento sea visible. No como cuenta regresiva agresiva, sino como información: _"Reservado hasta las 14:35"_. Al vencer, mensaje claro y recuperable, no un error genérico.

### 8.5 Conflicto de stock

Cuando la reserva vence y el ítem ya no está (RN-RES-05), el mensaje explica qué pasó y qué hacer, en la voz de la interfaz. Nunca un código técnico, nunca una disculpa vacía.

### 8.6 Admin: cola de fraccionamiento

La pantalla que más se va a usar. Órdenes pendientes **agrupadas por frasco de origen**, para llenar todos los decants del mismo Layton de una vez en lugar de abrir y cerrar cuatro veces. El campo de merma real es obligatorio y viene precargado con lo esperado, editable.

### 8.7 Admin: recepción con prorrateo

Al cargar flete y despacho, la tabla recalcula el costo puesto y el margen proyectado **en vivo**, antes de confirmar. Es el momento en que se detecta que una compra no cerraba, y hay que verlo antes de contabilizarla, no después.

---

## 9. Formularios

El patrón que más código ahorra en todo el proyecto: **el esquema Zod de `packages/contracts` se usa en el servidor y en el cliente.**

```tsx
import { createProductInput } from "@joda/contracts/catalog";

const form = useForm({
  resolver: zodResolver(createProductInput),
  defaultValues: { kind: "perfume", status: "draft" },
});
```

Una sola definición de la regla. Si el backend agrega un campo obligatorio, el formulario deja de compilar.

Reglas: validación al desenfocar y luego en cada cambio; el botón de envío no se deshabilita mientras hay errores —se deshabilita mientras se envía—; el error aparece junto al campo, no en una lista arriba; los importes se ingresan con formato de miles y se envían como string de unidades menores.

---

## 10. Pruebas de frontend

| Nivel             | Herramienta              | Alcance                                      |
| ----------------- | ------------------------ | -------------------------------------------- |
| Componente        | Vitest + Testing Library | Lógica de composición, no apariencia         |
| Accesibilidad     | `@axe-core/playwright`   | Rutas críticas, bloquea la fusión            |
| Rendimiento       | Lighthouse CI            | Presupuesto de §5.1, bloquea la fusión       |
| Extremo a extremo | Playwright               | Los cinco flujos de la estrategia de pruebas |

**Sin pruebas de instantánea visual.** Producen ruido y terminan actualizándose sin mirar, que es peor que no tenerlas.

---

## 11. Reglas no negociables

- [ ] Componentes de servidor por defecto; `"use client"` lo más abajo posible.
- [ ] Toda imagen con `width` y `height`, o `aspect-ratio`.
- [ ] Tipografías autoalojadas, `display: swap`, dos familias como máximo.
- [ ] Framer Motion fuera del camino crítico del storefront.
- [ ] Formateo de guaraníes, cantidades y fechas solo desde `packages/ui/format`.
- [ ] Los formularios usan los esquemas de `packages/contracts`, nunca una copia.
- [ ] El stock se muestra como estado, nunca como cantidad exacta.
- [ ] Datos estructurados coincidentes con lo que ve el usuario.
- [ ] Facetas combinadas siempre `noindex` con canónica a la ruta base.
- [ ] Presupuesto de rendimiento respetado; excederlo bloquea la fusión.
- [ ] Foco visible, contraste AA, `prefers-reduced-motion` respetado.
- [ ] Ninguna librería de componentes con estilos propios además de shadcn/Radix.
