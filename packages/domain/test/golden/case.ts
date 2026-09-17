// Forma del archivo .json de un caso del dataset dorado — ver
// docs/domain-contracts.md §8.1 y docs/testing-strategy.md §5. `input` y
// `expected` quedan `unknown` acá a propósito: cada caso los tipa contra la
// función real que ejecuta en su propio `<id>.test.ts` (RN-FRA-04,
// RN-COS-01, etc. no comparten forma de entrada/salida entre sí).
export interface GoldenCaseFile {
  readonly id: string;
  readonly regla: string;
  readonly nota: string;
  readonly input: unknown;
  readonly expected: unknown;
}
