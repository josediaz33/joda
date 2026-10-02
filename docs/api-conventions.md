# Convenciones de API

Reglas para `apps/api`. Toda ruta nueva las cumple.

---

## 1. Forma general

**tRPC** para el backoffice y el storefront (tipado extremo a extremo desde `packages/contracts`). **REST** solo para lo que necesita ser consumido por terceros: webhooks entrantes y, eventualmente, integraciones.

**Excepción documentada (WP-C09):** la carga de archivos (`modules/media/httpRoutes.ts`) tampoco es tRPC, pero no es "consumida por terceros" — es un caso distinto: tRPC transporta JSON, y un archivo es binario. `POST /media/products` es una ruta Fastify plana, registrada fuera de `/trpc` y fuera de `rest/webhooks/` (esa carpeta es para proveedores externos, no para esto). Para no quedar fuera de las garantías que sí tendría como procedimiento tRPC, reimplementa a mano — reusando las mismas piezas, no reescribiéndolas — todo lo demás que un procedimiento cumpliría: `meta.permission` (§9), el gate de segundo factor (§9.1), `Idempotency-Key` (§5) y el mapeo de errores de Postgres (§4.4). Si alguna vez se necesita un segundo endpoint binario, este es el patrón a seguir — no un tercero paralelo.

```
apps/api/src/
├── modules/
│   └── <dominio>/
│       ├── router.ts       procedimientos tRPC — sin lógica
│       ├── service.ts      casos de uso — orquesta, no calcula
│       ├── repository.ts   acceso a datos — sin reglas de negocio
│       ├── mappers.ts      fila de base ↔ tipo de dominio
│       └── httpRoutes.ts   SOLO si el módulo necesita transporte binario (media/, WP-C09) — el resto no tiene este archivo
├── rest/
│   └── webhooks/           endpoints REST para proveedores externos
├── mediaServer.ts          segundo proceso Fastify, host distinto (docs/security-spec.md §5)
├── middleware/
└── adapters/
```

### 1.1 Responsabilidad por capa

| Capa              | Hace                                                | No hace             |
| ----------------- | --------------------------------------------------- | ------------------- |
| `router`          | Valida entrada, verifica permiso, llama al servicio | Lógica, consultas   |
| `service`         | Abre transacción, lee, llama al dominio, escribe    | Cálculos de negocio |
| `repository`      | Consultas y escrituras                              | Decisiones          |
| `packages/domain` | Calcula                                             | Cualquier I/O       |

**Leer, decidir, escribir.** Un servicio que consulta la base dentro de un bucle está mal escrito.

---

## 2. Nomenclatura

Procedimientos tRPC: `<módulo>.<recurso>.<acción>`.

```
catalog.product.list          catalog.product.byId       catalog.product.create
inventory.stock.available     inventory.lot.open         inventory.adjustment.create
decant.workOrder.list         decant.workOrder.execute
sales.order.confirm           sales.order.cancel
market.purchaseOrder.receive  market.sourcing.compare
accounting.journal.list       accounting.period.close
```

**Verbos permitidos:** `list`, `byId`, `create`, `update`, `archive`, más verbos de dominio cuando la acción no es un CRUD (`confirm`, `cancel`, `receive`, `execute`, `apply`, `close`, `open`).

Preferí el verbo de dominio sobre el CRUD genérico. `sales.order.confirm` dice qué pasa; `sales.order.update` con un campo `status` no dice nada y abre la puerta a transiciones inválidas.

**Query o mutation:** `list` y `byId` son `query`; todo lo demás es `mutation`. Una `query` nunca escribe.

---

## 3. Validación

Todo esquema vive en `packages/contracts` y usa `.strict()`.

```ts
// packages/contracts/src/sales.ts
export const confirmOrderInput = z
  .object({
    orderId: z.string().uuid(),
    paymentMethod: z.enum(["card", "transfer_sipap", "cash", "wallet"]),
    idempotencyKey: z.string().uuid().optional(),
  })
  .strict();

export type ConfirmOrderInput = z.infer<typeof confirmOrderInput>;
```

`.strict()` rechaza campos no declarados. Sin él, un `{ role: 'owner' }` inyectado en el cuerpo puede llegar a un `update` mal escrito.

**Importes monetarios en la frontera:** viajan como **string** en JSON, no como número. `"245000"`, no `245000`. Un `bigint` no sobrevive a `JSON.stringify` y un `number` grande pierde precisión.

```ts
export const moneySchema = z.object({
  minor: z.string().regex(/^-?\d+$/),
  currency: z.enum(["PYG", "USD", "BRL", "ARS"]),
});
```

---

## 4. Errores

### 4.1 Forma

```ts
{
  code: 'INSUFFICIENT_STOCK',        // estable, para el cliente
  message: 'No hay suficiente stock disponible para completar la operación.',
  httpStatus: 409,
  details?: { variantId: '...', requested: '10.2', available: '4.0' },
  requestId: '01J...'
}
```

`message` está en español y es para mostrar al usuario: dice **qué pasó y qué hacer**, nunca un código técnico ni un mensaje de PostgreSQL.

### 4.2 Códigos por familia

| Prefijo           | Situación                                                              | HTTP |
| ----------------- | ---------------------------------------------------------------------- | ---- |
| `VALIDATION_*`    | Entrada inválida                                                       | 400  |
| `UNAUTHENTICATED` | Sin sesión                                                             | 401  |
| `NOT_FOUND`       | Recurso inexistente **o sin permiso en rutas administrativas**         | 404  |
| `FORBIDDEN_*`     | Con sesión y acceso al módulo, pero no a la acción exacta (§4.3, §9.2) | 403  |
| `CONFLICT_*`      | Estado incompatible (stock, transición, concurrencia)                  | 409  |
| `RATE_LIMITED`    | Límite excedido                                                        | 429  |
| `EXTERNAL_*`      | Falla de proveedor externo                                             | 502  |
| `INTERNAL`        | Bug                                                                    | 500  |

### 4.3 La regla del 404

**Las rutas administrativas responden 404, no 403, ante falta de permiso.** Un 403 confirma que el endpoint existe y que hay algo que proteger.

Excepción: dentro de una sesión de staff válida, si el usuario tiene acceso al módulo pero no a la acción concreta, sí corresponde 403 — ya sabe que el módulo existe y necesita un mensaje útil. Qué cuenta exactamente como "el mismo módulo" está definido en §9.2, no acá.

### 4.4 Traducción de errores de base

Los invariantes de PostgreSQL llegan como excepciones con `ERRCODE`. Un mapeador único los traduce:

```ts
// middleware/errorMapper.ts
const PG_ERROR_MAP: Record<string, (e: PgError) => ApiError> = {
  "23514": mapCheckViolation, // check_violation
  "23505": mapUniqueViolation, // unique_violation
  "23503": mapForeignKeyViolation,
  "2F004": () => appError("CONFLICT_IMMUTABLE_LEDGER", 409, "..."),
};
```

**Nunca dejes que un mensaje de PostgreSQL llegue al usuario.** Ni siquiera "traducido a medias".

Una FK `RESTRICT` que se rompe al borrar a propósito, para que borrar no pierda nada en silencio, tiene su mensaje propio, por el nombre de la restricción (`PgError.constraint`) y no el genérico de `mapForeignKeyViolation`: hoy, `customer_deposits_sale_order_id_fkey` → `CONFLICT_ORDER_HAS_DEPOSIT` (409, «el pedido tiene una seña asociada: desvinculala antes de borrarlo», WP-B11d).

---

## 5. Idempotencia

Toda mutación que produzca un efecto irreversible (confirmar venta, contabilizar recepción, ejecutar fraccionamiento, aplicar seña) acepta `Idempotency-Key`.

```
Idempotency-Key: 01J8XKQ7ZN4T5V6W8Y9A0B1C2D
```

Comportamiento:

1. Se busca `(tenant_id, scope, key)` en `idempotency_keys`.
2. Si existe y el hash del cuerpo coincide → devolver la respuesta guardada, sin reprocesar.
3. Si existe y el hash **no** coincide → `409 CONFLICT_IDEMPOTENCY_KEY_REUSE`.
4. Si no existe → procesar, guardar respuesta y código.

El registro se inserta **dentro de la misma transacción** que el efecto. Si la transacción falla, la clave no queda quemada.

### 5.1 Webhooks

Los webhooks de pago usan su propio mecanismo: `payment_events` con `UNIQUE (provider, external_event_id)`.

```ts
// rest/webhooks/bancard.ts
const inserted = await repo.recordEvent(tx, { provider, externalEventId, payload });
if (!inserted) return reply.code(200).send(existing.result); // reintento
// ... procesar
```

**Además:** verificar la firma del proveedor antes de procesar, y **confirmar el monto contra la API del proveedor** antes de dar la venta por pagada. Un webhook es una notificación, no una autorización.

---

## 6. Paginación

Cursor, no offset. El offset se degrada y produce resultados inconsistentes cuando se insertan filas entre páginas.

```ts
// entrada
{ cursor?: string, limit?: number }   // limit por defecto 50, máximo 200

// salida
{ items: T[], nextCursor: string | null }
```

El cursor es opaco: base64 de `(orden, id)`. El cliente no lo interpreta.

Cuando el `orderBy` de un procedimiento es fijo del lado del servidor (el caso normal: el cliente nunca elige el orden), alcanza con codificar el `id` — el cursor nativo de Prisma (`cursor: { id }, skip: 1`) ya resuelve la posición correcta dentro de ese orden compuesto sin necesitar el valor de orden viajando aparte. `apps/api/src/db/cursor.ts` (WP-C08) es la referencia de esta simplificación.

Para listados que el usuario necesita contar (reportes), un procedimiento `count` separado. Nunca devolver `total` en cada página: obliga a un `COUNT(*)` costoso en toda consulta.

---

## 7. DTOs por audiencia

**Los DTO públicos y administrativos son esquemas distintos**, no el mismo con campos opcionales.

```ts
// packages/contracts/src/catalog.ts

export const publicProduct = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    brandName: z.string().nullable(),
    facets: z.record(z.unknown()),
    variants: z.array(publicVariant),
  })
  .strict();

export const adminProduct = publicProduct.extend({
  status: z.enum(["draft", "active", "archived"]),
  costSummary: costSummarySchema, // JAMÁS en el público
  supplierRefs: z.array(z.string()), // JAMÁS en el público
});
```

Test obligatorio por cada DTO público: verificar que la respuesta **no contiene** ninguna clave de la lista prohibida (`cost`, `landed`, `supplier`, `margin`, `fx_rate`). Un `.strict()` en la salida no alcanza si alguien extiende el objeto por descuido.

`publicVariant` expone `inStock: boolean`, nunca la cantidad.

---

## 8. Transacciones

### 8.1 Contexto de sesión

Toda transacción abre estableciendo el contexto, **antes de cualquier consulta**:

```ts
export async function withTenantTx<T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return ctx.db.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT set_config('app.user_id',   ${ctx.userId},   true),
             set_config('app.tenant_id', ${ctx.tenantId}, true),
             set_config('app.audience',  ${ctx.audience}, true),
             set_config('app.session_id', ${ctx.sessionId ?? ""}, true)`;
    return fn(tx);
  });
}
```

`app.session_id` (WP-B13) nombra la sesión de personal que respalda el contexto: `app.has_permission()` exige que sea una sesión viva, no revocada, del mismo usuario y tenant. `null` solo en el login, que crea la sesión dentro de la misma transacción.

El `true` final hace el valor local a la transacción. Sin él, se filtra a la siguiente petición que reutilice la conexión del pool — un error de aislamiento entre usuarios, silencioso y grave.

### 8.2 Bloqueo

Operaciones que consumen stock bloquean los lotes **en orden ascendente de `lot_id`**, en una sola sentencia:

```sql
SELECT * FROM app.inventory_lots
 WHERE id = ANY($1::uuid[])
 ORDER BY id
 FOR UPDATE;
```

El orden determinístico es obligatorio: sin él, dos pedidos multi-línea que tocan los mismos lotes en orden distinto producen interbloqueo. **Este comentario va en el código**, porque es exactamente el tipo de detalle que alguien "limpia" en un refactor.

`SKIP LOCKED` solo para trabajadores en segundo plano, nunca en una venta: saltear un recurso bloqueado durante una venta produce resultados inesperados.

### 8.3 Alcance

Una operación de negocio, una transacción. No abras una transacción para leer, y no llames a un proveedor externo dentro de una: una transacción no debe esperar por la red.

Patrón para operaciones con efecto externo:

```
1. Transacción: reservar y marcar 'pendiente'
2. Fuera de transacción: llamar al proveedor
3. Transacción: confirmar o revertir según el resultado
```

### 8.4 Verificación de pertenencia de ids relacionados

Todo id de entidad relacionada que llegue desde el cliente y se use en un `INSERT` o `UPDATE` debe leerse primero **bajo RLS**, dentro de la misma transacción, para verificar que pertenece al tenant de la sesión — antes de escribir, no después.

Las comprobaciones de integridad referencial de PostgreSQL corren con privilegio interno y **NO evalúan RLS**: una FK al padre no protege nada. Que la columna destino tenga su propia FK `NOT NULL REFERENCES` no alcanza — un `categoryId` o un `productId` de otro tenant pasa esa FK igual, sea cual sea el rol conectado. RLS en la fila que se está insertando protege que ESA fila sea legible/escribible por el tenant correcto; no evita insertarla apuntando por FK a un id ajeno.

El patrón correcto está en `apps/api/src/modules/catalog/service.ts` (`assertCategoryAndTagIdsExist`, `findProductRow`): un `SELECT ... count()`/`findX` tenant-scoped, dentro de `withTenantTx`, antes del `INSERT`/`UPDATE` que usa ese id. Este fue exactamente el hueco que motivó WP-B08: `product_media` insertaba con `productId` del cliente sin esta verificación (encontrado en la revisión cruzada de WP-C09), y luego apareció el mismo patrón sin corregir en `categoryId`/`tagId` de `catalog.service.ts` (corregido en el mismo PR de WP-B08) y en `brandId`/`sourceVariantId` del mismo archivo (sin corregir, anotado como WP-C08b). Cada columna nueva que referencia otra tabla con `tenant_id` propio necesita este chequeo — no es opcional para "las columnas obvias".

---

## 9. Autorización

Cada procedimiento declara su permiso:

```ts
export const salesRouter = router({
  order: router({
    list: staffProcedure
      .meta({ permission: "sales.order:read" })
      .input(listOrdersInput)
      .query(({ ctx, input }) => service.listOrders(ctx, input)),

    confirm: staffProcedure
      .meta({ permission: "sales.order:write" })
      .input(confirmOrderInput)
      .mutation(({ ctx, input }) => service.confirmOrder(ctx, input)),
  }),
});
```

`staffProcedure` verifica audiencia y permiso en el middleware. **Un procedimiento sin `meta.permission` falla en el arranque**, no en producción: un test recorre el router y verifica que todos lo declaran.

`publicProcedure` existe solo para el storefront y está limitado a lecturas de catálogo y a operaciones sobre el propio pedido del cliente.

### 9.1 Segundo factor (WP-C04)

Hay una barrera más temprana que `meta.permission`: `enforceMfaGate` (`apps/api/src/trpc/trpc.ts`) bloquea TODO procedimiento, de CUALQUIER módulo, mientras una sesión de personal tenga el segundo factor pendiente (`docs/security-spec.md` §4.3) — sin que el router de ese módulo tenga que hacer nada. Un procedimiento nuevo no necesita declarar nada para quedar cubierto; la excepción es explícita:

```ts
enroll: staffProcedure.meta({ mfaExempt: true, permissionExempt: true }).mutation(...)
```

`mfaExempt: true` es solo para el puñado de procedimientos que SON el mecanismo por el que una sesión sale de ese estado: `auth.session.refresh`/`logout` y `auth.mfa.*`. Ningún procedimiento de negocio debería necesitarlo. Esos mismos procedimientos también declaran `permissionExempt: true` (WP-C05, §9 arriba): son el mecanismo de autenticación en sí, no una acción de negocio con un permiso propio — exigirles uno sería circular.

### 9.2 Qué es un "módulo" para la excepción del 403

La regla del 404 (§4.3) tiene una excepción: con sesión de personal válida, si el usuario tiene algún permiso del mismo **módulo** que el requerido pero no la acción exacta, corresponde 403, no 404 — ya sabe que el módulo existe. "Módulo" acá es el código de permiso completo **sin su último segmento** (todo antes de los `:`), no el primer segmento del catálogo de §2. Dos permisos son del mismo módulo si y solo si esa porción coincide carácter por carácter:

- `sales.order:read` y `sales.order:write` → mismo módulo (`sales.order`) → 403 si falta uno y sobra el otro.
- `market.purchase_order:read` y `market.purchase_order:approve` → mismo módulo (`market.purchase_order`) → 403.
- `market.purchase_order:read` y `market.supplier:read` → módulos distintos (`market.purchase_order` ≠ `market.supplier`), aunque la matriz de §2.1 los agrupe visualmente bajo `market.*` → 404, no 403. La matriz agrupa para que la tabla se lea más corto; no redefine qué es un módulo para esta excepción.

Implementado en `packages/domain/src/security/authorization.ts` (`decidePermissionAccess`), con esta forma exacta cubierta por test.

---

## 10. Auditoría

Toda mutación sobre inventario, contabilidad, compras y configuración escribe en `audit_log`, **en la misma transacción**:

```ts
await repo.audit(tx, {
  action: "inventory.adjustment.create",
  entity: "inventory_movements",
  entityId: movement.id,
  before: null,
  after: { qty: "−5.000", reason: "rotura" },
});
```

`action` usa el mismo nombre que el procedimiento tRPC. Así se puede cruzar bitácora con métricas de uso.

---

## 11. Límites de tasa

| Ámbito              | Límite                 |
| ------------------- | ---------------------- |
| Autenticación       | 5/min por IP + usuario |
| Checkout            | 10/min por sesión      |
| Webhooks            | 100/min por proveedor  |
| General autenticado | 100/min por usuario    |
| Catálogo público    | 300/min por IP         |

Respaldo en Redis. Al exceder: `429` con cabecera `Retry-After`.

---

## 12. Versionado

No hay `/v1` en las rutas. El storefront y el admin se despliegan junto con la API desde el mismo monorepo, así que el contrato nunca queda desincronizado.

Si algún día hay un consumidor externo, se versiona **ese** endpoint REST, no toda la API.

**Cambios de contrato:** aditivos siempre que se pueda. Para uno incompatible, el mismo patrón expand/contract del esquema — agregar el campo nuevo, migrar los consumidores, quitar el viejo en un despliegue posterior.
