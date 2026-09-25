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

## Segunda excepción anotada (WP-B14, 2026-09-25)

`trg_journal_entry_guard` (`0020_journal_immutability.sql`) gobierna las transiciones de `journal_entries.status`: `draft → posted → reversed`, con `reversed` terminal. A primera vista es una máquina de estados en la base, que esta decisión excluye.

Se acepta porque ese mapa **es** la inmutabilidad del libro contable, que esta decisión sí manda a la base. "Un asiento contabilizado no se modifica" (RN-CTB-06) no se puede imponer sin impedir que `posted` vuelva a `draft`. Si no, cualquiera con `accounting.journal:write` reabre el asiento, lo edita y lo vuelve a contabilizar sin rastro.

Lo que sigue fuera de la base es lo que decide:

- qué asiento generar;
- cuándo contabilizarlo;
- cuándo revertirlo y con qué líneas.

El mismo mapa vive en `packages/domain/src/accounting/journalEntry.ts`, y la aplicación lo consulta antes de intentar la transición.

**El criterio para una tercera excepción es el mismo:** la transición se impone en la base solo si permitirla rompe un invariante de inmutabilidad. Que sea "una regla importante" no alcanza.

## Tercera excepción anotada (WP-B08c, 2026-09-25)

`trg_sealed_lot_terminal` (`0023_cross_tenant_fks.sql`) impide que un lote **sellado** salga de `open_for_decant`. Es una transición impuesta en la base.

Pasa el criterio de arriba porque es inmutabilidad física, no una regla importante: un frasco abierto no se desabre. Si se permitiera, alcanzaría un UPDATE del estado a `available` para:

- vender como sellado un frasco abierto (RN-LOT-03);
- abrir dos veces el mismo frasco (caso borde 5).

El granel hijo, que también está en `open_for_decant`, no queda alcanzado: sigue a `depleted` (RN-LOT-04).

Lo que sigue fuera de la base: cuándo abrir un frasco, cuál, y cómo separar la unidad de un lote de varios (caso borde 21, WP-C11).
