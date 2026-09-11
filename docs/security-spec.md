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
| `accounting.deposit:read`  |   ✓   |    ✓    |          |          |
| `accounting.deposit:write` |   ✓   |    ✓    |    ✓     |          |
| `accounting.journal:*`     |   ✓   |    ✓    |          |          |
| `market.*`                 |   ✓   |    ✓    |          | receive  |
| `fiscal.document:read`     |   ✓   |    ✓    |          |          |
| `fiscal.document:issue`    |   ✓   |    ✓    |    ✓     |          |
| `settings.user:read`       |   ✓   |    ✓    |          |          |
| `settings.user:write`      |   ✓   |         |          |          |

**Dos decisiones deliberadas:**

- **`vendedor` no ve caja ni costos.** Que alguien cargue una venta no implica que vea el flujo financiero del negocio ni lo que cuesta cada frasco. Sí puede recibir señas, porque es parte de vender.
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
CREATE POLICY tenant_isolation ON app.<tabla>
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
```

Encima, políticas de permiso sobre lo sensible:

```sql
CREATE POLICY accounting_read ON app.journal_entries
  FOR SELECT USING (app.has_permission('accounting.journal:read'));

CREATE POLICY lots_read ON app.inventory_lots
  FOR SELECT USING (app.has_permission('inventory.stock:read'));
```

**La condición que hace que esta capa exista de verdad:**

| Rol             | Uso                              | `BYPASSRLS`           |
| --------------- | -------------------------------- | --------------------- |
| `joda_api`      | Runtime de la API                | **No**                |
| `joda_readonly` | Catálogo público                 | **No**                |
| `service_role`  | Migraciones y ETL, solo desde CI | Sí — nunca en runtime |

Si la API usara `service_role` o el dueño de las tablas, RLS **no se evaluaría** y toda la capa sería decorativa. Además, `joda_api` no tiene `UPDATE` ni `DELETE` sobre `inventory_movements`, `movement_cost_allocations`, `audit_log` ni `fiscal_events`.

**Verificado:** conectado como `joda_api`, sin `tenant_id` en contexto → cero filas; con otro tenant → cero filas; `UPDATE` sobre el libro → `permission denied`.

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
