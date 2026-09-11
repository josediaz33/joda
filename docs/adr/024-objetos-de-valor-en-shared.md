# ADR-024 — Los objetos de valor de dinero y cantidad viven en packages/domain/src/shared/

- **Estado:** Aceptada
- **Fecha:** 2026-09-11
- **Ámbito:** Estructura de packages/domain
- **Relacionado:** ADR-011 (corrige una referencia de ruta; no reabre la decisión)

---

## Contexto

ADR-011 fija la ruta `packages/domain/src/money.ts` para el redondeo de
guaraníes, y `CLAUDE.md` § Dinero repite esa ruta literal. Al mismo
tiempo, `docs/domain-contracts.md` §2 (mapa de módulos) ubica `money.ts`
dentro de `packages/domain/src/shared/`, junto a `quantity.ts`,
`result.ts` y `errors.ts`; y `docs/engineering-principles.md` Parte III
cataloga el patrón "Objeto de valor" (`Money`, `Quantity`, `Percentage`)
con el mismo destino: `packages/domain/src/shared/`.

Los tres documentos nacieron en el mismo commit inicial de scaffolding
(`ebcdfff`, 2026-09-10) — no es que uno haya quedado desactualizado
respecto del otro con el tiempo. Es una inconsistencia que vino pegada
desde el origen y que WP-A03 dejó expuesta al implementarse por primera
vez.

## Decisión

`money.ts` vive en `packages/domain/src/shared/money.ts`, junto con
`quantity.ts`, `percentage.ts`, `result.ts` y `errors.ts`. Estos cinco
archivos son una sola unidad cohesiva —los objetos de valor y la
jerarquía de errores del dominio— que se importan entre sí, se testean
como conjunto, y correspondieron al mismo paquete de trabajo (WP-A03).

## Consecuencias

**Positivas.** Los cinco archivos quedan donde el mapa de módulos y el
catálogo de patrones ya los describían — ninguno de los dos necesita
reabrirse. Un futuro `ports.ts` (Clock, IdGenerator, ya previsto en el
mismo `shared/` del mapa de módulos) completa el mismo directorio sin
fricción.

**Negativas.** Ninguna nueva — es la ruta que ya describían dos de los
tres documentos originales.

## Alternativas descartadas

- **Mover money.ts a `packages/domain/src/money.ts`, dejar el resto en `shared/`.**
  Fragmenta un conjunto cohesivo sin ninguna razón de diseño — la ruta
  del ADR nunca contempló que hubiera un `shared/` con otros tres
  archivos hermanos.
- **Sacar los cinco archivos de `shared/` a `packages/domain/src/` directo.**
  Contradice tanto el mapa de módulos (§2) como el catálogo de patrones
  (Parte III) sin necesidad — ninguno de los dos tiene un error que
  corregir, solo ADR-011/CLAUDE.md lo tienen.
