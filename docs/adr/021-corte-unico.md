# ADR-021 — Corte único, sin dual-write

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Migración

---

## Contexto

La migración va de IndexedDB en el navegador de una persona a Postgres en la nube. Una propuesta sugería correr ambos sistemas en paralelo una o dos semanas.

## Decisión

**Corte único.** ETL idempotente con tabla `legacy_map`, reconciliación obligatoria, y cambio de DNS en una sola ventana.

Secuencia: última venta en v2 → export a JSON → ETL → reconciliación → verificación manual de 10 productos y del arqueo de caja → DNS.

## Consecuencias

**Positivas.** El dual-write existe para sistemas con usuarios concurrentes que no pueden parar. Acá se puede cerrar un domingo a la mañana. Sincronizar un navegador offline con una base cloud activa mediante procesos manuales crea divergencias de datos incontrolables, a cambio de nada.

**Rollback trivial:** v2 sigue funcionando en el navegador con su IndexedDB intacta, porque el ETL **solo lee**.

**Negativas.** Unas horas sin operar. Es aceptable.

## Reconciliación bloqueante

El corte no procede si alguna de estas no cierra con tolerancia cero: stock por variante (unidades y mililitros), saldo de caja en guaraníes, señas pendientes, conteos de productos/variantes/proveedores/ventas, imágenes migradas.

## Saldos de apertura

El v2 tiene cantidades, no historial. Por cada producto con stock se genera **un movimiento `adjustment` de apertura** fechado al día del corte. No se inventa historia retroactiva: un asiento de apertura es lo honesto y lo auditable.
