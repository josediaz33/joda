# ADR-022 — tenant_id desde el día uno

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Modelo de datos

---

## Contexto

Hoy hay un solo negocio: JODA. La estrategia de mediano plazo incluye usar el ERP como pieza de portafolio para conseguir clientes de sistemas a medida, y eventualmente venderlo como producto.

## Decisión

**`tenant_id` en toda tabla, desde la primera migración**, con políticas RLS de aislamiento generadas para cada una.

## Consecuencias

**Positivas.** Agregar multi-tenancy después obliga a tocar todas las tablas, todas las consultas y todos los índices, sobre un sistema en producción con datos reales. Hacerlo ahora cuesta una columna y un `WHERE` que el RLS impone solo.

**Negativas.** Una columna que hoy tiene un único valor, y un índice compuesto donde bastaba uno simple. El costo es despreciable.

## Alcance actual

**Esto no convierte el sistema en multi-tenant.** No hay onboarding de terceros, ni aislamiento operativo probado, ni facturación por tenant, ni límites de recursos. Es solamente la preparación del modelo de datos para que esa evolución no requiera una segunda reescritura.

## Regla para agentes

Toda tabla nueva lleva `tenant_id uuid NOT NULL REFERENCES tenants(id)` y entra en el bucle de políticas RLS. Sin excepciones.
