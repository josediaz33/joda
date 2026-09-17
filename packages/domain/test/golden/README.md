# Dataset dorado

WP-A10. Referencia completa: `docs/domain-contracts.md` §8.1, `docs/testing-strategy.md` §5, `GLOSARIO.md` ("Dataset dorado"), la nota sobre A10 debajo de la tabla del bloque A en `docs/backlog.md`.

## La regla que no se negocia acá

**Los valores esperados salen de la operación real del v2 — planillas de costos, ventas históricas —, nunca del código nuevo de `packages/domain`.** Si el dataset lo genera el mismo código que va a probar, los tests miden contra sí mismos y no protegen nada. Los pone José. Un agente que complete un `expected` por su cuenta porque "el cálculo cierra" está rompiendo el propósito del dataset, no ayudando.

Cambiar un valor esperado ya commiteado requiere justificación explícita en el PR (`.claude/rules/testing.md`) — nunca se ajusta para "hacer pasar el test".

## Formato de un caso

Dos archivos por caso, mismo nombre:

```
test/golden/
├── 01-compra-usd-con-flete.json
├── 01-compra-usd-con-flete.test.ts
├── 02-apertura-frasco.json
├── 02-apertura-frasco.test.ts
├── registry.test.ts   ← verifica la convención de todos los casos, no una regla de negocio
└── case.ts             ← tipo GoldenCaseFile
```

El `.json` (dato, sin lógica):

```json
{
  "id": "01-compra-usd-con-flete",
  "regla": "RN-COS-01",
  "nota": "Orden de compra #___ del v2, recepción del <fecha>. Verificado contra planilla de costos de <mes>.",
  "input": { "...": "..." },
  "expected": { "...": "..." }
}
```

- `id` = nombre de archivo sin `.json`.
- `regla` = el identificador `RN-XXX-nn` que el caso ejercita (`docs/domain-rules.md`).
- `nota` = de dónde salió el número — qué operación real, qué fecha, contra qué se verificó. Es la cita de origen que pide el criterio de aceptación del WP; `registry.test.ts` solo comprueba que no esté vacía, no que sea cierta.
- `input`/`expected` = valores JSON-planos (strings para los montos en guaraníes/bigint, números para `Quantity`/`Percentage`) — el `.test.ts` hermano los convierte a `Money`/`Quantity` reales antes de llamar a la función de dominio.

El `.test.ts` (ejecuta, sin lógica propia — construye y compara, no calcula):

```ts
import { describe, expect, it } from "vitest";
import { Money } from "../../src/shared/money.js";
import { computeLandedCost } from "../../src/procurement/landedCost.js";
import caseData from "./01-compra-usd-con-flete.json" with { type: "json" };

describe(`${caseData.regla} · dataset dorado · ${caseData.id}`, () => {
  it(caseData.nota, () => {
    const result = computeLandedCost({/* construir el input real a partir de caseData.input */});

    expect(result.minor).toBe(BigInt(caseData.expected.landedCostMinor));
  });
});
```

`registry.test.ts` no ejecuta las funciones de dominio: solo valida que cada `.json` tenga su `.test.ts` hermano, que `id` coincida con el nombre de archivo, y que `regla`/`nota` no estén vacías. La regla de negocio la verifica el `.test.ts` de cada caso, citando su propio `regla` en el `describe` — igual que cualquier otro test de `packages/domain` (`.claude/rules/testing.md`).

## Qué falta

Veinte casos reales, confirmados por José. La lista sugerida por `docs/testing-strategy.md` §5 (no cerrada, se puede ajustar):

1. Compra en USD con flete prorrateado
2. Apertura de frasco (conversión sellado → granel)
3. Fraccionamiento de 10 ml
4. Venta de un decant
5. Venta mixta (decant + reloj)
6. Venta con seña parcial
7. Recepción parcial de una orden de compra
8. FIFO de dos capas de costo
9. Devolución de un reloj
10. IVA con diferencia de redondeo entre líneas

... hasta veinte. Cada caso nuevo entra en su propio PR o junto con los que José vaya confirmando en la misma sesión — no todos de una vez si no están todos confirmados.
