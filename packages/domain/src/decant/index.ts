// Barrel de packages/domain/src/decant/ — fraccionamiento en sus dos
// momentos, la merma en tres componentes, la disponibilidad bajo pedido
// (WP-A07) y la máquina de estados de la orden de fraccionamiento (WP-A08).
// Ver docs/domain-contracts.md §§6.2, 6.5, docs/domain-rules.md RN-FRA,
// RN-EST-03, ADR-009, ADR-010.
export * from "./planning.js";
export * from "./execution.js";
export * from "./waste.js";
export * from "./availability.js";
export * from "./workOrder.js";
