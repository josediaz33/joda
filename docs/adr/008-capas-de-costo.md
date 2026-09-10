# ADR-008 — Capas de costo explícitas

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Inventario · Contabilidad

---

## Contexto

Guardar un `unit_cost` en el movimiento de salida parece suficiente. No lo es: una venta de tres unidades puede consumir dos lotes con costos distintos, y bajo FIFO eso es lo normal, no la excepción.

## Decisión

Cada movimiento de salida registra en **`movement_cost_allocations`** qué lote y qué cantidad consumió, a qué costo unitario. Una constraint diferida verifica que la suma de las asignaciones iguale el costo declarado del movimiento.

## Consecuencias

**Positivas.** El COGS es exacto, no aproximado. El saldo valorizado del inventario cierra contra la cuenta contable de existencias — que es lo que hace posible la partida doble de ADR-012. Permite reconstruir el margen real de cualquier venta pasada.

**Negativas.** Una tabla más y filas adicionales por operación.

## Invariante testeable

`SUM(total_cost_pyg)` de las asignaciones de un movimiento = `ABS(total_cost_pyg)` del movimiento. Y el saldo valorizado del inventario = saldo de la cuenta de existencias. Si esa igualdad se rompe, algo se escribió por fuera del flujo.
