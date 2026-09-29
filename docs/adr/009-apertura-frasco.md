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

## Aclaración (WP-C11, 2026-09-29)

La decisión no cambia: abrir es una conversión entre lotes. Se precisa qué se convierte cuando el lote sellado tiene más de un frasco (una recepción de tres iguales):

- **Se abre una unidad, siempre.** El granel hereda el costo de UNA unidad del sellado (`unit_landed_cost_pyg`), no el del lote entero.
- **Si `qty_initial` > 1, la apertura separa primero la unidad en su propio lote sellado de una unidad** (`parent_lot_id` = el lote original) y abre ese. El original sigue `available`. Sin la separación, el frasco abierto arrastraba a los demás: un sellado abierto es terminal (RN-LOT-03) y los otros frascos quedaban invendibles.
- La base lo impone: un lote de variante sellada en `open_for_decant` tiene `qty_initial = 1` (`0028_sealed_open_single_unit.sql`).
- **Una apertura errónea no se revierte reabriendo el lote.** Se corrige con dos ajustes con motivo obligatorio: baja del granel y alta de un lote sellado nuevo (caso borde 22).
