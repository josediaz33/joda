# ADR-014 — Frontera fiscal con puerto y adaptadores

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Fiscal

---

## Contexto

La facturación electrónica en Paraguay avanza por grupos: los grupos 19 a 24 —pequeños contribuyentes— entre junio de 2026 y septiembre de 2027, y quien se inscribió desde 2025 emite de inmediato. Es probable que aplique a JODA dentro del horizonte del proyecto.

Emitir contra SIFEN implica SOAP con firma digital, CDC de 44 dígitos, eventos de cancelación e inutilización, contingencia, KuDE y reintentos.

## Decisión

**No se construye el integrador.** Se define un puerto en `packages/domain/src/ports/fiscal.ts`:

```ts
export interface FiscalProvider {
  issue(doc: FiscalDocumentDraft): Promise<{ cdc: string; status: FiscalStatus }>;
  cancel(cdc: string, reason: string): Promise<void>;
  status(cdc: string): Promise<FiscalStatus>;
}
```

Fase 1: adaptador `manual` — se registra el CDC emitido en e-Kuatia'i. Fase 2: adaptador de un proveedor homologado. El resto del sistema no se entera del cambio.

**`fiscal_documents` es una entidad separada de `sale_orders`.** Una venta genera 0, 1 o N documentos fiscales; una nota de crédito referencia la factura original.

## Consecuencias

**Positivas.** Se puede operar desde el día uno sin integración, y cumplir cuando corresponda sin reescribir ventas. Colapsar venta y factura en una tabla haría que agregar notas de crédito fuera una migración dolorosa.

**Negativas.** Una capa de indirección para algo que al principio se hace a mano.

## Tarea previa bloqueante

**Confirmar el grupo SIFEN del RUC de JODA con el contador.** Determina si esto entra al MVP o después.
