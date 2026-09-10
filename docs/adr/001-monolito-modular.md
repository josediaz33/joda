# ADR-001 — Monolito modular, no microservicios

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Arquitectura general

---

## Contexto

El ecosistema cubre catálogo, inventario, ventas, compras, sourcing, contabilidad y facturación. Es tentador separarlo en servicios por módulo, y varias propuestas iniciales lo insinuaron.

El problema es que una sola operación de negocio atraviesa casi todos los módulos. Confirmar una venta de un decant valida disponibilidad, bloquea un lote, consume líquido, registra merma, consume insumos, calcula costo, registra el cobro, aplica una seña y genera un asiento. En microservicios eso es una transacción distribuida con compensaciones.

## Decisión

Un **monolito modular** en `apps/api`: un solo despliegue, una sola base de datos, módulos con fronteras explícitas (`modules/<dominio>/{router,service,repository}.ts`) y transacciones ACID reales.

## Consecuencias

**Positivas.** Las operaciones multi-módulo son una transacción y no una saga. El costo de infraestructura es una fracción. El desarrollo es dramáticamente más rápido.

**Negativas.** No hay escalado independiente por módulo, y un despliegue defectuoso afecta todo. Ambas cosas son irrelevantes al volumen actual y por varios órdenes de magnitud más.

**Mitigación de la deuda futura.** Las fronteras entre módulos se respetan desde ahora: un módulo accede a otro por su servicio, nunca por su repositorio ni por SQL directo a sus tablas. Si algún día hay que extraer uno, la costura ya existe.

## Alternativas descartadas

- **Microservicios por dominio:** transacciones distribuidas sin necesidad.
- **Serverless por endpoint:** cold starts, y el pooling de conexiones a Postgres se vuelve un problema propio.
