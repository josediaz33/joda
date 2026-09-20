import type { Clock } from "@joda/domain";

// Implementación real del puerto Clock (docs/engineering-principles.md Parte
// I·D: "packages/domain/ports/clock.ts ◄──implementa── adapters/systemClock.ts").
// Primer uso real: apps/api/src/modules/auth/service.ts (WP-C03) inyecta esto
// en producción y un reloj fijo en los tests.
export const systemClock: Clock = {
  now: () => new Date(),
};
