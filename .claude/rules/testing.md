---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.spec.ts"
  - "e2e/**"
  - "packages/db/tests/**"
---

# Reglas de pruebas

Detalle completo: `docs/testing-strategy.md`.

- Cada `describe` referencia la regla que verifica: `RN-XXX-nn`. Sin referencia,
  el test es una afirmación sin fundamento.
- Excepción: código que no encarna una regla de negocio, solo una convención
  mecánica o definicional, cita la sección del documento que la define en vez
  de inventar un `RN-XXX-nn` que no existe — ver `docs/testing-strategy.md`
  §2.2. Dos casos concretos, no los únicos posibles: los objetos de valor de
  `packages/domain/src/shared/` (Money, Quantity, Percentage, Result, errors)
  citan `docs/domain-contracts.md`; los esquemas de frontera de
  `packages/contracts` (dinero como string, ids, paginación — WP-A11) citan
  `docs/api-conventions.md`/`docs/data-model.md`.
- **Sin lógica en los tests.** Sin `if`, sin bucles calculando el esperado. El
  valor esperado se escribe literal.
- Nombres que describen comportamiento, no la función.
- Determinismo: reloj y generador de identificadores inyectados. Nada de
  `new Date()` ni `Math.random()` en el código bajo prueba.
- Constructores con valores por defecto; sobrescribir solo lo relevante.
- Corrección de bug: **test que falla antes del arreglo y pasa después.**
- Refactor sin cambio de comportamiento: los tests existentes pasan **sin
  modificarse**. Si hay que tocarlos, o no era un refactor, o probaban la
  implementación.
- Integración con Postgres real vía Testcontainers, nunca simulacros de Prisma:
  los invariantes viven en la base.
- El dataset dorado no se actualiza para "hacer pasar el test". Cambiar un valor
  esperado requiere justificación explícita en el PR.
- Sin pruebas de instantánea visual.
