# ADR-020 — Checkout hospedado y webhooks idempotentes

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Pagos

---

## Contexto

Stripe no opera con cuentas domiciliadas en Paraguay. Las opciones locales son Bancard vPOS, Pagopar como agregador, y transferencia SIPAP.

Dos riesgos que ningún documento previo había cubierto: el alcance PCI y el reintento de webhooks.

## Decisión

**1. El número de tarjeta nunca toca el sistema.** Checkout hospedado o iframe del proveedor. Se guardan `card_last4` y `card_brand`, que no son datos de tarjeta bajo PCI. Lista negra de campos en el logger (`card`, `cvv`, `token`, `authorization`).

**2. Los webhooks son idempotentes por esquema:**

```sql
CREATE TABLE payment_events (
  provider          text NOT NULL,
  external_event_id text NOT NULL,
  ...
  UNIQUE (provider, external_event_id)
);
```

El handler hace `INSERT ... ON CONFLICT DO NOTHING`; si no insertó, devuelve el resultado guardado y responde 200 sin reprocesar.

**3. El webhook no es fuente de verdad del monto.** Se confirma contra la API del proveedor antes de dar la venta por pagada.

## Consecuencias

**Positivas.** La diferencia entre SAQ A y SAQ D es la diferencia entre completar un formulario y una auditoría anual. Y sin la restricción de unicidad, un reintento de Bancard confirma dos veces la misma venta y descuenta el stock dos veces — verificado que la base lo rechaza.

**Negativas.** Menos control sobre la estética del checkout. Es un precio pequeño.

## Extensión

El mismo mecanismo cubre las mutaciones offline del admin, con header `Idempotency-Key` generado en el cliente.
