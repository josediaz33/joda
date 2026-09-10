---
paths:
  - "packages/contracts/**/*.ts"
---

# Reglas de `packages/contracts`

Detalle completo: `docs/api-conventions.md` §3 y §7.

Es la **única fuente de verdad de tipos** entre API, storefront y admin.

- Todo esquema lleva `.strict()`: rechaza campos no declarados y evita
  asignación masiva.
- Los importes viajan como **string**, no como número: `"245000"`. Un `bigint`
  no sobrevive a `JSON.stringify` y un `number` grande pierde precisión.
- Los DTO públicos y administrativos son **esquemas distintos**, no el mismo con
  campos opcionales. Costos, proveedores, márgenes y cantidades exactas de stock
  jamás salen en un esquema público.
- Cada DTO público lleva un test que verifica que no filtra las claves
  prohibidas: `cost`, `landed`, `supplier`, `margin`, `fx_rate`.
