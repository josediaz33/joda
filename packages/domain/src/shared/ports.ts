// Puertos — el tiempo y la aleatoriedad entran por acá, nunca leídos
// directamente (docs/domain-contracts.md §1.1; .claude/rules/domain.md). El
// servicio de la API los inyecta con implementaciones reales; los tests
// inyectan implementaciones fijas. Sin código ejecutable: son solo la forma
// que el dominio espera, la implementación vive en apps/api/src/adapters/.
export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}
