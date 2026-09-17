// Barrel de packages/domain/src/sales/ — máquina de estados y totales
// (order.ts, WP-A08/WP-A09), TTL de reserva (reservation.ts, WP-A09) y
// señas (deposit.ts, WP-A09). "Precio por canal" (pricing.ts) queda fuera,
// sin WP asignado todavía: ver la nota al tope de order.ts sobre por qué
// WP-A09 no lo incluyó.
export * from "./deposit.js";
export * from "./order.js";
export * from "./reservation.js";
