# ADR-005 — CTI más facetas JSONB para el catálogo multicategoría

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Modelo de datos

---

## Contexto

El catálogo debe soportar perfumes y relojes hoy, accesorios mañana, con atributos completamente distintos. Las tres opciones clásicas: EAV, Single Table Inheritance, Class Table Inheritance.

## Decisión

**Class Table Inheritance** (`products` + `{kind}_details`) para los atributos que participan en reglas de negocio, más una columna **`facets jsonb`** indexada con GIN para descubrimiento y filtros del storefront.

La coherencia se impone con FK compuesta: `products` lleva `UNIQUE (id, kind)` y cada tabla de detalle declara `kind` con `CHECK` de valor fijo más `FOREIGN KEY (product_id, kind)`.

## Consecuencias

**Positivas.** Los atributos que el ERP calcula (volumen, concentración, movimiento) tienen tipo, constraint e índice. El storefront filtra sobre un GIN sin joins. Está verificado que la base rechaza cargar `perfume_details` sobre un producto `watch`.

**Negativas.** Agregar una vertical requiere migración. **Esto no es un defecto:** una vertical nueva trae reglas, validaciones, UI, permisos y tests. Es un cambio de software, no un `INSERT`. La idea de que "nunca hacer una migración" sea automáticamente mejor es equivocada.

## Alternativas descartadas

- **EAV puro:** un JOIN por atributo filtrado y cero integridad. `resistencia_al_agua = 'azul'` sería válido. Todo el costeo depende de que `volumen_ml` sea un número. EAV se justifica cuando el usuario final define atributos en runtime; no es el caso.
- **STI puro:** aceptable hasta dos verticales. A la tercera, una tabla con 40 columnas, 70% `NULL`, sin poder declarar `NOT NULL` en nada obligatorio-por-categoría.
- **JSONB puro:** funciona para catálogo, falla para seriales, garantías y cálculos.
