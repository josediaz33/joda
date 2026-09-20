# Estrategia de Pruebas

Qué se prueba, con qué herramienta, y qué se le exige a cada PR.

**Principio:** este sistema mueve inventario y dinero real. Un bug de costeo no se manifiesta como una pantalla rota, sino como un margen equivocado que nadie nota durante seis meses. Los tests están para eso, no para el porcentaje.

---

## 1. Los cinco niveles

| Nivel                     | Qué cubre                                                                       | Herramienta             | Velocidad |
| ------------------------- | ------------------------------------------------------------------------------- | ----------------------- | --------- |
| **1 · Dominio**           | Reglas puras: costeo, fraccionamiento, merma, IVA, redondeo, máquinas de estado | Vitest                  | ms        |
| **2 · Integración**       | Transacciones, constraints, triggers, RLS                                       | Vitest + Testcontainers | segundos  |
| **3 · Invariantes**       | Cada guarda de la base rechaza lo que debe                                      | psql sobre base efímera | segundos  |
| **4 · Dataset dorado**    | Operaciones reales del negocio con resultados verificados a mano                | Vitest                  | ms        |
| **5 · Extremo a extremo** | Flujos críticos completos en navegador                                          | Playwright              | minutos   |

La pirámide se apoya en el nivel 1. Si te encontrás escribiendo un test de extremo a extremo para verificar un cálculo, la lógica está en el lugar equivocado.

---

## 2. Nivel 1 — Dominio

El más importante y el más barato. Funciones puras, sin levantar nada.

### 2.1 Cobertura exigida

| Módulo                                          | Mínimo   | Motivo                                      |
| ----------------------------------------------- | -------- | ------------------------------------------- |
| `shared/money`, `shared/quantity`               | **100%** | Todo lo demás depende de esto               |
| `tax/vat`                                       | **100%** | Un error rechaza documentos fiscales        |
| `inventory/costing`, `inventory/allocation`     | **100%** | Un error descuadra la contabilidad          |
| `decant/*`                                      | **100%** | Es la ventaja competitiva del negocio       |
| `procurement/freight`, `procurement/landedCost` | **100%** | Determina todos los márgenes                |
| `accounting/posting`                            | **100%** | Un asiento mal derivado es un balance falso |
| Resto de `packages/domain`                      | ≥ 90%    |                                             |

100% de líneas **y** de ramas en esos módulos. Un `if` sin su caso contrario probado no cuenta.

### 2.2 Cada test referencia su regla

```ts
describe('RN-FRA-04 · Costo del decant', () => {
  it('suma líquido, merma real e insumos sobre el costo puesto del lote', () => {
    const r = executeDecant({
      plan: { mlExpected: Quantity.ml(10), wasteExpected: Quantity.ml(0.2), ... },
      wasteActual: Quantity.ml(0.35),
      bulkLot: { unitCost: Money.pyg(11_972n), ... },
      bomLots: [vial(4_500n), atomizador(2_500n), etiqueta(300n)],
    });

    expect(r.ok).toBe(true);
    expect(r.value.cogs.minor).toBe(131_210n);
    expect(r.value.costBreakdown).toEqual({
      liquid:   Money.pyg(119_720n),
      waste:    Money.pyg(4_190n),
      supplies: Money.pyg(7_300n),
    });
  });
});
```

Sin referencia a la regla, el test es una afirmación sin fundamento: nadie sabe si el número esperado es correcto o es lo que devolvía el código el día que se escribió.

**Excepción — objetos de valor de `shared/`.** La razón de exigir la cita es proteger números que el negocio podría mover en silencio: una tasa de IVA, un factor de merma, el ejemplo real de un decant. Si el test no ancla ese número a una fuente externa (la regla de negocio), nadie puede distinguir "correcto" de "lo que el código devolvía hoy". Esa razón no aplica a la aritmética definicional de `Money`, `Quantity`, `Percentage`, `Result` y la jerarquía de errores (`packages/domain/src/shared/`): `Money.plus(100_000n, 45_000n)` da `145_000n` porque así funciona la suma, no porque el negocio lo haya decidido — no hay nada que el negocio pueda mover en silencio. `domain-rules.md` tampoco tiene un `RN-XXX-nn` para esta capa: son los objetos de valor que las reglas de negocio van a usar, no una regla en sí. Ahí, cada `describe` cita la sección de `docs/domain-contracts.md` que define el comportamiento (`§3.1` Money, `§3.2` Quantity, `§3.3` Percentage, `§4.1`/`§4.2` Result y errores) en vez de inventar un `RN-XXX-nn` que no existe.

Esto deja de aplicar en cuanto un módulo de `shared/` encarna una regla real. Por ejemplo: si `Money.allocate` alguna vez adoptara el criterio de reparto de RN-COS-02 (la diferencia de redondeo va a la línea de mayor valor) en vez de quedarse con el método genérico del mayor resto, ese test pasa a citar `RN-COS-02`, porque en ese momento sí habría un número de negocio que proteger.

**Esto no es exclusivo del dominio.** `.claude/rules/testing.md` exige la misma cita en cualquier `*.test.ts` del repositorio, no solo en `packages/domain` — esta sección la explica acá porque el dominio fue el primer paquete con tests. `packages/contracts/src/shared/` (WP-A11) es el segundo caso real: sus tests protegen convenciones de frontera (dinero como string, forma de un id, forma de una página) definidas en `docs/api-conventions.md` y `docs/data-model.md`, no una regla de negocio — ahí cada `describe` cita la sección de esos documentos en vez de un `RN-XXX-nn`, por el mismo motivo que la excepción de arriba: no hay un número que el negocio pueda mover en silencio.

### 2.3 Casos borde obligatorios

Los 20 casos de `domain-rules.md` §"Catálogo de casos borde" tienen un test cada uno. Un PR que agregue una regla agrega sus casos borde al documento **y** sus tests.

### 2.4 Pruebas basadas en propiedades

Para las invariantes matemáticas, `fast-check` en lugar de ejemplos:

```ts
it("el prorrateo nunca pierde ni gana unidades", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 10_000_000n }),
      fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 20 }),
      (total, weights) => {
        const parts = Money.pyg(total).allocate(weights);
        const sum = parts.reduce((a, b) => a.plus(b), Money.pyg(0n));
        expect(sum.minor).toBe(total); // exacto, siempre
      },
    ),
  );
});
```

Aplicar a: prorrateo de flete, desglose de IVA, suma de capas de costo, redondeo.

---

## 3. Nivel 2 — Integración

Postgres real vía Testcontainers. Nada de base en memoria ni de simulacros de Prisma: los invariantes viven en PostgreSQL y un simulacro no los tiene.

```ts
// test/setup/db.ts
export async function withTestDb(fn: (db: PrismaClient) => Promise<void>) {
  const container = await new PostgreSqlContainer("postgres:16").start();
  await runMigrations(container.getConnectionUri());
  await runSeed(container.getConnectionUri());
  // ...
}
```

### 3.1 Qué se prueba acá

- Que una operación multi-tabla es **atómica**: si falla el paso 4, no quedan los pasos 1 a 3 persistidos.
- Que el contexto de sesión se establece y RLS aísla.
- Que los triggers disparan en el flujo real, no solo en el test aislado de invariantes.
- Que las consultas del repositorio devuelven lo esperado con datos reales.
- Que el bloqueo en orden ascendente evita interbloqueos: dos transacciones concurrentes sobre los mismos lotes en orden inverso.

### 3.2 Prueba de aislamiento

Obligatoria y explícita: conectarse como `joda_api` (no como superusuario) y verificar que sin `tenant_id` en contexto no ve nada, y que con otro tenant tampoco.

```ts
it("RLS aísla por tenant con el rol de aplicación", async () => {
  const api = connectAs("joda_api");
  // El true final es obligatorio: hace el valor local a la transacción
  // para que no se filtre por el pool (AGENTS.md, docs/api-conventions.md §8.1).
  await api.query(`SELECT set_config('app.tenant_id', $1, true)`, [OTHER_TENANT]);
  const { rowCount } = await api.query("SELECT * FROM app.products");
  expect(rowCount).toBe(0);
});
```

**Este test es no negociable.** Es el que detecta si alguien cambió la conexión a una credencial elevada y desactivó silenciosamente toda la capa de aislamiento.

---

## 4. Nivel 3 — Invariantes de base

`packages/db/tests/invariants.sql`: 19 pruebas que **intentan una operación inválida y esperan el rechazo**.

```sql
SELECT pg_temp.expect_fail(3, 'Sobreventa',
  $$INSERT INTO app.inventory_movements (...) VALUES (..., -200, 'ml', 'sale')$$);
```

Corre con `pnpm db:test`, sobre una base recién creada.

**Regla:** todo invariante nuevo agrega su prueba en el mismo PR. Un invariante sin prueba es una creencia.

Para las constraints diferidas hay que forzar la evaluación dentro del bloque:

```sql
SET CONSTRAINTS app.trg_journal_balanced IMMEDIATE;
```

---

## 5. Nivel 4 — Dataset dorado

`packages/domain/test/golden/`: alrededor de veinte operaciones reales del negocio, con los resultados **calculados a mano** y verificados contra la operación histórica del ERP v2.

```
golden/
├── 01-compra-usd-con-flete.json
├── 02-apertura-frasco.json
├── 03-fraccionamiento-10ml.json
├── 04-venta-decant.json
├── 05-venta-mixta-decant-y-reloj.json
├── 06-venta-con-sena-parcial.json
├── 07-recepcion-parcial.json
├── 08-fifo-dos-capas.json
├── 09-devolucion-reloj.json
├── 10-iva-con-diferencia-de-redondeo.json
└── ...
```

Cada archivo tiene entrada, salida esperada y una nota que explica de dónde salió el número:

```json
{
  "id": "03-fraccionamiento-10ml",
  "regla": "RN-FRA-04",
  "nota": "Frasco Layton 125ml, USD 190 + 15 flete, dólar 7300. Verificado contra planilla de costos de agosto 2026.",
  "input": { "...": "..." },
  "expected": { "cogs": "131210", "liquid": "119720", "waste": "4190", "supplies": "7300" }
}
```

**Para qué sirve:** permite refactorizar el costeo sin miedo. Si los veinte casos siguen dando lo mismo después de reescribir el módulo, el refactor es correcto. Sin este dataset, cualquier cambio en el costeo es un acto de fe.

Corre en cada PR. **Un cambio en un valor esperado del dataset dorado requiere justificación explícita en el PR**, nunca se actualiza para "hacer pasar el test".

---

## 6. Nivel 5 — Extremo a extremo

Playwright, solo para flujos donde la integración del navegador es parte del riesgo.

**Cubiertos:**

1. Checkout completo en el storefront hasta la confirmación de pago (con proveedor en modo prueba).
2. Venta de mostrador en el admin, desde buscar producto hasta emitir el documento.
3. Recepción de una orden de compra con prorrateo de flete.
4. Ejecución de una orden de fraccionamiento.
5. Un usuario `vendedor` no puede acceder a contabilidad ni por URL directa.

**No cubiertos:** cálculos, validaciones, reglas. Eso es nivel 1.

Corren en el CI de la rama principal y antes de cada despliegue a producción, no en cada PR: son lentos.

---

## 7. Qué exige cada PR

| Tipo de cambio                        | Requisito                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| Regla de negocio nueva o modificada   | Test de nivel 1 con referencia a `RN-XXX`, más sus casos borde                 |
| Cambio de esquema                     | `pnpm db:reset && pnpm db:test` en verde, y prueba de invariante si agregó uno |
| Endpoint nuevo                        | Test de integración del camino feliz + un caso de permiso denegado             |
| DTO público nuevo o modificado        | Test que verifica que no filtra costos, proveedores, márgenes ni cantidades    |
| Corrección de bug                     | **Test que falla antes del arreglo y pasa después.** Sin excepción.            |
| Cambio de interfaz de usuario         | Sin test obligatorio, salvo que toque un flujo del nivel 5                     |
| Refactor sin cambio de comportamiento | Los tests existentes deben pasar **sin modificarse**                           |

Esa última fila es la más importante: si un refactor obliga a cambiar tests, o no era un refactor, o los tests probaban la implementación en lugar del comportamiento.

---

## 8. Convenciones

**Ubicación:** el test junto al código, `foo.test.ts` al lado de `foo.ts`. Los de integración en `test/integration/`, los de extremo a extremo en `e2e/`.

**Nombres:** describen el comportamiento, no la función.

```ts
// ❌ it('planDecant funciona')
// ✅ it('rechaza el fraccionamiento cuando el granel no alcanza para la unidad completa')
```

**Estructura:** preparar, ejecutar, verificar, con líneas en blanco separando los tres bloques.

**Datos:** constructores con valores por defecto, sobrescribiendo solo lo relevante.

```ts
const lot = aLot({ available: Quantity.ml(114.65), unitCost: Money.pyg(11_972n) });
```

Un test que arma un objeto de treinta campos para probar uno esconde lo que importa.

**Sin lógica en los tests.** Sin `if`, sin bucles calculando el valor esperado. El esperado se escribe literal. Un test con lógica necesita tests.

**Determinismo.** Reloj y generador de identificadores inyectados. Nada de `new Date()` ni `Math.random()` en el código bajo prueba.

---

## 9. Integración continua

```
PR:
  typecheck → lint → test:domain → test:golden → db:test → test:integration → build

Rama principal:
  todo lo anterior + e2e + despliegue a staging
```

**Bloquean la fusión:** cualquier fallo, cualquier error de tipo, cualquier advertencia de lint, cobertura de dominio por debajo del umbral.

Tiempo objetivo del pipeline de PR: **menos de 5 minutos**. Un pipeline lento se termina saltando, y un pipeline que se saltea no protege nada.

---

## 10. Qué no probamos

Ser explícito acá evita discusiones y tests inútiles:

- **Prisma, Fastify, React.** Son dependencias, tienen sus propios tests.
- **Getters y setters triviales.**
- **Configuración estática.**
- **La interfaz de usuario píxel por píxel.** Sin tests de instantánea visual: producen ruido y se actualizan sin mirar.
- **Servicios externos reales.** Bancard y el proveedor fiscal se prueban contra sus entornos de prueba en el nivel 5, y con adaptadores falsos en el resto.
