# ADR-023 — Stack de frontend y sistema de diseño

- **Estado:** Aceptada
- **Fecha:** 2026-09-10
- **Ámbito:** Frontend

---

## Contexto

ADR-003 decidió Next.js para el storefront y Vite para el admin, pero no definió el stack de interfaz. Sin esa definición, cada módulo termina eligiendo su propia librería de componentes y el sistema pierde coherencia visual — que en un negocio donde la vidriera es la carta de presentación es un costo directo de conversión.

## Decisión

**Base común:** Tailwind CSS v4 con configuración CSS-first (`@theme`), shadcn/ui sobre Radix Primitives, iconos Lucide.

**Reparto en el monorepo:**
- `packages/ui/src/styles/tokens.css` — fuente única de tokens para ambos apps
- `packages/ui/src/primitives/` — shadcn genérico, sin opinión de marca
- `packages/ui/src/format/` — formateo de guaraníes, cantidades y fechas
- `apps/*/src/components/` — composiciones propias de cada app

**Complementos:** react-hook-form con resolver de Zod (reusando `packages/contracts`), TanStack Query y TanStack Table en el admin, componentes de servidor y Server Actions en el storefront, sonner, cmdk, date-fns, Recharts.

**Framer Motion queda restringido:** libre en el admin; en el storefront solo en islas fuera del camino crítico. Las transiciones de página y las micro-interacciones de catálogo se resuelven con CSS y View Transitions.

**Storefront y admin comparten tokens y primitivas, no estética ni densidad.**

## Consecuencias

**Positivas.** shadcn copia código en lugar de instalar un paquete: no hay dependencia pesada, la marca se aplica de verdad y Radix aporta accesibilidad. Reusar los esquemas Zod entre formulario y API elimina la duplicación de reglas de validación, que es una fuente clásica de divergencia.

**Negativas.** shadcn en monorepo requiere configurar `components.json` con el alias correcto; sin eso, cada `npx shadcn add` deposita archivos donde se lo ejecutó y aparecen tres versiones del mismo componente. Y mantener dos estéticas cuesta más que una sola.

**Sobre Framer Motion.** Pesa entre 30 y 50 kB comprimidos y obliga a `"use client"` en App Router. En una página de producto con presupuesto de 180 kB sobre 4G paraguaya, eso es un cuarto del presupuesto gastado en animación, y convierte la grilla de catálogo en componente de cliente. La restricción no es estética: es el presupuesto de rendimiento de la especificación de frontend §5.1.

## Alternativas descartadas

- **MUI, Ant Design, Chakra:** imponen su estética, pesan, y su apariencia es reconocible — lo contrario de lo que necesita una marca.
- **CSS Modules o styled-components:** sin las utilidades de Tailwind el sistema de tokens se dispersa, y styled-components tiene costo en tiempo de ejecución.
- **Un solo sistema visual para storefront y admin:** un ERP que parece una landing es lento de operar; una tienda que parece un ERP no vende.
- **Radix sin shadcn:** habría que escribir desde cero el estilado de cada primitiva, sin ganancia.
