# ADR-009 — La apertura de frasco es una conversión de lote

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Inventario · Decants

---

## Contexto

Este problema apareció al ejecutar el esquema contra PostgreSQL, no al diseñarlo. Ningún documento previo lo había detectado.

Un frasco sellado es **1 unidad**. Un frasco abierto son **125 mililitros**. Un lote no puede tener dos unidades de medida, y restar mililitros de un lote medido en unidades destruye la trazabilidad del Kardex.

## Decisión

Abrir un frasco es una **conversión entre dos lotes**, no un cambio de estado:

```
lote sellado (unit)                  lote granel (ml)
  transfer_out  −1        ────────►    transfer_in  +125
  status = open_for_decant             parent_lot_id = lote sellado
  1.496.500 Gs.                        11.972 Gs./ml
```

Requiere el tipo de variante `bulk` (granel, medido en ml, no vendible directo) y `inventory_lots.parent_lot_id`.

## Consecuencias

**Positivas.** Cada lote conserva una única unidad de medida. El costo se hereda íntegro y se divide por el volumen nominal para obtener el costo por mililitro. El lote sellado queda en `open_for_decant` y la base impide venderlo como sellado — eso es el "stock comprometido" del módulo de Logística, ahora impuesto por invariante.

**Negativas.** Un producto de perfumería necesita al menos dos variantes de inventario (sellada y granel) aunque comercialmente sea una sola cosa. Es el precio de la corrección.

## Verificado

El intento de vender el sellado desde un lote en `open_for_decant` es rechazado por la base.
