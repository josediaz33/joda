---
paths:
  - "packages/domain/**/*.ts"
---

# Reglas de `packages/domain`

Detalle completo: `docs/domain-contracts.md` y `docs/domain-rules.md`.

## Pureza — restricción mecánica, no convención

Prohibido importar: Prisma, cualquier cliente de base, React, Fastify, `fetch`,
`fs`, `path`, `process.env`, `Date`, `Math.random`, `crypto.randomUUID`.

Los datos entran por parámetro. El tiempo y la aleatoriedad entran por puerto
(`Clock`, `IdGenerator`). Una función de este paquete que no corre en un test
sin levantar nada está mal ubicada.

**Nada de `async` en funciones de cálculo.** Si escribiste `async function` en
`inventory/costing.ts`, algo está mal.

## Errores

- Fallo que el negocio contempla (stock insuficiente, transición inválida) → `Result`.
- Bug (sumar monedas distintas, argumento fuera de rango) → excepción, sin capturar.

Regla: si el usuario puede provocarlo con una acción legítima, es `Result`.

## Dinero y cantidades

`Money` y `Quantity`, nunca `number` crudo. Guaraníes en `bigint` de unidades
enteras. El redondeo vive solo en `shared/money.ts`. IVA con impuesto incluido:
10% = total/11, 5% = total/21 — **nunca** `total * 0.10`.

## Cobertura

100% de líneas y ramas en `shared/money`, `shared/quantity`, `tax/vat`,
`inventory/costing`, `inventory/allocation`, `decant/*`, `procurement/freight`,
`accounting/posting`. Cada `describe` referencia su regla: `RN-XXX-nn`.
