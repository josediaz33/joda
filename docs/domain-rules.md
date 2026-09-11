# Reglas de Negocio

Las reglas que definen el dominio, con ejemplos numéricos y casos borde. **Este documento es la fuente de los tests de `packages/domain`.** Cada regla tiene identificador (`RN-XXX-nn`); cada test debe referenciarlo.

Si necesitás una regla que no está acá, **preguntá antes de inventarla**. Una regla inventada que parece razonable es peor que una pregunta.

---

## RN-DIN — Dinero

### RN-DIN-01 · Representación

El guaraní se representa como entero de 64 bits sin decimales. Nunca punto flotante.

```ts
Money.pyg(2_450_000n); // Gs. 2.450.000
```

Las monedas extranjeras se representan en unidades menores: USD 190,00 → `19000n` con `currency: 'USD'`.

### RN-DIN-02 · Redondeo

Media unidad hacia arriba, siempre, en una sola función.

| Valor      | Resultado                                             |
| ---------- | ----------------------------------------------------- |
| 113.636,36 | 113.636                                               |
| 113.636,50 | 113.637                                               |
| 113.636,64 | 113.637                                               |
| −0,5       | 0 (se redondea hacia el cero para importes negativos) |

### RN-DIN-03 · Suma entre monedas

Sumar importes de monedas distintas es un error, no una conversión implícita. Debe fallar en tiempo de compilación cuando el tipo lo permite, y lanzar `CurrencyMismatchError` en runtime cuando no.

### RN-DIN-04 · Conversión y congelamiento

Toda operación en moneda extranjera guarda cuatro valores. `amount_pyg` se calcula **una vez** y no se recalcula jamás.

```
amount_pyg = round_pyg(amount_minor / 100 × fx_rate_to_pyg)
```

**Ejemplo.** USD 190,00 con dólar a 7.300 → `round_pyg(19000 / 100 × 7300)` = **1.387.000 Gs.**

---

## RN-IVA — Impuesto al valor agregado

### RN-IVA-01 · Precio con impuesto incluido

En Paraguay el precio se muestra con IVA incluido. Por lo tanto el impuesto se **extrae**, no se agrega:

| Tasa   | Fórmula      | Ejemplo sobre Gs. 245.000 |
| ------ | ------------ | ------------------------- |
| 10%    | `total / 11` | 22.273                    |
| 5%     | `total / 21` | 11.667                    |
| Exenta | 0            | 0                         |

**Prohibido:** `total * 0.10`.

### RN-IVA-02 · Nivel de redondeo

El redondeo se resuelve a **nivel de documento**, no de línea. Es lo que valida el sistema fiscal.

### RN-IVA-03 · Diferencia de redondeo

Cuando la suma de los IVA de línea no coincide con el IVA del documento, la diferencia se imputa **a la última línea de la tasa correspondiente**, y queda registrada.

**Ejemplo.** Tres líneas de Gs. 100.000 al 10%:

```
IVA por línea:   9.091 × 3 = 27.273
IVA documento:   300.000 / 11 = 27.273
Diferencia:      0  →  sin ajuste
```

**Ejemplo con diferencia.** Tres líneas de Gs. 33.333 al 10%:

```
IVA por línea:   3.030 × 3 = 9.090
IVA documento:   99.999 / 11 = 9.091
Diferencia:      +1  →  la tercera línea pasa a 3.031
```

### RN-IVA-04 · Base gravada

La base gravada de un documento es `total − IVA`, no un cálculo independiente. Esto garantiza que `base + IVA = total` exactamente.

---

## RN-COS — Costeo

### RN-COS-01 · Costo puesto (landed cost)

```
landed_cost_pyg = (precio + flete + despacho + otros) × fx_rate_recepción
```

El tipo de cambio es el **real de la recepción**, no el estimado de la orden de compra.

**Ejemplo completo.** Un frasco de Layton 125 ml:

| Concepto                  | USD        | Gs. (fx 7.300) |
| ------------------------- | ---------- | -------------- |
| Precio proveedor          | 190,00     | 1.387.000      |
| Flete y despacho          | 15,00      | 109.500        |
| **Costo puesto del lote** | **205,00** | **1.496.500**  |

### RN-COS-02 · Prorrateo de flete

Métodos disponibles: `by_value`, `by_unit`, `by_volume`, `manual`. El método usado se persiste en la recepción para que el costo sea reproducible.

**`by_value`** (predeterminado): cada línea recibe flete en proporción a su valor.

```
flete_línea = round_pyg(flete_total × (valor_línea / valor_total))
```

La diferencia de redondeo se imputa a la línea de mayor valor.

**Ejemplo.** Flete Gs. 300.000 sobre tres líneas de 1.000.000, 500.000 y 200.000:

```
Línea A: 300.000 × (1.000.000/1.700.000) = 176.471
Línea B: 300.000 × (  500.000/1.700.000) =  88.235
Línea C: 300.000 × (  200.000/1.700.000) =  35.294
Suma = 300.000  →  sin ajuste
```

### RN-COS-03 · Costo unitario

```
unit_landed_cost_pyg = round_pyg(landed_cost_pyg / qty_initial)
```

**Ejemplo.** El frasco anterior convertido a granel: `1.496.500 / 125 ml` = **11.972 Gs./ml**.

### RN-COS-04 · Consumo FIFO por capas

Una salida consume lotes en orden de recepción hasta cubrir la cantidad. **Cada capa se registra por separado.**

**Ejemplo.** Venta de 3 unidades con dos lotes disponibles:

| Lote                | Disponible | Costo unitario | Consumido | Costo         |
| ------------------- | ---------- | -------------- | --------- | ------------- |
| L-001 (más antiguo) | 2          | 1.400.000      | 2         | 2.800.000     |
| L-002               | 5          | 1.550.000      | 1         | 1.550.000     |
| **Total**           |            |                | **3**     | **4.350.000** |

Se generan dos filas en `movement_cost_allocations`. El COGS de la venta es 4.350.000, no `3 × promedio`.

### RN-COS-05 · Invariante de costo

`SUM(total_cost_pyg)` de las asignaciones de un movimiento debe igualar `ABS(total_cost_pyg)` del movimiento. Verificado por constraint diferida.

---

## RN-LOT — Lotes y apertura de frascos

### RN-LOT-01 · Unidad de medida inmutable

Un lote nace con una unidad de medida (`unit` o `ml`) y **no cambia nunca**.

### RN-LOT-02 · Apertura de frasco

Abrir un frasco sellado para fraccionar es una **conversión entre dos lotes**, ejecutada en una sola transacción:

```
1. transfer_out  −1 unit    sobre el lote sellado
2. lote sellado → status = 'open_for_decant', opened_at = now()
3. crear lote de granel:
     variant = <granel del producto>
     parent_lot_id = <lote sellado>
     qty_initial = nominal_volume_ml
     landed_cost_pyg = <heredado íntegro>
     unit_landed_cost_pyg = round_pyg(landed_cost_pyg / nominal_volume_ml)
4. transfer_in  +125 ml     sobre el lote de granel
```

### RN-LOT-03 · Frasco abierto no se vende sellado

Un lote en `open_for_decant` no admite movimientos de tipo `sale` sobre la variante sellada. Impuesto por la base.

### RN-LOT-04 · Agotamiento de frasco

Cuando el saldo del granel llega o baja del `unusable_residue_ml` del producto, el lote se marca `depleted` y el residuo se da de baja como `waste` con motivo `fondo no recuperable`.

**Ejemplo.** Producto con `unusable_residue_ml = 2,5`. El granel queda en 2,3 ml → se genera `waste −2,3` y el lote pasa a `depleted`.

### RN-LOT-05 · Selección de lote

Según `allocation_policy` de la variante:

| Política | Criterio                                                    |
| -------- | ----------------------------------------------------------- |
| `fifo`   | Menor `received_at` con saldo disponible                    |
| `fefo`   | Menor `expiry_at` no nulo; los sin vencimiento van al final |
| `serial` | Se elige la unidad serializada explícitamente               |
| `manual` | El operador elige el lote                                   |

Ante empate, desempata el `id` ascendente. **El orden de bloqueo siempre es `lot_id` ascendente**, para evitar interbloqueos en pedidos multi-línea.

---

## RN-FRA — Fraccionamiento

### RN-FRA-01 · Los dos momentos

| Momento        | Disparador               | Efecto                                                           |
| -------------- | ------------------------ | ---------------------------------------------------------------- |
| **Compromiso** | Confirmación de la venta | Reserva de granel e insumos + orden de fraccionamiento pendiente |
| **Ejecución**  | Alguien llena el vial    | Movimientos definitivos, con merma real                          |

Entre ambos no hay consumo de inventario, solo reserva.

### RN-FRA-02 · Cálculo de la reserva

```
ml_expected    = qty_units × ml_per_unit
waste_expected = round(ml_expected × waste_factor, 3)
ml_reservado   = ml_expected + waste_expected
```

**Ejemplo.** 1 decant de 10 ml con `waste_factor = 0,02`:

```
ml_expected    = 10,000
waste_expected =  0,200
ml_reservado   = 10,200
```

Además se reservan los insumos del BOM: 1 vial, 1 atomizador, 1 etiqueta.

### RN-FRA-03 · Ejecución

En una sola transacción:

```
decant_consumption  −ml_expected      del lote de granel
waste               −waste_actual     del lote de granel
bom_consumption     −qty_per_unit     por cada componente del BOM
liberar la reserva
```

`waste_actual` es obligatorio. Sin él la orden no puede pasar a `done`.

### RN-FRA-04 · Costo del decant

```
costo_líquido = round_pyg(ml_expected   × unit_landed_cost_granel)
costo_merma   = round_pyg(waste_actual  × unit_landed_cost_granel)
costo_insumos = Σ round_pyg(qty × unit_landed_cost_insumo)
COGS          = costo_líquido + costo_merma + costo_insumos
```

**Ejemplo verificado.** Decant de 10 ml de Layton, granel a 11.972 Gs./ml, merma real 0,35 ml:

| Concepto   | Cálculo         | Gs.         |
| ---------- | --------------- | ----------- |
| Líquido    | 10,000 × 11.972 | 119.720     |
| Merma      | 0,350 × 11.972  | 4.190       |
| Vial       | 1 × 4.500       | 4.500       |
| Atomizador | 1 × 2.500       | 2.500       |
| Etiqueta   | 1 × 300         | 300         |
| **COGS**   |                 | **131.210** |

Precio de venta Gs. 245.000, IVA 22.273 → **margen 41,1%**. Contando solo el líquido el margen aparente sería 45,3%: cuatro puntos de diferencia.

### RN-FRA-05 · Merma en tres componentes

| Componente           | Naturaleza              | Cuándo se aplica              |
| -------------------- | ----------------------- | ----------------------------- |
| Trasvase             | Proporcional al volumen | En cada fraccionamiento       |
| Fondo no recuperable | Fijo por frasco         | Al agotar el lote (RN-LOT-04) |
| Evaporación          | Por tiempo abierto      | Ajuste periódico programado   |

Modelar solo el primero deja un faltante de 3–5 ml por frasco que se termina tapando con ajustes manuales.

### RN-FRA-06 · Disponibilidad de una variante bajo pedido

```
por_líquido = piso( granel_disponible / (ml_per_unit × (1 + waste_factor)) )
por_insumos = mín( disponible(componente) / qty_per_unit )  para cada componente
disponible  = mín(por_líquido, por_insumos)
```

**Ejemplo.** Granel 114,65 ml, decant de 10 ml al 2%, 99 viales, 99 atomizadores, 199 etiquetas:

```
por_líquido = piso(114,65 / 10,2) = 11
por_insumos = mín(99, 99, 199)    = 99
disponible  = 11
```

---

## RN-RES — Reservas

### RN-RES-01 · El carrito no reserva

Agregar al carrito no aparta inventario. La disponibilidad se muestra, no se bloquea.

### RN-RES-02 · Duración por medio de pago

| Momento / medio               | TTL                                      |
| ----------------------------- | ---------------------------------------- |
| Inicio de checkout            | 15 min                                   |
| Tarjeta, pago pendiente       | 30 min                                   |
| Transferencia bancaria        | 48 h                                     |
| Seña recibida                 | Hasta la fecha de vencimiento de la seña |
| Retención manual del personal | Definida por el operador, máximo 30 días |

### RN-RES-03 · Disponible

```
disponible = saldo_proyectado − Σ reservas con released_at IS NULL y expires_at > now()
```

### RN-RES-04 · Liberación

Un trabajo programado libera las reservas vencidas cada 5 minutos. Una reserva liberada no se reactiva: se crea una nueva.

### RN-RES-05 · Conflicto en checkout

Si al confirmar el pago la reserva venció y el stock ya no alcanza, la operación se rechaza, el pago se reembolsa y el pedido queda en `cancelled` con motivo `stock_no_disponible`. **Nunca se confirma una venta sin stock.**

---

## RN-VTA — Ventas

### RN-VTA-01 · Consistencia del total

```
total_pyg = subtotal_pyg − discount_pyg + shipping_pyg
```

Impuesto por la base.

### RN-VTA-02 · Consumo de inventario

El inventario se consume **al confirmarse el pago**, no al crear el pedido. Un pedido en `draft` o `awaiting_payment` no afecta el libro de inventario, solo las reservas.

### RN-VTA-03 · Anulación

Anular una venta genera movimientos de reversión (`return_in`) hacia los mismos lotes de origen, con el mismo costo. **Nunca se editan los movimientos originales.**

### RN-VTA-04 · Venta de unidad serializada

Una línea con `serial_unit_id` mueve exactamente 1 unidad. Al confirmarse, la unidad pasa a `sold` y queda vinculada a la línea de venta.

### RN-VTA-05 · Pedido mixto

Un pedido puede combinar decants (bajo pedido), sellados (con lote) y relojes (serializados). Cada línea sigue su propia lógica de consumo; la transacción es una sola.

---

## RN-SEN — Señas

### RN-SEN-01 · Naturaleza

La seña es un **pasivo**. Acredita `2.1.02.001 Señas de clientes`. No es ingreso hasta aplicarse a una venta.

### RN-SEN-02 · Límite

```
applied_pyg + refunded_pyg ≤ amount_pyg
```

Impuesto por la base.

### RN-SEN-03 · Aplicación parcial

Una seña puede aplicarse a varios pedidos, y un pedido puede recibir varias señas. Cada aplicación es una fila propia con su monto.

**Ejemplo.** Seña de Gs. 500.000 aplicada a un pedido de Gs. 800.000:

```
Aplicación:  500.000 → saldo pendiente del pedido: 300.000
Seña:        applied_pyg = 500.000, disponible = 0
```

### RN-SEN-04 · Vencimiento

Una seña con `expires_at` vencida y saldo sin aplicar **no se cancela automáticamente**: aparece en un reporte para decisión humana. El tratamiento (devolución, aplicación forzada, reconocimiento como ingreso) es una decisión de negocio y contable, no del sistema.

---

## RN-CTB — Contabilidad

### RN-CTB-01 · Los asientos se derivan

El operador confirma un hecho de negocio; el motor de posteo genera el asiento a partir de la plantilla del evento. **No hay carga manual de asientos en la operación diaria.**

### RN-CTB-02 · Cuadre

`SUM(debe) = SUM(haber)` por asiento. Validado al confirmar la transacción, no antes: las líneas se insertan de a una.

### RN-CTB-03 · Asiento de venta confirmada

**Ejemplo.** Venta de Gs. 245.000 con IVA 10% cobrada con tarjeta:

| Cuenta                            | Debe    | Haber   |
| --------------------------------- | ------- | ------- |
| 1.1.01.020 Pasarela por acreditar | 245.000 |         |
| 4.1.01.001 Ventas de perfumería   |         | 222.727 |
| 2.1.03.001 IVA débito fiscal 10%  |         | 22.273  |

Y el asiento de costo, separado:

| Cuenta                                 | Debe    | Haber   |
| -------------------------------------- | ------- | ------- |
| 5.1.01.001 Costo de mercadería vendida | 131.210 |         |
| 1.1.03.001 Mercaderías — perfumería    |         | 131.210 |

### RN-CTB-04 · Asiento de seña

| Cuenta                       | Debe    | Haber   |
| ---------------------------- | ------- | ------- |
| 1.1.01.001 Caja en guaraníes | 500.000 |         |
| 2.1.02.001 Señas de clientes |         | 500.000 |

### RN-CTB-05 · Regla inactiva

Si la regla de posteo del evento está apagada o falla, el evento se registra en `unposted_events` con su motivo. **Nunca se descarta en silencio.**

### RN-CTB-06 · Reversión

Un asiento contabilizado no se modifica. Se genera un asiento inverso que lo referencia por `reverses_id`.

---

## RN-FIS — Documentos fiscales

### RN-FIS-01 · Cardinalidad

Una venta genera 0, 1 o N documentos fiscales. Una nota de crédito referencia obligatoriamente el documento que rectifica.

### RN-FIS-02 · Consistencia del documento

```
total_pyg = taxed_10_pyg + taxed_5_pyg + exempt_pyg
```

Donde cada `taxed_*` es la base gravada, y los `vat_*` se derivan por RN-IVA-01.

### RN-FIS-03 · Documento aprobado

Un documento en estado `approved` tiene siempre código de control. Impuesto por la base.

---

## Catálogo de casos borde

Comportamiento esperado ante situaciones que no son el camino feliz. **Cada uno debe tener un test.**

| #   | Situación                                              | Comportamiento esperado                                                                                               |
| --- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 1   | El granel no alcanza para el decant completo           | Rechazar la venta antes de reservar. No fraccionar parcialmente.                                                      |
| 2   | La merma real supera lo reservado                      | Permitir y consumir lo real. Si el granel no alcanza, la orden falla y queda en `in_progress` para resolución manual. |
| 3   | Falta un insumo del BOM                                | Rechazar la ejecución. La orden queda pendiente y se alerta el faltante.                                              |
| 4   | Un insumo del BOM está marcado `is_optional` y falta   | Ejecutar sin él, registrándolo en la nota de la orden.                                                                |
| 5   | Se abre un frasco que ya estaba abierto                | Rechazar. Un lote solo se abre una vez.                                                                               |
| 6   | Dos ventas simultáneas sobre el último frasco          | La segunda falla al bloquear el lote. Se muestra "ya no disponible", no un error técnico.                             |
| 7   | La reserva vence entre el pago y la confirmación       | RN-RES-05: rechazar, reembolsar, cancelar con motivo.                                                                 |
| 8   | Notificación de pago duplicada                         | Ignorar silenciosamente y devolver el resultado original.                                                             |
| 9   | El monto de la notificación no coincide con el pedido  | No confirmar. Registrar y alertar para revisión manual.                                                               |
| 10  | Recepción parcial de una orden de compra               | Generar lote por lo recibido, la orden pasa a `partially_received`.                                                   |
| 11  | Recepción mayor a lo pedido                            | Rechazar. `qty_received ≤ qty_ordered` es invariante.                                                                 |
| 12  | El tipo de cambio de la recepción difiere del estimado | Usar el real. La diferencia se registra como diferencia de cambio.                                                    |
| 13  | Devolución de un decant ya fraccionado                 | El líquido no vuelve al granel. Ingresa como lote propio de la variante decant en estado `quarantine`.                |
| 14  | Devolución de un reloj serializado                     | La unidad vuelve con su serial y el destino que determine la inspección.                                              |
| 15  | Seña aplicada a un pedido que luego se anula           | La aplicación se revierte y la seña vuelve a estar disponible.                                                        |
| 16  | Ajuste de inventario que dejaría saldo negativo        | Rechazar. El saldo nunca es negativo.                                                                                 |
| 17  | Producto sin categoría primaria                        | Rechazar la publicación. El breadcrumb no puede resolverse.                                                           |
| 18  | Variante `made_to_order` sin granel de origen          | Rechazar la creación. Impuesto por la base.                                                                           |
| 19  | Venta con descuento mayor al subtotal                  | Rechazar. `total_pyg ≥ 0` es invariante.                                                                              |
| 20  | Cierre de período con eventos sin postear              | Advertir y bloquear el cierre hasta resolverlos.                                                                      |
