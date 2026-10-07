// Valores por defecto de las columnas de detalle y de variantes (WP-E05a). El
// formulario del admin los precarga: si los inventa o los deja en cero, cada
// perfume nace sin merma ni decantable.
//
// Cada valor es el DEFAULT efectivo de su columna después de todas las
// migraciones (sobre todo 0003_catalog.sql y 0035_business_defaults_decisions.sql).
// El test de paridad apps/api/src/modules/catalog/businessDefaultsParity.integration.test.ts
// compara ambos y falla si uno cambia sin el otro.
//
// Todos los valores de acá los confirmó José (decisiones sobre #90, 2026-10-07).
//
// No van acá:
// - Columnas que no tienen sentido de negocio: `kind` (discriminador de la CTI),
//   `position` (orden de presentación), los arreglos de notas (`'{}'`) y las
//   marcas de tiempo.
// - `requires_serial` de watch_details: la respuesta del negocio es "depende"
//   (no todos los relojes llevan número de serie), así que no hay valor por
//   defecto ni acá ni en la base: se decide al crear el reloj. Con `true`, un
//   reloj sin serie se traba al recibirlo; con `false`, uno con serie entra sin
//   registrarla, en silencio. El test de paridad verifica que la columna no
//   tenga DEFAULT.
// - `is_serialized` de product_variants: la variante de un reloj lo hereda de
//   `requires_serial` del producto al crearse, en el servicio de catálogo
//   (WP-E05c), no se precarga.
// - `allocation_policy` de product_variants: depende de la vertical y la regla
//   que la liga a la serie no está decidida. Ver WP-E05d en docs/backlog.md.
//
import type { ProductionMode, VatRate } from "./catalog.js";

// Merma en tres componentes (RN-FRA-05, ADR-010) y atributos de fraccionamiento.
export const PERFUME_DEFAULTS = {
  isDecantable: true,
  // Trasvase: proporcional al volumen, como fracción (0,05 = 5 %), no como
  // porcentaje. José pierde entre 0,3 y 0,5 ml por decant de 10 ml (3 a 5 %) y se
  // toma el extremo alto: el factor reserva líquido (RN-FRA-02, RN-FRA-06), el
  // costo sale de la merma real de cada orden (RN-FRA-04), y es preferible
  // reservar de más que prometer un decant que no alcance. Matiz: la merma real
  // se precarga con la esperada, que sale de este factor (docs/frontend-spec.md
  // §8.6); si el operador acepta la precarga, el costo también depende de él.
  // Los 0,02 de docs/domain-rules.md y del dataset dorado son el dato explícito
  // de un ejemplo, no este valor.
  wasteFactor: 0.05,
  // Fondo no recuperable por frasco, en ml (RN-LOT-04, por producto).
  unusableResidueMl: 2,
  // Evaporación por año abierto. Queda en 0 hasta que se defina la fórmula
  // (WP-A14, docs/backlog.md): cualquier otro número sería inventado.
  evaporationMlYear: 0,
} as const;

// Garantía.
export const WATCH_DEFAULTS = {
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
