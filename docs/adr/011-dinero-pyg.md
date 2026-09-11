# ADR-011 — Guaraníes en bigint, FX con snapshot

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Dinero
- **Corrección (2026-09-11):** la Decisión cita `packages/domain/src/money.ts`; la ruta correcta es `packages/domain/src/shared/money.ts`, junto con `quantity.ts`, `percentage.ts`, `result.ts` y `errors.ts` (ya así en `docs/domain-contracts.md` §2 y `docs/engineering-principles.md` Parte III desde el commit inicial). No cambia ninguna otra parte de esta decisión — bigint, snapshot de FX, redondeo único e IVA siguen intactos. Argumento completo en ADR-024.

---

## Contexto

El guaraní no tiene subdivisión operativa. Las compras son en dólares o reales, y el tipo de cambio se mueve.

## Decisión

- **PYG:** `bigint` de unidades enteras. Dominio `pyg` en la base para documentar la intención.
- **Moneda extranjera:** cuatro campos por transacción — `amount_minor` (bigint), `currency`, `fx_rate_to_pyg`, `amount_pyg`.
- `amount_pyg` es un **snapshot** tomado al momento de la transacción, nunca un cálculo en vivo.
- El redondeo vive en una sola función: `app.round_pyg()` y su espejo en `packages/domain/src/money.ts`.
- **IVA paraguayo sobre precio con impuesto incluido:** 10% = total/11, 5% = total/21.

## Consecuencias

**Positivas.** Cero errores de punto flotante. El historial de caja no se reescribe cuando se mueve el dólar. La regla de IVA y la de redondeo existen en un único lugar, que es la única forma de que el XML de SIFEN no se rechace por descuadre de unidades.

**Negativas.** Hay que convertir en los bordes (entrada de usuario, respuesta JSON). Se resuelve con un tipo `Money` en `packages/domain` que hace que sumar guaraníes con dólares sea un error de compilación, no un bug de producción.

## Prohibiciones

`float`, `numeric(x,2)` para PYG, `number` de JavaScript para acumular importes, `Math.round` sobre dinero fuera de `money.ts`, y `total * 0.10` para IVA.
