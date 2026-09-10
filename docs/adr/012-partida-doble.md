# ADR-012 — Partida doble desde el día uno, con asientos derivados

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Contabilidad

---

## Contexto

Un "historial de caja" no es contabilidad: sin partida doble no hay balance, ni estado de resultados, ni libro IVA. Pero implementar un módulo contable completo antes de que el sistema opere paraliza el proyecto.

## Decisión

**La estructura existe desde el día uno; el motor se enciende por etapas.**

- `chart_of_accounts`, `journal_entries`, `journal_lines` creadas en la migración inicial.
- Invariante `SUM(debe) = SUM(haber)` impuesto por constraint **diferida**, validada al `COMMIT`.
- **Los asientos se derivan, no se cargan a mano.** `posting_rules` guarda plantillas declarativas por evento de negocio.
- Las reglas nacen **apagadas**. Mientras una esté apagada, el evento cae en `unposted_events`: visible, reprocesable, nunca perdido en silencio.
- Un asiento contabilizado no se modifica: se reversa con otro asiento.

## Consecuencias

**Positivas.** Retrofitear un libro mayor sobre un sistema en producción es carísimo; crearlo vacío es barato. Y un ERP que exige saber contabilidad para operar es un ERP que no se usa: el operador confirma una venta, el sistema genera el asiento.

**Negativas.** Tablas que al principio están vacías, y un motor de posteo que hay que construir eventualmente.

## Orden de encendido sugerido

Venta y cobro → compra y pago → inventario y COGS → señas → ajustes y cierre.

## Nota

El plan de cuentas del seed es una base razonable para retail paraguayo. **Debe validarse con el contador** antes de contabilizar en serio.
