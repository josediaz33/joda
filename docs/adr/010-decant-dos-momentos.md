# ADR-010 — El decant tiene dos momentos, más BOM y merma en tres componentes

- **Estado:** Aceptada
- **Fecha:** 2026-09-09
- **Ámbito:** Decants

---

## Contexto

Todas las propuestas iniciales trataban el fraccionamiento como un evento único al confirmar la venta, con un porcentaje fijo de merma. Dos problemas: en la realidad el vial se llena después, y ahí se conoce la merma verdadera; y el decant no es solo líquido.

## Decisión

**Dos momentos, unidos por `decant_work_orders`:**

1. **Compromiso comercial** (checkout): se reserva granel e insumos. Nadie tocó una pipeta.
2. **Transformación física** (fulfillment): se llena el vial y se registra la **merma real**.

**BOM (`bom_components`):** un decant de 10 ml consume 10 ml de fragancia + 1 vial + 1 atomizador + 1 etiqueta.

**Merma en tres componentes**, porque son de naturaleza distinta:

| Componente           | Naturaleza         | Campo                 |
| -------------------- | ------------------ | --------------------- |
| Trasvase             | Proporcional       | `waste_factor` (%)    |
| Fondo no recuperable | Fijo por frasco    | `unusable_residue_ml` |
| Evaporación          | Por tiempo abierto | `evaporation_ml_year` |

## Consecuencias

**Positivas.** El margen del decant es real. La vista `v_decant_yield` compara merma esperada contra real por producto y operador. En la validación del esquema la real fue **1,75× la esperada** — con frascos de nicho, eso es plata que hoy no aparece en ningún reporte.

**Negativas.** Un paso operativo más: alguien tiene que cerrar la orden de fraccionamiento declarando la merma. Es información que hoy no se captura y sin la cual el costeo es ficción.

**Riesgo si se ignora.** Modelar solo el porcentaje deja un faltante fantasma de 3–5 ml por frasco, que se termina tapando con ajustes manuales — y esos ajustes son el ruido que hace inauditable un Kardex.
