// Valores por defecto de las columnas de detalle y de variantes (WP-E05a). El
// formulario del admin los precarga: si los inventa o los deja en cero, cada
// perfume nace sin merma ni decantable y cada reloj sin número de serie.
//
// Cada valor es el DEFAULT efectivo de su columna después de todas las
// migraciones (sobre todo packages/db/migrations/0003_catalog.sql). El test de
// paridad apps/api/src/modules/catalog/businessDefaultsParity.integration.test.ts
// compara ambos y falla si uno cambia sin el otro.
//
// Un valor sin fuente de negocio está marcado "pendiente de confirmar con José":
// hoy es el DEFAULT de la migración, no una decisión documentada.
//
import type { ProductionMode, VatRate } from "./catalog.js";

// No van acá:
// - Columnas que no tienen sentido de negocio: `kind` (discriminador de la CTI),
//   `position` (orden de presentación), los arreglos de notas (`'{}'`) y las
//   marcas de tiempo.
// - `allocation_policy` e `is_serialized` de product_variants: dependen de la
//   vertical (un reloj con serie no es FIFO ni tiene las mismas reglas que un
//   perfume) y la regla que los liga no está escrita en ningún documento. Ver
//   WP-E05c en docs/backlog.md.

// Merma en tres componentes (RN-FRA-05, ADR-010) y atributos de fraccionamiento.
export const PERFUME_DEFAULTS = {
  isDecantable: true,
  // Trasvase: proporcional al volumen, como fracción (0,02 = 2 %). El escenario
  // de validación de docs/architecture/JODA_Arquitectura_v5_Final.md (nota
  // sobre el decant de 10 ml) usa 2 %.
  wasteFactor: 0.02,
  // Fondo no recuperable por frasco, en ml. RN-LOT-04 lo usa por producto y no
  // fija un número: pendiente de confirmar con José.
  unusableResidueMl: 2,
  // Evaporación por año abierto. Cero no es una decisión de negocio: la fórmula
  // no está definida (WP-A14, docs/backlog.md). Pendiente.
  evaporationMlYear: 0,
} as const;

// Serie y garantía.
export const WATCH_DEFAULTS = {
  // RN-SER: un reloj lleva número de serie (docs/domain-rules.md, RN-SER).
  requiresSerial: true,
  // Ningún documento fija un plazo de garantía: pendiente de confirmar con José.
  warrantyMonths: 12,
} as const;

// Política de la variante que no depende de la vertical.
export const VARIANT_DEFAULTS = {
  // Tasa general de IVA, sobre precio con impuesto incluido.
  vatRate: "iva_10" satisfies VatRate,
  productionMode: "stocked" satisfies ProductionMode,
  // Una variante nueva no se publica sola en la tienda.
  onlineVisible: false,
} as const;
