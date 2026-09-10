---
paths:
  - "apps/storefront/**"
  - "apps/admin/**"
  - "packages/ui/**"
---

# Reglas de frontend

Detalle completo: `docs/frontend-spec.md`, ADR-023, ADR-003.

## Rendimiento

Componentes de servidor por defecto en el storefront; `"use client"` lo más
abajo posible del árbol. Toda imagen con `width` y `height` o `aspect-ratio`.
Tipografías autoalojadas con `display: swap`, dos familias como máximo.
Lucide se importa por nombre, nunca el barrel.

**Framer Motion fuera del camino crítico del storefront**: pesa 30–50 kB y
fuerza `"use client"`. En el admin, libre.

El presupuesto de JavaScript por ruta bloquea la fusión igual que un test.

## Formateo y formularios

Guaraníes, cantidades y fechas **solo** desde `packages/ui/format`. Ningún
`toLocaleString` suelto.

Los formularios usan los esquemas Zod de `packages/contracts`, nunca una copia.

## Dominio

El stock se muestra como **estado** (Disponible / Últimas unidades / Agotado),
nunca como cantidad exacta. El selector de variante de perfumes muestra precio
por mililitro. Una tarjeta por vertical, no una genérica con campos opcionales.

## Diseño

Storefront y admin comparten tokens y primitivas, **no estética ni densidad**.

No produzcas los defaults genéricos: fondo crema con serif de alto contraste y
acento terracota; negro con acento verde ácido; el kit de tarjetas SaaS con el
mismo radio y sombra en todo; versalitas espaciadas encima de cada título.
Lista completa en `frontend-spec.md` §3.3.

## Accesibilidad

Contraste AA, foco visible siempre, navegación por teclado, errores de formulario
asociados con `aria-describedby`, `prefers-reduced-motion` respetado.
