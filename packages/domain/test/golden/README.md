# Dataset dorado

WP-A10. Referencia completa: `docs/domain-contracts.md` §8.1, `docs/testing-strategy.md` §5, `GLOSARIO.md` ("Dataset dorado"), la nota sobre A10 debajo de la tabla del bloque A en `docs/backlog.md`.

## Las dos reglas que no se negocian acá

**Un valor esperado nunca se actualiza para hacer pasar un test, y nunca se genera ejecutando el código que se quiere probar.** Si el dataset lo genera el mismo código que va a probar, los tests miden contra sí mismos y no protegen nada. Cambiar un valor esperado ya commiteado requiere justificación explícita en el PR (`.claude/rules/testing.md`).

**Todo caso declara de dónde salió su `expected` en el campo `origen` (`case.ts`), sin término medio:**

- `"ejemplo trabajado de domain-rules.md, NO una operación real"` — el número ya estaba redactado en `docs/domain-rules.md` al escribir la regla (el caso Layton del decant, el FIFO de dos capas, el IVA de las tres líneas de 33.333...). Sirve para detectar que un refactor cambió un cálculo. **No confirma que el cálculo coincide con cómo opera JODA** — el ejemplo se redactó al escribir la documentación, no se tomó de una venta o compra real.
- `"operación real"` — sale del export del ERP v2 (WP-D01) o de una planilla de costos de José, con el valor esperado calculado a mano por él. Es la única procedencia que de verdad confirma el costeo contra la operación histórica. **WP-A10b** (`docs/backlog.md`) es el paquete que suma estos casos; ningún caso puede declarar `"operación real"` con un número que salió de correr `packages/domain` — el agente que lo intente está rompiendo el propósito del dataset, no ayudando.

## Formato de un caso

Dos archivos por caso, mismo nombre:

```
test/golden/
├── 01-compra-usd-con-flete.json
├── 01-compra-usd-con-flete.test.ts
├── 02-apertura-frasco.json
├── 02-apertura-frasco.test.ts
├── registry.test.ts   ← verifica la convención de todos los casos, no una regla de negocio
└── case.ts             ← tipo GoldenCaseFile / GoldenCaseOrigin
```

El `.json` (dato, sin lógica):

```json
{
  "id": "01-compra-usd-con-flete",
  "regla": "RN-COS-01",
  "origen": "ejemplo trabajado de domain-rules.md, NO una operación real",
  "nota": "Frasco de Layton 125 ml, USD 190 + 15 de flete y despacho, dólar 7.300 — docs/domain-rules.md RN-COS-01.",
  "input": { "...": "..." },
  "expected": { "...": "..." }
}
```

- `id` = nombre de archivo sin `.json`.
- `regla` = el identificador `RN-XXX-nn` que el caso ejercita (`docs/domain-rules.md`).
- `origen` = una de las dos cadenas de arriba, exactas — `registry.test.ts` rechaza cualquier otro valor.
- `nota` = de dónde salió el número — qué sección de `domain-rules.md`, o qué operación real y qué fecha. Es la cita de origen que pide el criterio de aceptación del WP; `registry.test.ts` solo comprueba que no esté vacía, no que sea cierta.
- `input`/`expected` = valores JSON-planos (strings para los montos en guaraníes/bigint, números para `Quantity`/`Percentage`) — el `.test.ts` hermano los convierte a `Money`/`Quantity` reales antes de llamar a la función de dominio.

El `.test.ts` (ejecuta, sin lógica propia — construye y compara, no calcula):

```ts
import { describe, expect, it } from "vitest";
import { Money } from "../../src/shared/money.js";
import { computeLandedCost } from "../../src/procurement/landedCost.js";
import caseData from "./01-compra-usd-con-flete.json" with { type: "json" };

describe(`${caseData.regla} · dataset dorado (${caseData.origen}) · ${caseData.id}`, () => {
  it(caseData.nota, () => {
    const result = computeLandedCost({/* construir el input real a partir de caseData.input */});

    expect(result.minor).toBe(BigInt(caseData.expected.landedCostMinor));
  });
});
```

`registry.test.ts` no ejecuta las funciones de dominio: solo valida que cada `.json` tenga su `.test.ts` hermano, que `id` coincida con el nombre de archivo, que `origen` sea una de las dos cadenas válidas, y que `regla`/`nota` no estén vacías. La regla de negocio la verifica el `.test.ts` de cada caso, citando su propio `regla` en el `describe` — igual que cualquier otro test de `packages/domain` (`.claude/rules/testing.md`).

## Estado

**Sembrados con `"ejemplo trabajado de domain-rules.md"` (WP-A10, esta sesión):** los cinco cálculos con número ya verificado en `docs/domain-rules.md` — costo puesto + costo unitario del frasco de Layton (RN-COS-01/03), prorrateo de flete por `by_value` (RN-COS-02), FIFO de dos capas (RN-COS-04), IVA con diferencia de redondeo (RN-IVA-03) y COGS del decant, caso Layton (RN-FRA-04).

**Pendientes de `"operación real"` (WP-A10b, depende de A10 y de D01):** al menos diez casos con el valor esperado calculado a mano por José a partir del export del ERP v2 o de sus planillas de costos — apertura de frasco, venta mixta, seña parcial, recepción parcial, devolución, y los que José vaya sumando. La lista sugerida por `docs/testing-strategy.md` §5 no está cerrada.

Cada caso nuevo entra en su propio PR o junto con los que José vaya confirmando en la misma sesión — no todos de una vez si no están todos confirmados.
