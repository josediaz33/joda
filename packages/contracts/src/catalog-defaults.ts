// Valores por defecto de negocio de las columnas de detalle y de variantes
// (WP-E05a). El formulario del admin los precarga: si los inventa o los deja
// en cero, cada perfume nace sin merma ni decantable y cada reloj sin número
// de serie.
//
// Cada valor es el DEFAULT de su columna en
// packages/db/migrations/0003_catalog.sql. El test de paridad
// apps/api/src/modules/catalog/businessDefaultsParity.integration.test.ts
// compara ambos contra una base migrada: si uno cambia sin el otro, falla en CI.
//
// Columnas que NO van acá: `kind` (discriminador de la CTI), `position` (orden
// de presentación), los arreglos de notas (`'{}'`) y las marcas de tiempo.

// Merma en tres componentes (RN-FRA-05, ADR-010) y atributos de fraccionamiento.
export const PERFUME_DEFAULTS = {
  isDecantable: true,
  // Trasvase: proporcional al volumen, 2 %.
  wasteFactor: 0.02,
  // Fondo no recuperable por frasco, en ml (RN-LOT-04).
  unusableResidueMl: 2,
  // Evaporación por año abierto. Placeholder: la fórmula todavía no está
  // definida (WP-A14, docs/backlog.md). Cero significa "no se aplica".
  evaporationMlYear: 0,
} as const;

// Serie y garantía (RN-SER intro).
export const WATCH_DEFAULTS = {
  requiresSerial: true,
  warrantyMonths: 12,
} as const;

// Política de la variante, sea cual sea su vertical.
export const VARIANT_DEFAULTS = {
  // Tasa general de IVA, sobre precio con impuesto incluido.
  vatRate: "iva_10",
  // Selección de lote por antigüedad (RN-LOT-05).
  allocationPolicy: "fifo",
  productionMode: "stocked",
  // Default de la columna. Un reloj con número de serie necesita `true`: el
  // formulario lo decide por vertical, no lo deja pasar en silencio.
  isSerialized: false,
  // Una variante nueva no se publica sola en la tienda.
  onlineVisible: false,
} as const;
