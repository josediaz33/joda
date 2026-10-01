# Especificación de Seguridad

Implementa ADR-015 (identidades separadas) y ADR-016 (RBAC en tres capas). Referencia obligatoria antes de tocar autenticación, permisos o políticas de base.

---

## 1. Modelo de identidad

Dos poblaciones, dos tablas, dos superficies.

|                   | Cliente              | Personal                              |
| ----------------- | -------------------- | ------------------------------------- |
| Tabla             | `customers`          | `staff_users`                         |
| Dominio           | `jodaparfums.com`    | `admin.jodaparfums.com`               |
| Cookie            | `__Host-joda_c`      | `__Host-joda_a` (scope al subdominio) |
| Audiencia         | `customer`           | `staff`                               |
| Segundo factor    | Opcional             | **Obligatorio**                       |
| Sesión            | 30 días              | 8 h                                   |
| Token de refresco | 90 días, rotativo    | 8 h, rotativo con detección de reúso  |
| Permisos          | Ninguno del catálogo | Según roles asignados                 |

**Que un cliente no pueda tener un rol de personal es un invariante de esquema:** no existe fila donde ponérselo. No es una condición que haya que recordar validar.

La separación de cookies importa: un XSS en el storefront no alcanza la sesión del admin, porque la cookie de personal está limitada al subdominio.

---

## 2. Catálogo de permisos

Forma: `recurso.subrecurso:acción`.

| Código                          | Descripción                           |
| ------------------------------- | ------------------------------------- |
| `catalog.product:read`          | Ver productos y variantes             |
| `catalog.product:write`         | Crear y editar productos              |
| `catalog.product:publish`       | Publicar al storefront                |
| `inventory.stock:read`          | Ver stock, lotes **y costos de lote** |
| `inventory.stock:adjust`        | Ajustar inventario                    |
| `inventory.decant:execute`      | Ejecutar órdenes de fraccionamiento   |
| `sales.order:read`              | Ver pedidos                           |
| `sales.order:write`             | Crear y confirmar pedidos             |
| `sales.order:refund`            | Anular y reembolsar                   |
| `accounting.cashbox:read`       | Ver caja y arqueos                    |
| `accounting.cashbox:write`      | Registrar movimientos de caja         |
| `accounting.deposit:read`       | Ver señas                             |
| `accounting.deposit:write`      | Registrar y aplicar señas             |
| `accounting.journal:read`       | Ver asientos y balances               |
| `accounting.journal:write`      | Contabilizar asientos                 |
| `market.supplier:read`          | Ver proveedores                       |
| `market.supplier:write`         | Crear y editar proveedores            |
| `market.purchase_order:read`    | Ver órdenes de compra                 |
| `market.purchase_order:write`   | Crear órdenes de compra               |
| `market.purchase_order:approve` | Aprobar órdenes de compra             |
| `market.purchase_order:receive` | Registrar recepciones                 |
| `market.sourcing:read`          | Ver escenarios de sourcing            |
| `market.sourcing:write`         | Crear escenarios                      |
| `market.channel:write`          | Gestionar canales y publicaciones     |
| `fiscal.document:read`          | Ver documentos fiscales               |
| `fiscal.document:issue`         | Emitir documentos fiscales            |
| `settings.user:read`            | Ver usuarios y roles                  |
| `settings.user:write`           | Gestionar usuarios y roles            |

### 2.1 Matriz de roles

| Permiso                    | owner | manager | vendedor | deposito |
| -------------------------- | :---: | :-----: | :------: | :------: |
| `catalog.product:read`     |   ✓   |    ✓    |    ✓     |    ✓     |
| `catalog.product:write`    |   ✓   |    ✓    |          |          |
| `catalog.product:publish`  |   ✓   |    ✓    |          |          |
| `inventory.stock:read`     |   ✓   |    ✓    |          |    ✓     |
| `inventory.stock:adjust`   |   ✓   |    ✓    |          |    ✓     |
| `inventory.decant:execute` |   ✓   |    ✓    |          |    ✓     |
| `sales.order:read`         |   ✓   |    ✓    |    ✓     |          |
| `sales.order:write`        |   ✓   |    ✓    |    ✓     |          |
| `sales.order:refund`       |   ✓   |    ✓    |          |          |
| `accounting.cashbox:read`  |   ✓   |    ✓    |          |          |
| `accounting.cashbox:write` |   ✓   |    ✓    |          |          |
| `accounting.deposit:read`  |   ✓   |    ✓    |    ✓     |          |
| `accounting.deposit:write` |   ✓   |    ✓    |    ✓     |          |
| `accounting.journal:*`     |   ✓   |    ✓    |          |          |
| `market.*`                 |   ✓   |    ✓    |          | receive  |
| `fiscal.document:read`     |   ✓   |    ✓    |          |          |
| `fiscal.document:issue`    |   ✓   |    ✓    |    ✓     |          |
| `settings.user:read`       |   ✓   |    ✓    |          |          |
| `settings.user:write`      |   ✓   |         |          |          |

**Dos decisiones deliberadas:**

- **`vendedor` no ve caja ni costos.** Que alguien cargue una venta no implica que vea el flujo financiero del negocio ni lo que cuesta cada frasco. Sí maneja señas, porque es parte de vender: las registra y las aplica al vender, y por eso tiene `accounting.deposit:write` **y** `accounting.deposit:read`. Con RLS, escribir una seña exige poder leerla (§3.1, "La trampa de la lectura"). `accounting.cashbox:read` sigue fuera de su alcance. **Lee todas las señas del tenant, no solo las de su cliente:** la base filtra por tenant, no por vendedor. Decisión aceptada (2026-10-01): acotarlo por cliente no se justifica en un negocio de este tamaño.
- **`deposito` no ve precios de compra.** Mueve mercadería. `inventory.stock:read` incluye costos de lote, así que si más adelante hace falta un depósito sin acceso a costos, se separa en `inventory.stock:read` e `inventory.cost:read`.

---

## 3. Las tres capas

| Capa               | Dónde      | Rol                                                                   |
| ------------------ | ---------- | --------------------------------------------------------------------- |
| **1 — RLS**        | PostgreSQL | Aislamiento por tenant + permisos sobre lo sensible. Deny-by-default. |
| **2 — Middleware** | API        | `requirePermission()` en cada procedimiento. **Defensa principal.**   |
| **3 — Servicio**   | API        | Reglas dependientes del recurso concreto.                             |
| _Guardas de React_ | Frontend   | **Experiencia de usuario, no seguridad.**                             |

### 3.1 Capa 1 — RLS

Toda tabla con `tenant_id` lleva RLS habilitado **y forzado**:

```sql
ALTER TABLE app.<tabla> ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.<tabla> FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.<tabla> AS RESTRICTIVE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
-- Permisiva base requerida por Postgres, que deniega todo si no hay
-- ninguna permisiva. El filtrado lo hace tenant_isolation, que es
-- RESTRICTIVE. Nunca uses esta política sin la restrictiva.
CREATE POLICY tenant_access ON app.<tabla>
  USING (true) WITH CHECK (true);
```

**`tenant_isolation` es RESTRICTIVE** (WP-B10): se combina con AND contra toda otra política. Si fuera permisiva (el default de Postgres), se combinaría con OR contra las de permiso de abajo, y tener el permiso alcanzaría para leer filas de cualquier tenant; ese era el defecto que corrigió B10. Detalle del patrón, incluida qué tablas llevan `tenant_access` y para qué comandos, en `docs/data-model.md` §7.

Encima, políticas de permiso sobre lo sensible:

```sql
CREATE POLICY accounting_read ON app.journal_entries
  FOR SELECT USING (app.has_permission('accounting.journal:read'));

CREATE POLICY lots_read ON app.inventory_lots
  FOR SELECT USING (app.has_permission('inventory.stock:read'));
```

#### Escritura sobre lo sensible (WP-B11, `0030_write_permissions_sensitive_tables.sql`)

Leer exigía un permiso desde 0010; escribir solo exigía tenant. Desde 0030, en `suppliers`, `purchase_orders`, `inventory_lots`, `chart_of_accounts` y `customer_deposits`, escribir exige el permiso de escritura, una política por comando. Combinado con `tenant_isolation` (RESTRICTIVE), el resultado es tenant **Y** permiso:

| Tabla               | INSERT                                                                                                       | UPDATE                                                 | DELETE                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------- |
| `suppliers`         | `market.supplier:write`                                                                                      | `market.supplier:write`                                | nadie (se desactiva con `is_active`)                 |
| `purchase_orders`   | `market.purchase_order:write`                                                                                | `market.purchase_order:write`, `:approve` o `:receive` | `market.purchase_order:write`, y **solo en `draft`** |
| `inventory_lots`    | `market.purchase_order:receive`, `inventory.decant:execute`, `sales.order:refund` o `inventory.stock:adjust` | los mismos cuatro                                      | nadie (historial de costo; se corrige con un ajuste) |
| `chart_of_accounts` | `accounting.journal:write`                                                                                   | `accounting.journal:write`                             | nadie (se desactiva con `is_active`)                 |
| `customer_deposits` | `accounting.deposit:write`                                                                                   | `accounting.deposit:write`                             | nadie (se devuelve o se aplica, nunca se borra)      |

Los cuatro permisos de los lotes son el mapeo que aprobó José el 2026-09-25: recepción de compra, apertura de frasco y decant por anticipado, devolución a cuarentena, y ajuste o saldo de apertura.

**La base impone el piso, no la operación.** La capa 1 no sabe cuál de las operaciones está haciendo quien escribe: en `inventory_lots` acepta cualquiera de los cuatro permisos, y en el UPDATE de `purchase_orders` la unión de los tres **sobre la fila entera**. Qué transición puede hacer cada permiso (aprobar, recibir, cancelar) lo imponen la capa 2 (`requirePermission`) y `packages/domain`, no la base. Un DELETE sin política permisiva no da error: afecta cero filas.

**El filtro `draft` del DELETE de órdenes es una barrera del DELETE directo, no una máquina de estados.** La política de UPDATE no mira el estado: un rol con `:write` y `:read` puede devolver una orden a `draft` con un UPDATE y borrarla en una segunda transacción. Hoy lo frenan, de forma incidental, `purchase_order_transitions` (append-only: una orden con su transición registrada no se borra) y la FK RESTRICT de `goods_receipts`. Que una orden no vuelva a borrador lo imponen la capa 2 y el dominio. Si hace falta que la imponga la base, es un guarda aparte con el criterio de inmutabilidad de ADR-017.

**La trampa de la lectura.** Con RLS, `INSERT ... RETURNING` y los `UPDATE` o `DELETE` que **leen columnas** (con `WHERE` o `RETURNING`) evalúan también la política de **lectura** de la tabla. Un rol con el permiso de escribir y sin el de leer no recibe un error que lo explique: el `INSERT ... RETURNING` que emite Prisma se rechaza con `42501`, y el `UPDATE ... WHERE` o `DELETE ... WHERE` afecta cero filas (la API lo devuelve como 404). Un `UPDATE` sin `WHERE` ni `RETURNING` (o con `WHERE true`) no lee nada y solo necesita el permiso de escritura: el depósito, que tiene `:receive` y no `:read`, no edita una orden por id pero sí podría con un `UPDATE` sin `WHERE`, porque `:receive` habilita la fila entera. Consecuencias:

- **En los roles sembrados, todo permiso de escritura de estas tablas viene con el de lectura de la misma tabla.** El invariante 94 de `packages/db/tests/invariants.sql` falla si no, nombrando rol y tabla. Un permiso de escritura nuevo entra en ese invariante en el mismo PR.
- **Una excepción registrada:** `deposito` tiene `market.purchase_order:receive` y no `market.purchase_order:read`, así que no ve la orden que recibe. No se resuelve en la capa 1: WP-C15 define que el depósito carga la recepción en borrador (`goods_receipts`, con las cantidades y sin precios) y la contabiliza quien lee la orden.
- **Un rol personalizado** que combine un permiso de escritura con uno de lectura distinto de su par queda en ese mismo hueco. La base no lo impide; se impide al administrar roles: WP-C24 exige que asignar un permiso de escritura sobre estas cinco tablas asigne también el de lectura de su par.

**Nunca `FOR ALL` en una política de permiso.** Un `FOR ALL` permisivo también cubre `SELECT`: quien puede escribir leería la tabla entera aunque no tenga el permiso de leer. El invariante 92 lo verifica.

**Solo audiencia `staff`.** `has_permission` exige una sesión de staff viva (WP-B13), así que un contexto `system` o `customer` no escribe en estas cinco tablas. Hoy ningún código lo necesita; el día que un webhook de pago tenga que registrar una seña, necesita una política propia o una función `SECURITY DEFINER` acotada, no un permiso prestado. Ese camino no está definido todavía: queda anotado en WP-C20 (señas) y WP-G13 (webhooks de pago).

**La condición que hace que esta capa exista de verdad:**

| Rol             | Uso                              | `BYPASSRLS`           |
| --------------- | -------------------------------- | --------------------- |
| `joda_api`      | Runtime de la API                | **No**                |
| `joda_readonly` | Catálogo público                 | **No**                |
| `service_role`  | Migraciones y ETL, solo desde CI | Sí — nunca en runtime |

Si la API usara `service_role` o el dueño de las tablas, RLS **no se evaluaría** y toda la capa sería decorativa. Además, `joda_api` no tiene `UPDATE` ni `DELETE` sobre `inventory_movements`, `movement_cost_allocations`, `audit_log` ni `fiscal_events`.

**Verificado:** conectado como `joda_api`, sin `tenant_id` en contexto → cero filas; con otro tenant → cero filas; `UPDATE` sobre el libro → `permission denied`.

**Provisión de la credencial de runtime (WP-C02).** `apps/api` se conecta exclusivamente con `DATABASE_URL_API` (ver `.env.example`) — nunca con `DATABASE_URL`, que queda reservada a migraciones y ETL (el equivalente local de `service_role`). Sin `DATABASE_URL_API` el proceso no arranca: se valida con Zod al inicio (`apps/api/src/config/env.ts`), sin fallback a ninguna otra variable. Además, antes de aceptar tráfico, `apps/api` corre `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user` (`apps/api/src/db/client.ts`, `assertRlsNotBypassed`) y aborta el arranque si devuelve `true` — la red que atrapa a `DATABASE_URL_API` apuntando por error al owner de las tablas o a un superusuario. La password de desarrollo la fija `packages/db/seed/0002_seed_joda_api_credential.sql`; en producción sale del gestor de secretos.

### 3.2 Capa 2 — Middleware

```ts
export const requirePermission =
  (...required: PermissionCode[]) =>
  async (req: Request, reply: Reply) => {
    const s = req.session;
    if (!s || s.audience !== "staff") return reply.code(404).send();
    const granted = await permissionCache.get(s.userId);
    if (!required.every((p) => granted.has(p))) return reply.code(404).send();
  };
```

**404, no 403.** Un 403 confirma la existencia del endpoint.

**Los permisos no van en el token.** El token lleva `userId`, `tenantId`, `sessionId`, `audience`. Los permisos se resuelven en el servidor con caché en Redis, TTL 60 s: revocar un rol tiene efecto en un minuto, no cuando expire el token.

### 3.3 Capa 3 — Servicio

Reglas que dependen del recurso concreto y no se pueden expresar como permiso estático:

- Un `vendedor` solo anula ventas propias del día en curso.
- Ajustes de inventario por encima de un umbral de valor requieren `manager`.
- Cerrar un período contable requiere que no haya eventos sin postear.

### 3.4 Frontend

```tsx
<Can perform="accounting.cashbox:read">
  <ResumenCaja />
</Can>
```

```tsx
{
  path: 'contabilidad',
  loader: requirePermissionLoader('accounting.cashbox:read'),
  lazy: () => import('./modules/contabilidad/routes'),
}
```

**Esto es experiencia de usuario, no seguridad.** Cualquiera puede editar el estado de React y renderizar la pantalla de caja. Lo que no puede es obtener los datos: la petición sale igual y la API responde 404.

`lazy()` además evita descargar el código del módulo.

> Si alguna vez una pantalla protegida solo por `<Can>` muestra datos reales, el bug está en la API.

---

## 4. Sesiones

### 4.1 Cookies

```
__Host-joda_a
  HttpOnly · Secure · SameSite=Strict · Path=/ · sin Domain (scope al host exacto)
```

El prefijo `__Host-` impide que un subdominio comprometido sobrescriba la cookie.

### 4.2 Tokens

- **Acceso:** 15 min, en memoria del servidor de sesión. Nunca en `localStorage`.
- **Refresco:** rotativo. Cada uso emite uno nuevo e invalida el anterior.
- **Detección de reúso:** si reaparece un refresco ya consumido, se invalida **toda la familia de tokens** de esa sesión y se fuerza reautenticación. Es la señal de que alguien copió un token.

### 4.3 Segundo factor

Obligatorio para personal. TOTP. Un usuario sin segundo factor inscripto puede autenticarse pero solo accede a la pantalla de inscripción.

**El desafío se repite en cada sesión nueva, no solo la primera vez.** Un usuario ya inscripto que inicia sesión no queda automáticamente habilitado: la sesión nace igual de restringida (solo puede llamar a `auth.mfa.verify`) hasta presentar un código válido. Si no fuera así, el segundo factor dejaría de tener efecto después de la primera inscripción — cualquiera con la contraseña entraría para siempre sin él. Implementado en WP-C04: `staff_sessions.mfa_verified_at` guarda el momento en que ESA sesión (no el usuario en general) satisfizo el desafío.

---

## 5. Protección de entrada

| Vector                  | Mitigación                                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inyección SQL           | Prisma parametriza. `$queryRawUnsafe` prohibido por regla de lint que falla el build. SQL crudo solo con `Prisma.sql` y marcadores.                                                                                                |
| Asignación masiva       | Zod `.strict()` en toda entrada. Rechaza campos no declarados.                                                                                                                                                                     |
| XSS                     | React escapa por defecto. `dangerouslySetInnerHTML` prohibido; contenido enriquecido pasa por sanitizador. CSP con nonce.                                                                                                          |
| CSRF                    | Cookies `SameSite` + token de doble envío en mutaciones del admin.                                                                                                                                                                 |
| Carga de archivos       | Validación por **bytes mágicos**, no por `Content-Type`. Reprocesamiento con `sharp` (elimina metadatos y cargas útiles embebidas). Nombre por hash. Límite de tamaño y dimensiones. Servidos desde dominio distinto al del admin. |
| Fuerza bruta            | Límite de tasa + retardo progresivo. Bloqueo temporal a los 10 intentos.                                                                                                                                                           |
| Enumeración de usuarios | Mensaje idéntico para usuario inexistente y contraseña incorrecta. Tiempo de respuesta constante.                                                                                                                                  |
| Recorrido de rutas      | Ninguna ruta de archivo se construye con entrada del usuario.                                                                                                                                                                      |
| SSRF                    | No hay endpoints que descarguen URLs provistas por el usuario. Si se agregan, lista blanca de dominios.                                                                                                                            |

### 5.1 Cabeceras

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-...'; ...
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), camera=(), microphone=()
```

---

## 6. Datos de pago

**El número de tarjeta no entra al sistema.** Checkout hospedado o iframe del proveedor: el dato viaja del navegador del cliente al proveedor sin pasar por el servidor, el dominio ni las bitácoras de JODA.

Se almacenan `card_last4` y `card_brand`, que no son datos de tarjeta bajo las normas de la industria.

**Lista negra en el registrador de bitácoras**, aplicada centralmente y no en cada llamada:

```ts
const REDACT = ["card", "pan", "cvv", "cvc", "token", "authorization", "password", "secret"];
```

**Verificación de webhooks:** validar firma del proveedor antes de procesar, y confirmar el monto contra la API del proveedor antes de dar una venta por pagada. Un webhook es una notificación, no una autorización.

---

## 7. Auditoría

`audit_log` es append-only e inmutable, y ni la API puede borrarla.

Registran: toda mutación de inventario, contabilidad, compras, precios, permisos y configuración fiscal.

Campos: `actor_id`, `audience`, `action`, `entity`, `entity_id`, `before`, `after`, `ip`, `user_agent`, `request_id`, `occurred_at`.

`action` usa el mismo nombre que el procedimiento tRPC, para poder cruzar bitácora con métricas.

---

## 8. Secretos

- Nunca en el repositorio. `.env` en `.gitignore`, con `.env.example` documentando las variables sin valores.
- Validados con Zod al arrancar: **si falta una variable, el proceso no levanta.** Fallar en el arranque es infinitamente preferible a fallar en la primera venta.
- Rotación de credenciales de base y de proveedores cada 12 meses, o inmediata ante sospecha.
- La credencial elevada de base (`service_role`) vive únicamente en los secretos de integración continua.

---

## 9. Datos personales

- Se recoge el mínimo: nombre, contacto, dirección de envío, documento cuando la facturación lo exige.
- No se almacenan datos de tarjeta, ni preferencias sensibles, ni historial de navegación asociado a la identidad.
- Un cliente puede solicitar la eliminación de su cuenta: se anonimizan sus datos personales conservando los registros contables y fiscales, que tienen obligación legal de retención.
- Las bitácoras no contienen datos personales más allá del identificador del actor.

---

## 10. Lista de verificación para revisión de código

Antes de aprobar un PR que toque estas áreas:

- [ ] ¿Todo procedimiento nuevo declara su permiso en `meta`?
- [ ] ¿La transacción establece el contexto de sesión antes de la primera consulta, con el tercer parámetro en `true`?
- [ ] ¿Se usa `joda_api` y no una credencial elevada?
- [ ] ¿Toda tabla nueva tiene `tenant_id` y su política de aislamiento?
- [ ] ¿El DTO público excluye costos, proveedores, márgenes y cantidades exactas de stock?
- [ ] ¿La mutación irreversible acepta clave de idempotencia?
- [ ] ¿Los errores mostrados al usuario están en español y no filtran detalles internos?
- [ ] ¿Se registró la operación en la bitácora de auditoría, dentro de la misma transacción?
- [ ] ¿Hay algún secreto, token o dato personal en un `console.log` olvidado?
