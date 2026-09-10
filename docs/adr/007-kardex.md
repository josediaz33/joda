# ADR-007 — Kardex append-only; el saldo es proyección

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Inventario

---

## Contexto

El ERP v2 mantiene cantidades en columnas y las actualiza. Funciona para un usuario, y es indefendible en cuanto hay concurrencia, decants o auditoría: no permite responder "¿por qué este frasco tiene 63,5 ml y no 70?" seis meses después.

## Decisión

**`inventory_movements` es la fuente de verdad y es append-only e inmutable.** El saldo (`inventory_balances`) es una proyección derivada, mantenida en la misma transacción, con `CHECK (on_hand >= 0)` como invariante.

Ni la API tiene privilegio de `UPDATE` o `DELETE` sobre el ledger. Corregir un error es insertar un movimiento de ajuste.

## Consecuencias

**Positivas.** Trazabilidad total. Una sobreventa se convierte en una excepción de base de datos en el momento, no en un número rojo descubierto tres meses después. La vista `v_balance_drift` permite verificar la proyección contra el ledger; si devuelve filas, algo se escribió por fuera del flujo.

**Negativas.** Más escrituras por operación y una proyección que mantener. La reconstrucción completa del saldo desde el ledger es cara si el historial crece mucho, pero se hace solo en verificación nocturna.

## Nota de implementación crítica

No se puede usar `INSERT ... ON CONFLICT DO UPDATE SET on_hand = on_hand + excluded.on_hand`: PostgreSQL evalúa los `CHECK` de la fila propuesta **antes** de detectar el conflicto por índice único, así que la primera salida aborta. La fila de saldo nace en cero junto con el lote y la proyección es siempre un `UPDATE` puro. Beneficio adicional: elimina la carrera entre movimientos concurrentes.

## Alternativas descartadas

- **Columna de stock mutable:** no auditable, no permite costeo real.
- **Event sourcing completo:** el ledger ya da lo que hace falta sin el aparato de proyecciones y replay.
