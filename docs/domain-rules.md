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

| Valor      | Resultado                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| 113.636,36 | 113.636                                                                                                  |
| 113.636,50 | 113.637                                                                                                  |
| 113.636,64 | 113.637                                                                                                  |
| −0,5       | 0 (media unidad hacia +infinito — en esta mitad coincide con «hacia el cero», pero no es la misma regla) |

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

Los tres métodos proporcionales (`by_value`, `by_unit`, `by_volume`) reparten con el **mismo algoritmo: el método del mayor resto** (`Money.allocate`, `packages/domain/src/shared/money.ts` — ver `docs/domain-contracts.md` §3.1). Lo único que cambia entre ellos es de dónde sale el peso de cada línea — valor, cantidad o volumen —, nunca el criterio de desempate. Un solo algoritmo de reparto en todo el sistema, ya probado con pruebas de propiedades.

**`by_value`** (predeterminado): cada línea recibe flete en proporción a su valor.

```
flete_línea = round_pyg(flete_total × (valor_línea / valor_total))
```

**Ejemplo.** Flete Gs. 300.000 sobre tres líneas de 1.000.000, 500.000 y 200.000:

```
Línea A: 300.000 × (1.000.000/1.700.000) = 176.471
Línea B: 300.000 × (  500.000/1.700.000) =  88.235
Línea C: 300.000 × (  200.000/1.700.000) =  35.294
Suma = 300.000  →  sin ajuste
```

Este ejemplo **no** distingue el mayor resto de un criterio distinto ("la diferencia va a la línea de mayor valor"): en los dos casos el ajuste termina en la línea A, así que da lo mismo cuál de los dos se use. **Contraejemplo que sí distingue:** dos líneas de peso 60 y 40, flete Gs. 7.

```
Piso:         60 → 4,2 → 4      40 → 2,8 → 2      (suma de pisos = 6, falta 1)
Mayor resto:  resto de A = 0,2  resto de B = 0,8   → el 1 que falta va a B → 4 / 3
Mayor valor:  A es la línea más grande              → el 1 que falta va a A → 5 / 2
```

Este documento usa **mayor resto**: `by_value` sobre 60/40 con flete 7 da `4 / 3`, no `5 / 2`. "Mayor valor" no es otro nombre para el mismo resultado: sesga sistemáticamente el redondeo hacia la línea más cara, recepción tras recepción — quien más paga, más carga. Una versión anterior de esta regla decía "la diferencia de redondeo se imputa a la línea de mayor valor"; fue un atajo al redactar el ejemplo de arriba, donde por casualidad coincidía con el mayor resto, no una decisión meditada. Se corrige acá: no hay caso especial por método, `Money.allocate` decide en los tres, sin sesgo y de forma determinística.

`manual` no prorratea nada: el operador ya fijó el flete de cada línea (`manualAmount`, `docs/domain-contracts.md` §6.4); la función solo valida que la suma coincida con el flete total y falla si no coincide. Ajustar esos montos por detrás volvería poco confiable un costeo que el operador declaró a propósito.

> **¿Por qué RN-IVA-03 sí imputa a una línea fija (la última de la tasa) y esto no es incoherente con lo anterior?** Ahí el redondeo se resuelve a **nivel de documento** (RN-IVA-02) porque es lo que valida el ente fiscal: una regla posicional, trivial de explicar y auditar frente a un contador, importa más que la ausencia de sesgo. El flete no tiene una autoridad externa que exija una posición fija — ahí manda el criterio técnico (mayor resto, sin sesgo), no uno regulatorio. Son dos reglas distintas a propósito, no una inconsistencia entre RN-IVA-03 y RN-COS-02.

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

## RN-SRC — Sourcing (WP-C16)

**Qué decidió José explícitamente, 2026-10-09** (las tres preguntas abiertas de WP-C16, ninguna cubierta hasta ahora en este documento): el margen se calcula neto de IVA, igual que RN-FRA-04 (RN-SRC-02); el arancel se modela ad valorem, cargado como `other` de `LandedCostComponents` (RN-SRC-01); `projected_landed_pyg` y `projected_price_pyg` son por unidad, no el total de la línea (RN-SRC-02).

**Qué quedó como decisión técnica propia, no confirmada palabra por palabra con José** (corrección de la revisión cruzada de WP-C16, §7: una versión anterior de este encabezado las presentaba juntas, sin distinguir): que un precio proyectado inválido es excepción y no `Result` (RN-SRC-02, por el mismo precedente que `fxRateToPyg` en RN-COS-01, `procurement/landedCost.ts`); el redondeo a milésimas del margen (RN-SRC-02); y el criterio de "mejor opción" de `compareScenarioLines` como mayor margen porcentual (RN-SRC-04) — este último sigue sin confirmar y puede no ser el correcto si las líneas comparadas tienen cantidades o precios muy distintos (margen % y ganancia absoluta pueden contradecirse).

### RN-SRC-01 · Costo puesto proyectado de una línea

Un escenario (`sourcing_scenarios`) no recibe `customs_minor` separado como una recepción (RN-COS-01): sus tres supuestos son fx, flete y aranceles (RF-SRC-01). El arancel se modela **ad valorem** — un porcentaje sobre el valor de proveedor de la línea, nunca un monto fijo — porque es como en la práctica se cotiza (una tasa, no una cifra en guaraníes que alguien ya calculó):

```
valor_línea      = unit_price × qty                         (moneda extranjera de la línea)
arancel_línea    = valor_línea × tasa_arancel                (misma moneda; Percentage, rango [0, 1])
flete_línea      = allocateFreight(flete_total, método, líneas)[línea]   (RN-COS-02, sin cambios)
costo_puesto_línea   = computeLandedCost({ supplierPrice: valor_línea, freight: flete_línea, other: arancel_línea }, fx_asumido_línea)
costo_puesto_unitario = computeUnitLandedCost(costo_puesto_línea, qty)
```

Reusa `procurement/landedCost.ts` y `procurement/freight.ts` de WP-A05 sin duplicarlos — `other` ya está documentado ahí para "impuestos, aranceles y comisiones". El flete se prorratea entre TODAS las líneas del escenario con el mismo algoritmo de RN-COS-02 (mayor resto, sin caso especial); el arancel no se prorratea porque ya es proporcional al valor de cada línea por construcción.

**Precondición heredada de WP-A05 (limitación conocida, `GLOSARIO.md` "Flete prorrateado"):** `flete_total` tiene que venir ya expresado en la moneda de las líneas. Si no coincide, `computeLandedCost` lanza `CurrencyMismatchError` al sumar — no hay conversión implícita, igual que en una recepción real.

**Ejemplo verificado.** Una línea de un reloj importado, fx asumido 7.300, arancel 10%:

| Concepto                     | USD        | Gs. (fx 7.300) |
| ---------------------------- | ---------- | -------------- |
| Precio proveedor (qty 1)     | 300,00     | —              |
| Flete asignado a la línea    | 20,00      | —              |
| Arancel (10% de 300,00)      | 30,00      | —              |
| **Costo puesto de la línea** | **350,00** | **2.555.000**  |

Con `qty = 1`, el costo puesto unitario es el mismo: **Gs. 2.555.000/unidad**.

### RN-SRC-02 · Margen proyectado, neto de IVA

`sourcing_scenario_lines` no tiene columna `vat_rate` (a diferencia de `product_variants`): la tasa entra como parámetro de la función de dominio, nunca se persiste en la línea. El margen se calcula **neto de IVA**, con el mismo criterio que el margen del decant (RN-FRA-04, "Precio de venta Gs. 245.000, IVA 22.273 → margen 41,1%") — reusa `tax/vat.ts::taxBase(gross, rate)`, no reimplementa la extracción del IVA:

```
precio_neto_unitario = taxBase(projected_price_pyg, vat_rate)     (RN-IVA-01/04)
margen_pct            = round3((precio_neto_unitario − costo_puesto_unitario) / precio_neto_unitario × 100)
```

`projected_landed_pyg` y `projected_price_pyg` (`sourcing_scenario_lines`) son **por unidad**, no el total de la línea — comparables directamente entre sí y con el precio de catálogo, sin que `qty` distorsione la comparación entre escenarios A/B.

El redondeo a 3 decimales (`round3`, nuevo y exclusivo de este módulo) **no es** `round_pyg`: `round_pyg` redondea guaraníes enteros (RN-DIN-02) y un porcentaje no es un importe en guaraníes. `round3` usa el mismo criterio de desempate — media unidad hacia +infinito — por consistencia con el resto del dominio, no porque la regla de Gs. se extienda a esto.

**Precio o costo que no permite calcular un margen (precio proyectado cero o negativo) es un argumento fuera de rango** (§4.2), no un fallo que el negocio contemple: lanza excepción, igual que un `fxRateToPyg` inválido en RN-COS-01.

**Ejemplo verificado (continúa RN-SRC-01).** Costo puesto unitario Gs. 2.555.000, precio de venta proyectado Gs. 3.500.000 con IVA 10%:

```
IVA           = vatFromGross(3.500.000, iva_10) = round_pyg(3.500.000 / 11) = 318.182
precio_neto   = 3.500.000 − 318.182 = 3.181.818
margen        = (3.181.818 − 2.555.000) / 3.181.818 × 100 ≈ 19,700%
```

### RN-SRC-03 · Alerta de margen bajo umbral configurable

El umbral (RF-SRC-03) es un parámetro de la función de comparación, nunca una constante en el código — no hay columna ni tabla que lo persista todavía (sin fila en el esquema de Bloque B para esto). Se modela como `Percentage` (rango `[0, 1]`, igual que `waste_factor`): nadie configura "alertar por debajo de −10%" o "por encima de 100%", así que el rango de `Percentage` es la restricción correcta, no una coincidencia de tipo.

```
bajo_umbral = margen_pct < round3(umbral.value × 100)
```

El `round3` del umbral **no es cosmético**: `0,07 × 100` da `7.000000000000001` en punto flotante (JavaScript), así que un margen que iguala EXACTAMENTE el umbral (7,000%) daba `belowThreshold = true` sin redondearlo a la misma grilla de milésimas que `marginPct`. Bug encontrado en la revisión cruzada de WP-C16, con test de regresión en `scenario.test.ts`.

**Siguiendo el ejemplo de RN-SRC-02:** con un umbral del 25%, un margen de 19,7% dispara la alerta.

### RN-SRC-04 · Criterio de "mejor opción" al comparar — sin confirmar

**Pendiente, anotado en la revisión cruzada de WP-C16 (§3): esto no fue decisión de José, preguntar antes de dar por buena.** `compareScenarioLines` hoy elige la línea con **mayor margen porcentual** dentro de cada variante. Es razonable como default (comparar tasas, no montos, es el criterio natural cuando las alternativas son del mismo producto bajo distintos supuestos de compra — proveedor A vs. B, GLOSARIO.md), pero margen % y ganancia absoluta por unidad pueden apuntar a líneas distintas si las cantidades o precios proyectados difieren mucho entre alternativas, y hoy no hay ninguna regla que diga cuál gana en ese caso. El desempate entre dos líneas con margen EXACTAMENTE igual es determinístico (gana la primera vista, por orden de entrada), eso sí probado.

**Fuera de alcance de WP-C16 (RF-SRC-04/05, anotado para WP-C16b).** Que un escenario no afecte inventario, caja ni cuentas por pagar es una garantía arquitectónica, no una regla con fórmula: `packages/domain` no tiene I/O, así que ninguna función de este módulo puede escribir en el ledger aunque quisiera (RF-SRC-04). Convertir un escenario en orden de compra (RF-SRC-05) es una escritura — pertenece a `apps/api`, fuera del alcance de `packages/domain` y de este WP; ver la fila de WP-C16b en `docs/backlog.md`.

---

## RN-CAT — Catálogo

### RN-CAT-01 · El BOM solo se define sobre una variante fraccionada

`bom_components.parent_variant_id` tiene que ser una variante `variant_type = 'decant'`. No es un `CHECK` de `packages/db` (`bom_components` no conoce el `variant_type` de la variante que referencia sin un `JOIN`) — lo hace cumplir la API, en `catalog.bom.create`, antes de insertar.

**Por qué.** Un sellado o un granel no consumen insumos propios: el sellado se vende tal cual viene del proveedor, y el granel es el origen que un decant consume vía `source_variant_id` (RN-FRA-07), no un producto con su propio BOM.

**Procedencia.** No es una regla que esta sesión haya confirmado con el dueño del negocio — viene explícita como trampa de la Sesión 28 de `docs/runbooks/prompts-playbook.md` ("El BOM (RF-CAT-07) es de una variante FRACCIONADA — no confundir con las variantes sellado/granel sin BOM") al encargar WP-C08, y no estaba escrita en ningún otro documento hasta esta aclaración. Corregido acá tras la revisión cruzada de WP-C08, que señaló que la redacción anterior ("confirmado... al implementar") sugería una confirmación de negocio que no ocurrió.

**Zona gris sin resolver.** La regla de arriba restringe el `variant_type` del PADRE (`parent_variant_id`), no el del `component_variant_id` — hoy nada impide vincular como insumo, por ejemplo, otra variante `sealed`. Ni RF-CAT-07 ni ningún documento existente declaran una restricción sobre el tipo del componente, así que `catalog.bom.create` (WP-C08) no la valida. Señalado en la revisión cruzada de WP-C08 como algo a preguntar, no a asumir.

### RN-CAT-02 · Solo `sealed`, `decant` y `unit` se publican en la tienda

`product_variants.online_visible` puede ser `true` solo si `variant_type` es `sealed`, `decant` o `unit`. Una variante `tester`, `supply` o `bulk` tiene `online_visible = false`, siempre. Impuesto por la base con un `CHECK` (WP-B17, `0038`); el servicio no lo reimplementa ni lo normaliza.

**Contexto en el glosario.** `GLOSARIO.md` define el granel como «no se vende directo» (es el origen de los decants, RN-FRA-07), el insumo como lo que un BOM consume (RN-CAT-01) y el tester como un frasco de exhibición. Es el contexto de la regla, no una explicación que José haya dado.

**Procedencia.** Regla indicada por José y registrada en el backlog como WP-B17; la lista de tres tipos es suya. Hasta WP-B17 la única defensa era la normalización que WP-E05 metió en `updateVariant` para el granel (apagaba `online_visible` al actualizar una variante `bulk`): cubría un tipo de tres y solo cuando alguien actualizaba esa variante.

**Qué no dice.** No decide cuándo ni quién publica una variante: la visibilidad se administra bajo `catalog.product:publish` (RF-CAT-09, WP-C08g), nunca como campo de edición de la variante. Esta regla es el techo de lo que ese procedimiento puede encender.

---

## RN-LOT — Lotes y apertura de frascos

### RN-LOT-01 · Unidad de medida inmutable

Un lote nace con una unidad de medida (`unit` o `ml`) y **no cambia nunca**.

### RN-LOT-02 · Apertura de frasco

Abrir un frasco sellado para fraccionar es una **conversión entre lotes**, ejecutada en una sola transacción. **Se abre una unidad, siempre**: el granel hereda el costo de **UNA unidad** del sellado — su `unit_landed_cost_pyg`, no su `landed_cost_pyg`, que es el del lote entero.

Sobre un lote sellado de una unidad (`qty_initial = 1`):

```
1. transfer_out  −1 unit    sobre el lote sellado          (con su capa de costo)
2. lote sellado → status = 'open_for_decant', opened_at = now()
3. crear lote de granel:
     variant = <la variante de granel del producto>
     parent_lot_id = <lote sellado>
     qty_initial = nominal_volume_ml
     landed_cost_pyg = <unit_landed_cost_pyg del sellado, íntegro>
     unit_landed_cost_pyg = round_pyg(landed_cost_pyg / nominal_volume_ml)
     unit_cost_minor = round(unit_cost_minor del sellado / nominal_volume_ml), misma moneda de compra
4. transfer_in  +125 ml     sobre el lote de granel
```

**`unit_cost_minor` significa "costo por unidad de medida de este lote"**: por frasco en un sellado, por ml en un granel, el mismo criterio que `unit_landed_cost_pyg`. El granel no hereda el costo del frasco tal cual: lo divide por el volumen nominal, con el mismo redondeo del proyecto (`Money.times`, `money.ts`), así que por el volumen nominal vuelve a dar el costo del frasco dentro del redondeo. **El costo de la mercadería vendida sale SIEMPRE de los campos en guaraníes** (`landed_cost_pyg`, `unit_landed_cost_pyg` y las capas de costo). `unit_cost_minor` es informativo y nunca se usa para calcular costos.

**Precondiciones.** Se rechaza la apertura si:

- **El lote no está en `available`.** Uno en `quarantine` o `damaged` no se puede fraccionar: es mercadería que todavía no pasó control de calidad o que ya se descartó. Confirmado como regla de negocio en la revisión cruzada de WP-A13. Uno ya abierto tampoco (caso borde 5).
- **El lote no tiene un frasco en saldo, o la variante no tiene un frasco disponible.** Disponible es el saldo menos las reservas vivas (RN-RES-03): abrir el último frasco reservado se lo saca al cliente que ya pagó.
- **La variante del lote no es sellada.** Un `tester` es el frasco de exhibición y no se fracciona (regla decidida en la toma de WP-C11, 2026-09-29). Si alguna vez se compran frascos sin caja para decantar, se cargan como variante sellada con su propio SKU.
- **El producto no tiene variante de granel.** Hay que crearla en el catálogo. Un producto tiene **una sola**, impuesto por la base: es un solo líquido aunque se venda en varios tamaños.
- **El producto no tiene volumen nominal.** El granel nace con `nominal_volume_ml` ml (RN-LOT-02, paso 3); sin él, por ejemplo en un producto que no es un perfume, no hay cuántos ml calcular.

**Lote de más de una unidad (caso borde 21).** Si el lote nació con más de una unidad (`qty_initial > 1`: una recepción de tres frascos iguales), la apertura **separa primero** la unidad que se abre en su propio lote de una unidad, y recién abre ese:

```
a. transfer_out  −1 unit    sobre el lote original         (con su capa de costo)
b. crear lote sellado de una unidad:
     variant = <la del lote original>
     parent_lot_id = <lote original>
     landed_cost_pyg = unit_landed_cost_pyg = <unit_landed_cost_pyg del original>
     status = 'available', qty_initial = 1
     lote del fabricante, fabricación, vencimiento y recepción: los del original
c. transfer_in  +1 unit     sobre el lote nuevo
```

Después vienen los pasos 1 a 4, sobre el lote nuevo. El original sigue `available`, con `qty_initial` intacto y un frasco menos en saldo.

**La condición es `qty_initial`, no el saldo.** Un lote de tres con dos ya vendidos tiene saldo 1 y se separa igual. Si se abriera directo, el granel heredaría el costo por ml de TRES frascos y cada decant saldría con el margen equivocado, sin que nada falle. La base lo impone: un lote sellado en `open_for_decant` tiene `qty_initial = 1`.

`parent_lot_id` es el linaje general, "el lote del que se derivó". Se distinguen por el tipo de variante: sellado → sellado es una separación; sellado → granel es una apertura.

### RN-LOT-03 · Frasco abierto no se vende sellado

Un lote **sellado** en `open_for_decant` es **terminal**: no admite ningún movimiento (venta, baja, ajuste, devolución) ni cambia de estado. El granel hijo también está en `open_for_decant`, pero no es sellado: se mueve y se agota normalmente (RN-LOT-04).

Impuesto por la base:

- `assert_sealed_lot_not_open` rechaza el movimiento. Mira la variante del lote, no solo la que declara el movimiento. Hasta la revisión de WP-B09, declarar otra variante eludía la regla. Desde WP-B08c, además, las dos no pueden diferir.
- `trg_sealed_lot_terminal` rechaza sacar el lote de `open_for_decant`. Si no, volverlo a `available` eludía lo anterior y permitía abrir dos veces el mismo frasco (caso borde 5). José confirmó el 2026-09-30 que "terminal" incluye el estado, no solo los movimientos (ver `data-model.md` §4.6, «Lote sellado terminal», y ADR-026).

Hasta WP-B08c solo se rechazaba `sale`; un `waste` o un `adjustment` sacaban frascos sellados de un lote abierto. Decidido por José el 2026-09-25.

- `trg_sealed_open_single_unit` (WP-C11) rechaza que un lote de variante sellada esté en `open_for_decant` con `qty_initial <> 1`. Sin esto, marcar abierto un lote de varios dejaba los otros frascos cerrados, con saldo y sin poder venderse.

La apertura (RN-LOT-02) saca la unidad **antes** de cambiar el estado, así que no choca con esto. En un lote de varios frascos, la unidad que se abre ya está separada en su propio lote de una unidad: ver el caso borde 21.

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

Ante empate, desempata el `id` ascendente.

**El orden de bloqueo es una propiedad de la API, no de la política de consumo.** Cuando una línea de venta necesita más de un lote, la API toma el `SELECT ... FOR UPDATE` de esos lotes siempre en `id` ascendente, para evitar interbloqueos entre pedidos multi-línea concurrentes — sin importar qué política decidió cuánto sale de cada uno: `fifo` consume del más antiguo primero y `fefo` del que vence antes, pero eso solo decide las cantidades, nunca el orden de bloqueo. Por la misma razón, la función de dominio que arma las capas de costo (`allocateFromLots`, RN-COS-04) devuelve el resultado ordenado por `id` ascendente, aunque haya consumido los lotes en otro orden — es lo que la API bloquea, en el mismo orden en que lo recibe.

---

## RN-SER — Unidades serializadas

Un reloj de USD 800 no es "cantidad = 1": lleva número de serie, garantía y su propia trazabilidad de venta. Cada reloj es una fila de `serialized_units`, atada al lote que lo trajo (WP-C12, RF-INV-10).

### RN-SER-01 · El número de serie es único por tenant

`UNIQUE (tenant_id, serial_number)`. Dos tenants pueden tener el mismo número de serie sin chocar entre sí: la unicidad no es global. Impuesto por la base; el servicio no lo reimplementa, solo traduce el rechazo a un error en español.

### RN-SER-02 · Solo una variante serializada lleva unidades

Una unidad se registra contra un lote de una variante con `is_serialized = true`. Registrar una sobre un lote de otra variante (un sellado, un insumo, un granel) se rechaza. Una variante serializada se mide en unidades enteras (`CHECK (NOT is_serialized OR uom = 'unit')`).

**De dónde sale `is_serialized` en un reloj.** No todos los relojes llevan número de serie: `requires_serial` del producto se decide al crear el reloj, sin valor por defecto. Las variantes de un reloj heredan `is_serialized` de él al crearse, no se marcan aparte: `createVariant` lo toma del producto, sea cual sea el tipo de la variante, y rechaza un valor que lo contradiga (WP-E05c). `updateVariant` revalida lo mismo (WP-C08f): un `isSerialized` que contradiga a `requires_serial` del producto se rechaza también al actualizar la variante; mandar el valor que coincide se acepta, y es la forma de reparar una variante anterior a E05c. Lo que **no** se revalida es la otra dirección: cambiar `requires_serial` del producto no reescribe las variantes que ya existen, y qué hacer entonces (rechazar el cambio o propagarlo) está pendiente de José (WP-C08h). Apagarlo con unidades ya registradas es WP-C08d.

### RN-SER-03 · Las unidades registradas de un lote no superan su `qty_initial`

Cuentan **todas** las unidades del lote, incluidas las vendidas, en cuarentena o devueltas: una unidad vendida sigue siendo una de las que el lote trajo. Un lote de tres relojes admite tres unidades en total, no tres "disponibles".

**Tiene una carrera.** Dos altas simultáneas sobre un lote con 2 de 3 ven "2 de 3" y registran la cuarta. Un `CHECK` no lo puede impedir, porque cuenta filas de otra tabla. La API bloquea el lote (`SELECT ... FOR UPDATE`) **antes** de contar, y solo lo cierra si todas las altas del lote pasan por ese bloqueo.

### RN-SER-04 · Una unidad es de la variante de su lote

`serialized_units.variant_id` es el `variant_id` de su `lot_id`. Impuesto por la base con una FK compuesta `(lot_id, variant_id, tenant_id) → inventory_lots (id, variant_id, tenant_id)` (WP-C12, `0029`), el mismo patrón que la variante de un movimiento (WP-B08c). La variante de la unidad la deriva el servidor del lote; nunca se acepta del cliente. Un lote con unidades serializadas no cambia de variante. Una unidad puede existir sin lote (`lot_id` nulo).

Lo mismo vale para `stock_reservations` (lote y unidad serializada de la reserva, de la variante de la reserva): lo hereda WP-C18.

### Cómo se cargan y cómo se venden

- **Se cargan al recibir.** Los seriales se cargan cuando se desempaca cada reloj, al recibir la compra: la recepción de una variante `is_serialized` exige cargar los seriales (WP-C15). El alta suelta (`inventory.serial.create`) es para corregir o completar, y es un ajuste (`inventory.stock:adjust`).
- **Se venden eligiendo la unidad.** `serial` es una política de selección (RN-LOT-05): la unidad se elige explícitamente, no la elige FIFO ni FEFO. Vender una variante serializada exige elegir la unidad (WP-C19), y una línea con `serial_unit_id` mueve exactamente una unidad (RN-VTA-04).

---

## RN-FRA — Fraccionamiento

### RN-FRA-01 · Los dos momentos

| Momento        | Disparador               | Efecto                                                           |
| -------------- | ------------------------ | ---------------------------------------------------------------- |
| **Compromiso** | Confirmación de la venta | Reserva de granel e insumos + orden de fraccionamiento pendiente |
| **Ejecución**  | Alguien llena el vial    | Movimientos definitivos, con merma real                          |

Entre ambos no hay consumo de inventario, solo reserva.

**Qué venta puede planificar** (decisión de José, 2026-10-07; la implementa WP-C19): `inventory.decant.plan` solo acepta ventas en `awaiting_payment` o `paid`; cualquier otro estado se rechaza.

**Una orden por línea de venta** (decisión de José, 2026-10-08; la impone la base con WP-B18): mientras una orden de fraccionamiento no esté cancelada, su línea de venta no admite otra; cancelar permite replanificar. La `Idempotency-Key` de `plan` sigue siendo opcional y solo sirve para reintentos.

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

### RN-FRA-07 · Origen del granel

El lote de origen de un decant debe ser granel real (`variantType = 'bulk'`, `uom = 'ml'`) en estado `open_for_decant`. No alcanza con el `status`: tras la apertura de un frasco (RN-LOT-02, ADR-009), el lote sellado padre comparte ese mismo `open_for_decant` con el granel hijo que recién nace — un `LotSnapshot` del sellado padre se rechaza igual, aunque su `status` sea idéntico al del granel válido.

**Ejemplo.** Sellado padre en `open_for_decant` (`variantType: 'sealed'`, `uom: 'unit'`) → rechazado con `SOURCE_LOT_NOT_DECANTABLE`. Granel hijo en `open_for_decant` (`variantType: 'bulk'`, `uom: 'ml'`) → aceptado.

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

## RN-EST — Máquinas de estado

Tres entidades tienen ciclo de vida propio con salida lateral (`cancelled`, `refunded`): orden de compra, pedido de venta, orden de fraccionamiento. El criterio de fondo es uno solo y gobierna las tres: **se cancela mientras no haya efectos irreversibles; una vez que hay movimientos de inventario o cobro, se revierte, no se cancela.** Las transiciones válidas viven como datos en `packages/domain` (docs/domain-contracts.md §6.5), nunca como `switch` esparcidos por la API.

### RN-EST-01 · Orden de compra

```
draft → pending_approval → approved → sent → partially_received → received
```

Cancelable desde `draft`, `pending_approval`, `approved` y `sent`. **No** desde `partially_received` ni `received`: ya entró mercadería y hay lotes creados a partir de la recepción. Revertir una OC que ya recibió algo es una devolución a proveedor (fuera de alcance de esta máquina), no una cancelación de la orden.

`pending_approval` puede volver a `draft` — rechazo del aprobador para corrección — sin pasar por `cancelled`.

### RN-EST-02 · Pedido de venta

```
draft → awaiting_payment → paid → preparing → ready → shipped → delivered
```

Cancelable **solo** desde `draft` y `awaiting_payment`: son los dos únicos estados donde RN-VTA-02 garantiza que el inventario todavía no se tocó. Desde `paid` en adelante la salida es `refunded`, no `cancelled` — RN-VTA-02 dice que el inventario se consume "al confirmarse el pago", es decir en el mismo momento en que el pedido entra a `paid`, no después; para cuando el pedido está en `paid` ya hubo cobro y ya hubo movimiento de inventario, así que revertirlo es la anulación de RN-VTA-03 (movimientos `return_in`), no una cancelación sin efecto. `refunded` es alcanzable desde `paid`, `preparing`, `ready`, `shipped` y `delivered`.

`cancelled` y `refunded` no son sinónimos con distinto nombre: `cancelled` es "nunca pasó nada", `refunded` es "pasó algo y se revierte" (RN-VTA-03).

### RN-EST-03 · Orden de fraccionamiento

```
pending → in_progress → done
```

Cancelable desde `pending` e `in_progress`. **No** desde `done`: los movimientos de la ejecución (RN-FRA-03) ya están en el ledger y son inmutables (`inventory_movements` es append-only).

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

Impuesto por la base desde WP-B14 (`0020_journal_immutability.sql`), con el mismo mapa en `packages/domain/src/accounting/journalEntry.ts`:

- El asiento **nace en `draft`**, recibe sus líneas y pasa a `posted` en la misma transacción. El cuadre se valida al confirmar (RN-CTB-02).
- Transiciones: `draft → draft` (edición del borrador), `draft → posted` y `posted → reversed`. Esta última solo vale si ya existe un asiento de reversión **contabilizado**, del mismo tenant, que lo referencia por `reverses_id`, y no cambia ninguna otra columna. `reversed` es terminal.
- **Un asiento se revierte una sola vez.** Índice único parcial `journal_entries_single_reversal` sobre `reverses_id` para los asientos que no son borrador (WP-B14b). Dos borradores de reversión pueden convivir; el segundo falla al contabilizarse. Sin esto, dos reversiones contabilizadas sobre-revertían el saldo en `v_trial_balance`.
- `posted` y `reversed` son inmutables: ni el asiento ni sus líneas admiten INSERT, UPDATE o DELETE.
- Un borrador con líneas se borra en dos pasos, **primero las líneas y después el asiento**. Es deliberado: el guard de líneas falla cerrado, y en un borrado en cascada no puede distinguir una línea huérfana de una colgada de un asiento de otro tenant.

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

| #   | Situación                                                                                                                                                 | Comportamiento esperado                                                                                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | El granel no alcanza para el decant completo                                                                                                              | Rechazar la venta antes de reservar. No fraccionar parcialmente.                                                                                                                                                                                                                                                                                                                                   |
| 2   | La merma real supera lo reservado                                                                                                                         | Permitir y consumir lo real. Si el granel no alcanza, la orden falla y queda en `in_progress` para resolución manual.                                                                                                                                                                                                                                                                              |
| 3   | Falta un insumo del BOM                                                                                                                                   | Rechazar la ejecución. La orden sigue en curso (`in_progress`: ya se inició, y la máquina de estados no vuelve a `pending`) y se alerta el faltante.                                                                                                                                                                                                                                               |
| 4   | Un insumo del BOM está marcado `is_optional` y falta                                                                                                      | Ejecutar sin él, registrándolo en el movimiento `decant_consumption` (la orden no tiene columna de nota).                                                                                                                                                                                                                                                                                          |
| 5   | Se abre un frasco que ya estaba abierto                                                                                                                   | Rechazar. Un lote solo se abre una vez.                                                                                                                                                                                                                                                                                                                                                            |
| 6   | Dos ventas simultáneas sobre el último frasco                                                                                                             | La segunda falla al bloquear el lote. Se muestra "ya no disponible", no un error técnico.                                                                                                                                                                                                                                                                                                          |
| 7   | La reserva vence entre el pago y la confirmación                                                                                                          | RN-RES-05: rechazar, reembolsar, cancelar con motivo.                                                                                                                                                                                                                                                                                                                                              |
| 8   | Notificación de pago duplicada                                                                                                                            | Ignorar silenciosamente y devolver el resultado original.                                                                                                                                                                                                                                                                                                                                          |
| 9   | El monto de la notificación no coincide con el pedido                                                                                                     | No confirmar. Registrar y alertar para revisión manual.                                                                                                                                                                                                                                                                                                                                            |
| 10  | Recepción parcial de una orden de compra                                                                                                                  | Generar lote por lo recibido, la orden pasa a `partially_received`.                                                                                                                                                                                                                                                                                                                                |
| 11  | Recepción mayor a lo pedido                                                                                                                               | Rechazar. `qty_received ≤ qty_ordered` es invariante.                                                                                                                                                                                                                                                                                                                                              |
| 12  | El tipo de cambio de la recepción difiere del estimado                                                                                                    | Usar el real. La diferencia se registra como diferencia de cambio.                                                                                                                                                                                                                                                                                                                                 |
| 13  | Devolución de un decant ya fraccionado                                                                                                                    | El líquido no vuelve al granel. Ingresa como lote propio de la variante decant en estado `quarantine`.                                                                                                                                                                                                                                                                                             |
| 14  | Devolución de un reloj serializado                                                                                                                        | La unidad vuelve con su serial y el destino que determine la inspección.                                                                                                                                                                                                                                                                                                                           |
| 15  | Seña aplicada a un pedido que luego se anula                                                                                                              | La aplicación se revierte y la seña vuelve a estar disponible.                                                                                                                                                                                                                                                                                                                                     |
| 16  | Ajuste de inventario que dejaría saldo negativo                                                                                                           | Rechazar. El saldo nunca es negativo.                                                                                                                                                                                                                                                                                                                                                              |
| 17  | Producto sin categoría primaria                                                                                                                           | Rechazar la publicación. El breadcrumb no puede resolverse.                                                                                                                                                                                                                                                                                                                                        |
| 18  | Variante `made_to_order` sin granel de origen                                                                                                             | Rechazar la creación. Impuesto por la base.                                                                                                                                                                                                                                                                                                                                                        |
| 19  | Descuento mayor a `subtotal_pyg + shipping_pyg` (el envío puede compensar un descuento grande; lo que no se compensa es que `total_pyg` termine negativo) | Rechazar. `total_pyg ≥ 0` es invariante.                                                                                                                                                                                                                                                                                                                                                           |
| 20  | Cierre de período con eventos sin postear                                                                                                                 | Advertir y bloquear el cierre hasta resolverlos.                                                                                                                                                                                                                                                                                                                                                   |
| 21  | Se abre un frasco de un lote sellado con `qty_initial` > 1 (una recepción de tres frascos iguales), aunque el saldo sea menor                             | Separar primero la unidad que se abre en su propio lote de una unidad, y abrir ese. El lote original sigue `available` y sus frascos cerrados se siguen vendiendo como sellados. Marcar el lote entero `open_for_decant` los dejaría invendibles (RN-LOT-03).                                                                                                                                      |
| 22  | Se registró una apertura por error (el frasco no se abrió, o se abrió otro)                                                                               | **No se revierte reabriendo el lote**: un sellado abierto es terminal (RN-LOT-03) y los movimientos del ledger no se editan. Se corrige con **dos ajustes**, ambos con motivo obligatorio: uno que da de baja el granel (`adjustment` negativo por su saldo) y otro que da de alta un lote sellado nuevo. Ese alta de lote por ajuste lo construye WP-C11b, que también trae el test de este caso. |
