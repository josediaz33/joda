# ADR-019 — La reserva de stock nace en el checkout, no en el carrito

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Ventas · Inventario

---

## Contexto

El diseño inicial reservaba stock al agregar un producto al carrito, con TTL de 15 minutos.

Con inventario de piezas únicas —un frasco descontinuado, un reloj— eso permite que cualquiera bloquee el catálogo entero abriendo pestañas. Un bot lo hace sin esfuerzo.

## Decisión

Escalera de compromiso creciente:

1. **Carrito:** no reserva. La disponibilidad se muestra, no se aparta.
2. **Inicio de checkout:** reserva corta.
3. **Pago pendiente:** reserva con TTL según medio de pago (tarjeta corto, transferencia SIPAP más largo).
4. **Pago confirmado:** consumo definitivo en el ledger.

`stock_reservations` vive separada del ledger, con `expires_at` y `released_at`. Un job libera las vencidas.

## Consecuencias

**Positivas.** El inventario no se puede bloquear sin intención de compra. La duración se ajusta al medio de pago en vez de ser un número mágico.

**Negativas.** Existe una ventana en la que dos personas con el mismo ítem en el carrito llegan al checkout y una pierde. Es el comportamiento correcto para piezas únicas, y se comunica en la UI ("último disponible").

## Concurrencia

En la confirmación se bloquea con `SELECT ... FOR UPDATE` **en orden ascendente de `lot_id`**. El orden determinístico es obligatorio: sin él, dos pedidos multi-línea que tocan los mismos lotes en orden distinto producen deadlock.
