# ADR-006 — Taxonomía de cuatro niveles

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Modelo de datos

---

## Contexto

Los primeros diseños confundían "tipo de producto" con "categoría del menú". Son cosas distintas y mezclarlas produce un catálogo que no se puede navegar ni un dominio que se pueda razonar.

## Decisión

Cuatro niveles separados:

| Nivel                         | Qué es                          | Dónde vive                                        |
| ----------------------------- | ------------------------------- | ------------------------------------------------- |
| **Vertical** (`product_kind`) | Clasificación de comportamiento | Enum + `{kind}_details`                           |
| **Categoría comercial**       | Navegación, breadcrumbs, SEO    | `categories` (árbol) + `product_categories` (N:N) |
| **Atributo**                  | Propiedad del producto          | Columna tipada o faceta                           |
| **Tag**                       | Marca transversal de marketing  | `tags` + `product_tags`                           |

## Consecuencias

**Positivas.** Un decant de Layton puede estar en "Perfumes de Nicho" y en "Decants" a la vez, llevar el tag "Best Seller", y seguir siendo un `perfume` a efectos de reglas. La relación N:N con una categoría marcada como primaria resuelve el breadcrumb sin ambigüedad.

**Negativas.** Más tablas y más pantallas de administración que con una sola categoría por producto. Es el costo mínimo de un catálogo real.

## Nota de implementación

`product_categories` lleva un índice único parcial que garantiza **exactamente una** categoría primaria por producto.
