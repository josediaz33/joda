# ADR-017 — Triggers solo para invariantes

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Base de datos

---

## Contexto

Un extremo propone construir el ERP con triggers encadenados (insertar una venta dispara inventario, que dispara contabilidad). El otro extremo prohíbe los triggers salvo columnas generadas. Ambos están equivocados.

## Decisión

> **La base de datos hace cumplir invariantes. La aplicación calcula decisiones.**

**Sí van a la base:** inmutabilidad del ledger y de la auditoría, cuadre de asientos (constraint diferida), cuadre de capas de costo, no-negatividad del stock, coherencia de unidad de medida, `updated_at`, proyección de saldos.

**No van a la base:** qué lote consumir, cómo prorratear un flete, qué asiento generar, cómo calcular un margen, transiciones de máquinas de estado. Todo eso vive en `packages/domain` en TypeScript testeable.

## Consecuencias

**Positivas.** La lógica es visible, testeable y depurable. Los invariantes se cumplen incluso cuando alguien abre `psql` a las dos de la mañana, que es exactamente el escenario para el que existen. El argumento "la API es el único escritor, así que no hace falta" es cierto hasta que deja de serlo.

**Negativas.** Los errores de invariante llegan a la aplicación como excepciones de PostgreSQL y hay que traducirlos a mensajes útiles. Se resuelve con un mapeador de `ERRCODE` en el middleware de errores.

## Excepción anotada

La proyección de `inventory_balances` la mantiene un trigger. No es lógica de negocio: es la materialización de una suma, con el `CHECK` de no-negatividad como invariante real. La alternativa —mantenerla en el servicio— dejaría el invariante a merced de que nadie escriba por fuera.
