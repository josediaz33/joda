# ADR-013 — La seña es un pasivo, no un ingreso

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Contabilidad · Ventas

---

## Contexto

El ERP v2 registra señas dentro del historial de caja, junto a las ventas. Contablemente eso es incorrecto y prácticamente es peligroso.

## Decisión

`customer_deposits` acredita **`2.1.02.001 Señas de clientes`**, una cuenta de pasivo. La aplicación a un pedido es un hecho separado (`customer_deposit_applications`) que debita el pasivo.

Un `CHECK` impide que `applied_pyg + refunded_pyg` supere `amount_pyg`.

## Consecuencias

**Positivas.** El resultado del período no se infla con plata que todavía se debe. Devolver una seña deja de ser un ajuste manual descuadrante. Se puede responder "cuánto debo en señas" con una consulta.

**Negativas.** Dos pasos donde antes había uno.

## Nota

El tratamiento fiscal exacto de la seña (si genera obligación de facturar al recibirla) depende del hecho económico y debe consultarse con el contador. La arquitectura permite ambos tratamientos; lo que no permite es asumir que `seña = venta`.
