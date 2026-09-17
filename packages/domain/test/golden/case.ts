// Forma del archivo .json de un caso del dataset dorado — ver
// docs/domain-contracts.md §8.1 y docs/testing-strategy.md §5. `input` y
// `expected` quedan `unknown` acá a propósito: cada caso los tipa contra la
// función real que ejecuta en su propio `<id>.test.ts` (RN-FRA-04,
// RN-COS-01, etc. no comparten forma de entrada/salida entre sí).
//
// `origen` distingue las dos procedencias posibles de un `expected` — la
// decisión de José al tomar WP-A10 (ver la sesión de esa fecha, y WP-A10b
// en docs/backlog.md):
//   - un ejemplo YA REDACTADO en docs/domain-rules.md al escribir la regla,
//     sirve para detectar que un refactor cambió un cálculo, pero sus
//     números no salieron de una venta ni una compra real;
//   - una OPERACIÓN REAL del ERP v2 (WP-D01) o de una planilla de costos de
//     José, con el valor esperado calculado a mano por él. Es la única que
//     de verdad confirma que el cálculo coincide con cómo opera JODA.
// Ningún caso puede declarar "operación real" con un valor que salió de
// correr packages/domain — eso es exactamente lo que el dataset dorado
// existe para no hacer.
export type GoldenCaseOrigin =
  "ejemplo trabajado de domain-rules.md, NO una operación real" | "operación real";

export interface GoldenCaseFile {
  readonly id: string;
  readonly regla: string;
  readonly origen: GoldenCaseOrigin;
  readonly nota: string;
  readonly input: unknown;
  readonly expected: unknown;
}
