# ADR-003 — Next.js para storefront, Vite para admin

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Frontend

---

## Contexto

El admin actual es React + Vite y funciona. La pregunta era si el storefront debía compartir ese stack.

## Decisión

**Storefront en Next.js (App Router)**, **admin en React 19 + Vite**, como aplicaciones separadas.

## Consecuencias

**Positivas.**
- Un SPA sirve un `<div id="root">` vacío. La perfumería de nicho compite por búsquedas long-tail ("decant Layton Paraguay"), y ahí el SSR/ISR no es un lujo.
- `next/image` con AVIF importa: las fotos de perfumería son pesadas y el tráfico llega por 4G.
- Open Graph dinámico por producto, que es lo que se ve al compartir por WhatsApp e Instagram — por donde llega el tráfico real.
- **Son dos bundles separados:** el código de contabilidad y sourcing nunca se descarga en el navegador de un cliente. No es la defensa principal (esa es del servidor), pero elimina una clase entera de fuga por inspección de bundle.

**Negativas.** Dos stacks de frontend que mantener. Se mitiga con `packages/ui` compartido y con que el admin no necesita evolucionar de framework.

## Alternativas descartadas

- **Todo en Next.js:** obligaría a reescribir el admin sin ganancia (el SEO le es indiferente).
- **Todo en Vite:** hipoteca el SEO del negocio.
