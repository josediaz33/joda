# `packages/db` — esquema JODA Parfums v4

Esquema completo del ecosistema ERP + E-commerce, **ejecutado y verificado contra PostgreSQL 16**. No es una propuesta: es DDL que corre.

## Qué hay acá

```
migrations/    14 archivos, aplicados en orden. SQL-first.
seed/          permisos, roles, plan de cuentas, reglas de posteo
tests/         flujo de negocio real + suite de invariantes
prisma/        schema.prisma (se genera por introspección, ver abajo)
```

## Verificación

Todo lo que sigue se ejecutó, no se estimó:

|                            |                   |
| -------------------------- | ----------------- |
| Tablas                     | 63                |
| Vistas                     | 6                 |
| Enums / dominios           | 29 / 5            |
| CHECK constraints          | 106               |
| Claves foráneas            | 166               |
| Índices                    | 133               |
| Triggers (no internos)     | 25                |
| Tablas con RLS activo      | 62                |
| Políticas RLS              | 71                |
| **Pruebas de invariantes** | **65 / 65 pasan** |

Verificado el 2026-09-23 contra la base recién migrada (`pnpm db:reset`, PostgreSQL 16), con estas consultas — así la próxima actualización es correr esto y pegar los números, no recalcular a ojo:

```sql
-- Tablas / Índices con RLS activo (relkind='r', esquema app)
SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='app' AND c.relkind='r';                          -- Tablas
SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='app' AND c.relkind='r' AND c.relrowsecurity;     -- Tablas con RLS activo

-- Vistas (relkind='v'), en los dos esquemas donde existen
SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind='v' AND n.nspname IN ('app','public');

-- Enums (typtype='e') / dominios (typtype='d'), esquema app
SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
 WHERE n.nspname='app' AND t.typtype='e';                          -- Enums
SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
 WHERE n.nspname='app' AND t.typtype='d';                          -- Dominios

-- CHECK (contype='c') / FK (contype='f'), esquema app
SELECT count(*) FROM pg_constraint co JOIN pg_namespace n ON n.oid=co.connamespace
 WHERE n.nspname='app' AND co.contype='c';                         -- CHECK constraints
SELECT count(*) FROM pg_constraint co JOIN pg_namespace n ON n.oid=co.connamespace
 WHERE n.nspname='app' AND co.contype='f';                         -- Claves foráneas

-- Índices, esquema app
SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app';

-- Triggers no internos, esquema app
SELECT count(*) FROM pg_trigger tg JOIN pg_class c ON c.oid=tg.tgrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='app' AND NOT tg.tgisinternal;

-- Políticas RLS (pg_policy no filtra por schema en la vista de catálogo simple)
SELECT count(*) FROM pg_policy;

-- Pruebas de invariantes: pnpm db:test, línea final "N / N invariantes en verde"
```

El flujo de negocio de `tests/smoke_business_flow.sql` corre de punta a punta: compra en USD con flete → recepción → apertura de frasco → fraccionamiento con merma real → venta → asiento contable. Cierra con deriva cero entre el ledger y la proyección de saldos.

## Cómo correrlo

Con `DATABASE_URL` apuntando a una base Postgres 16 vacía (ver `.env.example`).
El `?schema=app` es necesario para que `pnpm db:pull` sea reproducible —
ver hallazgo 5 más abajo — así que es parte de la variable, no un detalle
opcional del ejemplo:

```bash
export DATABASE_URL="postgresql://usuario:clave@localhost:5432/joda?schema=app"

pnpm db:migrate   # aplica migrations/*.sql en orden, y encadena pnpm db:pull
pnpm db:pull      # prisma db pull + parche de schema + prisma generate
pnpm db:seed      # aplica seed/*.sql (idempotente)
pnpm db:reset     # DROP SCHEMA app, public + db:migrate + db:seed, desde cero
pnpm db:test      # smoke_business_flow.sql + invariants.sql, con aserciones
```

Estos scripts (`packages/db/scripts/`) corren el SQL con el driver `pg` de
Node, sin depender de que `psql` esté instalado — pensado para que ande
igual en Windows sin cliente de Postgres y en CI (`.github/workflows/ci.yml`,
job `db`, con un servicio `postgres:16`). `db:test` no se conforma con que no
haya un error de SQL: `invariants.sql` atrapa sus propias excepciones y las
registra en una tabla en vez de relanzarlas, así que el runner falla si el
conteo de invariantes en verde no es exactamente `EXPECTED_INVARIANT_COUNT` (hoy 78), y en
`smoke_business_flow.sql` verifica en código que `v_balance_drift` da cero
filas y que el asiento de la venta cuadra.

**`pnpm db:seed` por sí solo no crea filas en `roles` ni en
`chart_of_accounts` para ningún tenant.** `seed/0001_seed_base.sql` carga el
catálogo global de `permissions` (no es por tenant) y define tres funciones
reutilizables — `app.seed_chart_of_accounts(tenant)`,
`app.seed_roles(tenant)`, `app.seed_posting_rules(tenant)` — pero no las
invoca: no hay un tenant todavía. Instanciarlas para un tenant es parte del
onboarding (Bloque C), y hoy la única llamada existente vive en
`tests/smoke_business_flow.sql`, con el tenant fijo
`11111111-1111-1111-1111-111111111111`. Por eso la matriz de roles
(`owner`/`manager`/`vendedor`/`deposito`) de `docs/security-spec.md` §2.1 se
verifica corriendo `pnpm db:test` (que ejecuta ese smoke test), no apareciendo
sola después de `pnpm db:reset && pnpm db:seed`.

**`pnpm db:reset` no regenera `schema.prisma`.** Aplica las migraciones
llamando directamente a la función de Node (`tasks.mjs`), no al script de
pnpm `db:migrate`, así que el encadenamiento con `db:pull` no se dispara.
Después de un `db:reset` en un entorno donde vayas a tocar el cliente
generado, corré `pnpm db:pull` aparte. En la práctica no suele hacer
falta: `db:reset` vuelve a aplicar las mismas migraciones ya introspeccionadas,
así que el `schema.prisma` commiteado ya coincide.

Equivalente manual con `psql`, sin pasar por Node (mismo orden, mismos
archivos):

```bash
createdb joda
for f in migrations/0*.sql seed/0001_seed_base.sql; do
  psql -d joda -v ON_ERROR_STOP=1 -f "$f"
done

# opcional: verificar a mano, leyendo la salida
psql -d joda -f tests/smoke_business_flow.sql
psql -d joda -f tests/invariants.sql
```

## Por qué SQL-first y no `prisma migrate`

Prisma no puede expresar buena parte de lo que sostiene este esquema: constraint triggers diferidos (el cuadre de asientos, el cuadre de capas de costo), políticas RLS, dominios, columnas generadas, `CHECK` compuestos, FK compuestas para la coherencia de verticales. Si el esquema lo define Prisma, todo eso desaparece o queda en `migration.sql` editado a mano, que es lo peor de ambos mundos.

El flujo correcto es el inverso: **el SQL es la fuente de verdad, Prisma es el cliente tipado**.

```bash
export DATABASE_URL="postgresql://.../joda?schema=app"
pnpm db:pull   # prisma db pull + parche de schema (ver hallazgo 4) + prisma generate
```

`pnpm db:pull` se corre después de cada migración — encadenado automáticamente desde `pnpm db:migrate`, para que nadie tenga que acordarse — y el `schema.prisma` resultante (más `prisma/views/**/*.sql`, que introspección escribe para las vistas) se commitea. Prisma no gestiona el ciclo de migraciones, lo refleja.

**Por qué Prisma 6.19.3 y no la versión `latest` de npm.** Al implementar WP-B04, la tag `latest` de `prisma`/`@prisma/client` en npm resolvía a Prisma 7 (`prisma` en particular a un release candidate, `8.0.0-rc.15`). Prisma 7 elimina el soporte de `datasource.url = env("DATABASE_URL")` para el CLI — `prisma db pull` falla con:

```
Error: Prisma schema validation - (get-config wasm)
Error code: P1012
error: The datasource property `url` is no longer supported in schema files.
Move connection URLs for Migrate to `prisma.config.ts` and pass either
`adapter` for a direct database connection or `accelerateUrl` for
Accelerate to the `PrismaClient` constructor.
```

Migrar a ese modelo (`prisma.config.ts` + un driver adapter tipo `@prisma/adapter-pg` en el `PrismaClient`) es un cambio de arquitectura real, no cubierto por este ADR ni documentado en ningún lado del repo. Se fijó **6.19.3** (última 6.x estable) para no adoptarlo de paso en un WP cuyo alcance es solo introspección. Si en el futuro se decide migrar a Prisma 7+, esa decisión necesita su propio ADR — actualiza esta nota y el bloque de comandos de arriba cuando eso pase.

---

## Hallazgos de la implementación

Tres cosas que no aparecieron en ninguno de los cuatro documentos de arquitectura y que solo salieron al ejecutar el esquema.

### 1. Un lote no puede cambiar de unidad de medida

Un frasco sellado es 1 unidad. Un frasco abierto es 125 mililitros. **No es el mismo lote**: no se pueden restar mililitros de un lote medido en unidades sin mezclar peras con ml, y cualquier atajo ahí destruye la trazabilidad del Kardex.

La apertura de un frasco es una **conversión**, no un cambio de estado:

```
lote sellado (unit)          lote granel (ml)
  transfer_out −1  ────────►   transfer_in +125
  status = open_for_decant     parent_lot_id = lote sellado
  1.496.500 Gs.                11.972 Gs./ml
```

Esto obligó a agregar `variant_type = 'bulk'` y `inventory_lots.parent_lot_id`. Sin esa conversión explícita, el modelo de decants no cierra.

### 2. `ON CONFLICT DO UPDATE` no protege contra un `CHECK`

La proyección de saldos estaba escrita así:

```sql
INSERT INTO inventory_balances (lot_id, ..., on_hand) VALUES (NEW.lot_id, ..., NEW.qty)
ON CONFLICT (lot_id) DO UPDATE SET on_hand = inventory_balances.on_hand + EXCLUDED.on_hand;
```

Parece correcto y falla en la primera salida de stock. PostgreSQL evalúa los `CHECK` de la fila propuesta **antes** de detectar el conflicto por índice único, así que `on_hand = -10` viola `balance_non_negative` y aborta antes de que el `ON CONFLICT` llegue a sumar.

La corrección: la fila de saldo nace en cero junto con el lote (trigger sobre `inventory_lots`), y la proyección es siempre un `UPDATE` puro. Beneficio adicional no buscado: desaparece la carrera entre dos movimientos concurrentes creando la misma fila de saldo.

### 3. La merma estimada estaba 75% por debajo de la real

En el flujo de prueba, con `waste_factor = 2%` sobre 10 ml la merma esperada es 0,200 ml. La merma real registrada fue 0,350 ml. La vista `v_decant_yield` lo expone como `actual_over_expected = 1.75`.

Con números reales de un frasco de nicho, esa diferencia son unos 1.800 Gs. por decant. Sobre cientos de decants al año es plata que hoy no aparece en ningún reporte. Por eso la orden de fraccionamiento separa merma esperada de merma real: el porcentaje sirve para reservar stock, el registro real sirve para saber cuánto cuesta de verdad.

### 4. La FK compuesta de las verticales rompe `prisma generate`, no `prisma db pull`

La introspección (`prisma db pull`) sale bien y produce los 61 modelos exactos. `prisma generate` sí falla, con `P1012`, sobre `accessory_details`, `perfume_details` y `watch_details`: cada una tiene `product_id` como `PRIMARY KEY` y además una FK compuesta `(product_id, kind) → products(id, kind)` (la que impide mezclar verticales, `docs/data-model.md` §8). Como `product_id` ya es único, `(product_id, kind)` también lo es por transitividad — pero Prisma introspecciona unicidad de forma literal, no transitiva, y sin una anotación `@@unique` explícita en el modelo trata la segunda relación como uno-a-uno inválido.

La solución **no** es un índice `UNIQUE(product_id, kind)` real en Postgres — sería puramente redundante y un cambio de esquema fuera del alcance de este WP para resolver una limitación de la herramienta, no del modelo de datos. En cambio, `pnpm db:pull` corre `scripts/patch-prisma-schema.mjs` entre la introspección y `prisma generate`: detecta cualquier modelo con una relación `fields: [product_id, kind], references: [id, kind]` y le agrega `@@unique([product_id, kind])` antes de generar. Es determinístico y corre en cada `db:pull`, así que no depende de que alguien lo re-edite a mano después de que la introspección reescriba `schema.prisma` (que es exactamente lo que ADR-018 prohíbe). La próxima vertical que se agregue con el mismo patrón (`docs/data-model.md` §8) queda cubierta sin tocar el script. Si el parche no se puede aplicar (el formato de introspección cambió y el regex ya no matchea), el script corta con exit 1 en vez de escribir un `schema.prisma` a medias — y `scripts/verify-prisma-client.mjs`, que corre al final de `db:pull`, falla si el cliente generado no expone la misma cantidad de modelos y vistas que declara `schema.prisma`. El criterio de aceptación de WP-B04 ("el cliente compila y expone los 61 modelos") queda protegido en cada corrida, no solo comprobado una vez a mano — y el job `db` del CI corre `pnpm db:pull` después de `pnpm db:reset` y falla si el resultado no coincide con lo commiteado (`git diff --exit-code`), así que una migración nueva sin su `schema.prisma` actualizado no pasa el PR.

**Generalizado en WP-B08c.** Las FKs compuestas con `tenant_id` (`0023_cross_tenant_fks.sql`) repiten el caso en cuatro relaciones uno a uno: `(product_id, tenant_id)` en las tres tablas de detalle y `(lot_id, tenant_id)` en `inventory_balances`. Un `UNIQUE` real en Postgres no sirve: Prisma lo omite por contener al `@id`. El parche ahora agrega `@@unique` a toda relación de más de un campo cuyo primer campo es el `@id` de una sola columna del modelo. Efecto en la API: los campos de relación de detalle pasaron a llamarse `*_details_*_product_id_tenant_idToproducts` (`modules/catalog`).

### 5. La introspección de vistas no es reproducible sin fijar el `search_path`

`prisma db pull` con la preview feature `views` escribe el SQL de cada vista (`prisma/views/**/*.sql`) tal como Postgres lo reconstruye con `pg_get_viewdef()`. Esa función solo omite el prefijo de esquema en los nombres de tabla que están en el `search_path` **de la conexión que hace la introspección** — no es una propiedad de la vista en sí. Con `DATABASE_URL` sin `?schema=app`, el `search_path` por defecto es `"$user", public`, así que `app.inventory_lots` sale calificado; con `?schema=app`, Prisma antepone `app` al `search_path` y la misma vista sale como `inventory_lots` a secas.

En la práctica, esto significa que dos personas corriendo `pnpm db:pull` contra el mismo esquema, con la única diferencia de si su `DATABASE_URL` local tiene o no `?schema=app`, terminan committeando un `prisma/views/**/*.sql` distinto — puro ruido de diff, pero suficiente para que el chequeo de drift del CI (hallazgo 4) falle por una razón que no tiene nada que ver con el esquema. Por eso `?schema=app` dejó de ser un detalle del ejemplo en "Cómo correrlo" y pasó a ser parte de `DATABASE_URL` en todos lados — incluido el `DATABASE_URL` del job `db` en `.github/workflows/ci.yml`.

### 6. Testcontainers (WP-B05): qué deja listo `startTestDb()` y qué no

`test/setup/db.ts` expone `startTestDb()`: levanta un `postgres:16` real vía `@testcontainers/postgresql`, corre `applyMigrations` + `applySeeds` (las mismas funciones que usa `pnpm db:reset`, no una copia) y devuelve un `pg.Client` ya conectado. Se llama una sola vez por archivo de test, en `beforeAll` — recrear el contenedor en cada `it()` es lo que hace que una corrida tarde minutos en vez de segundos.

**No deja un tenant con roles instanciados.** Igual que `pnpm db:seed` a secas (ver el aviso más arriba en este README), `seed/0001_seed_base.sql` solo carga el catálogo global de `permissions`; no invoca `app.seed_roles`, `app.seed_chart_of_accounts` ni `app.seed_posting_rules` para ningún tenant. Un test de integración que necesite un tenant real con roles y plan de cuentas (la prueba de aislamiento RLS de WP-B06, por ejemplo, que se conecta como `joda_api` con `tenant_id` en contexto) tiene que invocar esas funciones — o cargar `tests/smoke_business_flow.sql`, que sí lo hace con el tenant fijo `11111111-1111-1111-1111-111111111111` — dentro de su propio `beforeAll`, después de `startTestDb()`. No se resolvió acá porque la mayoría de los tests de integración (el ejemplo de este WP incluido) no necesitan un tenant instanciado, y adelantarlo sin un consumidor real hubiera sido diseñar a ciegas para WP-B06.

**Si `applyMigrations`/`applySeeds` falla a mitad de camino, `startTestDb()` detiene el contenedor antes de relanzar el error** — sin eso, una migración rota dejaba un contenedor huérfano por cada corrida fallida (mitigado parcialmente por Ryuk, el limpiador de Testcontainers, pero no de inmediato).

### 7. Docker Compose (WP-B07): el puerto de host de Postgres es 55432, no 5432

`infra/docker/docker-compose.yml` publica Postgres en `55432:5432` — adentro
del contenedor sigue siendo 5432 (lo que importa para que coincida con lo
validado en "Verificación" más arriba), pero el puerto del **host** no es el
default. Se encontró en la práctica al correr la verificación de este WP en
una máquina de desarrollo Windows con Postgres ya instalado como servicio
nativo (`Get-Service PostgreSQL`, escuchando en `127.0.0.1:5432`): Windows
prioriza esa dirección específica sobre el `0.0.0.0:5432` que publica el
proxy de Docker, así que `localhost:5432` termina hablando con el servicio
nativo, no con el contenedor — y el error (`password authentication failed
for user "postgres"`) no menciona Docker para nada, así que sin este
hallazgo cuesta diagnosticar. Publicar en `5432:5432` funciona sin problema
en una máquina sin Postgres nativo (así corre el job `db` de CI, en un
runner limpio) pero rompe silenciosamente apenas hay uno — y detenerlo no es
una opción: puede estar ahí para otra cosa que no tiene nada que ver con
este repositorio. `DATABASE_URL` de `.env.example` ya apunta a `55432`.

**`packages/db/package.json` tiene `"lint": "eslint test"`, no `"eslint ."`.** Lintear todo el paquete saca a la luz ~20 errores preexistentes en `scripts/*.mjs` (`console`/`process` sin `languageOptions.globals` de Node en `packages/config/eslint/index.js`, que hasta este WP nunca linteaba estos scripts porque `packages/db` no tenía script `lint`). No es una regla de negocio ni algo que WP-B05 causó: es deuda preexistente, fuera de alcance de este WP, y se anota acá en vez de arreglarse de paso.

### 8. Cómo conectarse como `joda_api` de verdad (WP-B06 lo resolvió en el test; WP-C02 lo resolvió para runtime)

`joda_api` se crea en `migrations/0010_security_rls.sql` con `LOGIN NOBYPASSRLS` pero **sin password** — a una migración de esquema no le corresponde fijar un secreto.

**Decisión tomada en WP-C02 (ya no pendiente):** la credencial de runtime se provisiona en `seed/0002_seed_joda_api_credential.sql` (`ALTER ROLE joda_api PASSWORD '...'`, idempotente, password fija de desarrollo — igual de sensible que `POSTGRES_PASSWORD=postgres` en `infra/docker/docker-compose.yml`, no un secreto real). `apps/api` se conecta con ella vía `DATABASE_URL_API` (ver `.env.example`), nunca vía `DATABASE_URL` (reservada a migraciones/ETL, el equivalente local de `service_role`). Al arrancar, `apps/api` valida con Zod que `DATABASE_URL_API` esté definida — sin fallback a `DATABASE_URL` — y confirma contra `pg_roles.rolbypassrls` que la credencial conectada no elude RLS antes de aceptar tráfico; cualquiera de las dos cosas que falle aborta el arranque. En producción esa password sale del gestor de secretos, fuera del alcance de WP-C02, cubierto por WP-F00.

`test/integration/rls_isolation.test.ts` (WP-B06, anterior a que el seed provisionara la credencial) resuelve la misma necesidad de otra forma: después de `startTestDb()` (que conecta como el superusuario `test` del contenedor de Testcontainers) corre su propio `ALTER ROLE joda_api PASSWORD '...'` con una password de un solo uso, y recién ahí abre una **segunda conexión** (`pg.Client` propio) autenticada como `joda_api` contra el mismo contenedor. Esa segunda conexión, no la del superusuario, es la que ejecuta las cuatro aserciones del test. Sigue siendo válido después de WP-C02 — no se tocó ese test — pero un test nuevo que necesite `joda_api` puede apoyarse directamente en el seed en vez de repetir el `ALTER ROLE` ad hoc, como hace `apps/api/src/db/withTenantTx.test.ts`.

La alternativa obvia — reusar la conexión superusuario y hacer `SET LOCAL ROLE joda_api` dentro de cada transacción — habría sido más simple y en la práctica evalúa RLS/grants igual de bien (Postgres decide permisos por `current_user`, no por `session_user`, así que `SET ROLE` cambia esa identidad tan efectivamente como una reautenticación). Se descartó de todas formas: la trampa explícita del WP de origen (`docs/testing-strategy.md` §3.2) es que el test tiene que conectarse como `joda_api`, no como el superusuario — y una conexión que en su session log sigue siendo la del superusuario, aunque técnicamente evalúe permisos como si no lo fuera, es más frágil ante una futura refactorización del test que la cambie de lugar sin darse cuenta de por qué importaba. Una segunda conexión autenticada de verdad no deja esa ambigüedad, y es además el mismo patrón que usa el pool de `apps/api` en producción.

La password de `rls_isolation.test.ts` vive solo en el contenedor efímero de esa corrida de test — nunca en un archivo versionado — y se pierde con el contenedor al terminar. La de `seed/0002_seed_joda_api_credential.sql` sí está versionada, a propósito: es de desarrollo, no un secreto de producción.

### 9. Una función `SECURITY DEFINER` con un parámetro `citext` no se puede llamar desde Prisma sin un cast — y el cast tampoco es gratis (WP-C03)

`app.find_staff_login_by_email` (`migrations/0011_staff_sessions.sql`, luego corregida en `0012_fix_staff_login_lookup_param_type.sql`) necesitaba buscar `staff_users` por email **antes** de que exista `tenant_id` en contexto — el mismo problema que resuelve `has_permission()` (`0002_identity_rbac.sql`), aplicado al login en vez de a permisos. Se declaró en un primer momento con `p_email citext`, calcando el tipo de la columna `staff_users.email`.

Eso rompe en dos pasos:

1. **`db.$queryRaw\`...find_staff_login_by_email(${email})\``falla con`42883`("function ... does not exist").** Prisma manda el parámetro como`text`sin un OID concreto, y Postgres no resuelve la sobrecarga`(citext)` a partir de eso — hace falta un cast explícito en el sitio de la consulta.
2. **El cast obvio, `${email}::citext`, falla con `42501` ("permission denied for schema public").** `citext` vive en `public` (la extensión se crea antes del primer `SET search_path = app, public` de `0001_foundation.sql`), y `joda_api` solo tiene `USAGE` sobre `app` (`0010_security_rls.sql`) — nombrar un tipo de `public` en un cast, aunque no se toque ninguna tabla de ese schema, exige ese `USAGE`.

La salida no es dar `USAGE ON SCHEMA public TO joda_api` (ampliar el acceso de la credencial de runtime para esquivar un error de tipos es exactamente el tipo de atajo que `docs/security-spec.md` §3.1 existe para evitar). Es declarar el parámetro de la función como `text`, no `citext`: `email = p_email` dentro de la función igual resuelve al operador `citext = text` que la extensión ya define, así que la comparación sigue siendo case-insensitive — lo único que cambia es la firma. `app.find_staff_refresh_token` (misma migración) no tuvo este problema porque su parámetro ya era `text` desde el principio (compara contra un hash, no contra la columna `citext`).

### 10. `CREATE OR REPLACE FUNCTION` no sirve para agregarle columnas al `RETURNS TABLE` de una función existente (WP-C04)

`0013_staff_mfa.sql` necesitaba que `app.find_staff_login_by_email` y `app.find_staff_refresh_token` (`0011_staff_sessions.sql`, `0012_fix_staff_login_lookup_param_type.sql`) devolvieran columnas nuevas (`mfa_enrolled`, `session_mfa_verified_at`) — son `SECURITY DEFINER` que corren antes de que exista `tenant_id` en contexto (mismo motivo que el hallazgo 9), así que no hay forma de pedir esas columnas con una consulta aparte.

El primer intento fue `CREATE OR REPLACE FUNCTION ... RETURNS TABLE (...)` con la lista de columnas ampliada. Postgres lo rechaza: `cannot change return type of existing function` — `CREATE OR REPLACE` solo tolera cambiar el cuerpo, nunca la firma de salida, ni siquiera para agregar columnas al final. Es el mismo problema que forzó el `DROP FUNCTION` + `CREATE FUNCTION` de `0012_fix_staff_login_lookup_param_type.sql` para cambiar un parámetro de `citext` a `text` — ahí cambiaba la entrada, acá la salida, pero la regla de Postgres es la misma: cualquier cambio de firma (entrada o salida) exige borrar la función vieja primero.

`REVOKE ALL ... FROM PUBLIC` y `GRANT EXECUTE ... TO joda_api` tampoco sobreviven al `DROP` — hay que repetir las dos sentencias después del `CREATE`, si no la función nueva queda ejecutable por `PUBLIC` (el default de Postgres para toda función nueva) hasta el próximo deploy que lo note.

### 11. Una FK no aísla por tenant — ni siquiera cuando el padre sí tiene RLS (WP-B08)

La revisión cruzada de WP-C09 encontró que `product_media` no tenía `tenant_id`: `0010_security_rls.sql` habilita RLS recorriendo columnas `tenant_id`, y esa tabla no tenía ninguna, así que no entró al bucle. La intuición de que la FK `product_id → products.id` "hereda" el aislamiento de `products` (que sí tiene RLS) es falsa: los checks de integridad referencial de Postgres se evalúan con privilegio interno, sin pasar por las políticas de RLS de la sesión — un `product_id` de otro tenant pasa la FK igual, sea cual sea el rol conectado.

`0014_rls_sweep.sql` (WP-B08) barrió las 25 tablas de `app.*` que estaban en esa misma situación: 23 recibieron `tenant_id` propio (retrocompletado desde el padre correspondiente vía `UPDATE ... FROM`, después `NOT NULL` + FK a `tenants`) y entraron al mismo bucle de RLS; dos quedaron exentas por diseño (`tenants`, que no puede tener su propio `tenant_id`, y `permissions`, catálogo global). `packages/db/tests/invariants.sql` (invariante 22) verifica que no quede ninguna otra: falla si aparece una tabla de `app.*` sin RLS y sin estar en esa lista de dos.

**Consecuencia para código de aplicación que ya insertaba en alguna de esas 23 tablas** (WP-C08, catálogo: `perfume_details`/`accessory_details`/`product_categories`/`product_tags`; WP-C09, `product_media`): esos `INSERT` pasaron a fallar por `NOT NULL` en `tenant_id` hasta que se les agregó el valor explícito — Prisma no lo infiere solo. Y **RLS en la tabla hija no reemplaza verificar la pertenencia del padre**: seguía haciendo falta un `findX` tenant-scoped antes de insertar (mismo patrón que `findProductRow` de `createVariant`, WP-C08) para las columnas que aceptan un id de OTRA tabla protegida — `categoryId`/`tagId` en catálogo, `productId`/`variantId` en medios —, porque RLS en la fila hija solo protege que ESA fila sea legible/escribible por el tenant correcto, no evita insertarla apuntando por FK a un id ajeno.

### 12. `ALTER DEFAULT PRIVILEGES ... ON TABLES` también alcanza a las vistas (WP-B16)

No existe `ON VIEWS`: el default de `0010_security_rls.sql` que concede INSERT, UPDATE y DELETE a `joda_api` sobre lo que se cree en `app` cubre tablas y vistas por igual, así que toda vista nueva nace con escritura. `0027_revoke_views_write.sql` lo revocó en las cuatro que había. Para las que vengan no hay default que lo evite: la migración que crea la vista tiene que revocar la escritura, y el invariante 78 (`tests/invariants.sql`) falla y nombra la vista si se olvida.

---

## Decisiones no obvias del esquema

**El ledger es inmutable, y ni la API puede tocarlo.** `REVOKE UPDATE, DELETE ... FROM joda_api`, más triggers que rechazan la operación. La corrección de un error es un movimiento de ajuste, no una edición.

**La API se conecta con un rol `NOBYPASSRLS`.** Si la API usara la `service_role` de Supabase o el owner de las tablas, RLS no se evaluaría y sería decorativo. `service_role` queda solo para migraciones y ETL, ejecutados desde CI. Verificado: `joda_api` sin `tenant_id` en contexto ve cero filas, con otro tenant ve cero filas, y su `UPDATE` sobre el ledger recibe `permission denied`.

**El IVA se calcula sobre precio con impuesto incluido**, que es el régimen paraguayo: 10% → `total/11`, 5% → `total/21`. La función `app.vat_from_gross()` es el único lugar donde vive esa regla, y `app.round_pyg()` el único donde vive el redondeo. Duplicar cualquiera de las dos es garantía de descuadre en el XML de SIFEN.

**Los asientos se derivan, no se cargan.** `posting_rules` guarda plantillas declarativas por evento de negocio, y nacen **apagadas**. Mientras una regla esté apagada, el evento cae en `unposted_events`: visible y reprocesable, nunca perdido en silencio. Un ERP que exige saber contabilidad para operar es un ERP que no se usa.

**La seña es pasivo.** `customer_deposits` acredita `2.1.02.001 Señas de clientes`, no una cuenta de ingreso. El `CHECK` impide aplicar o devolver más de lo recibido.

**El carrito no reserva stock.** La reserva nace al iniciar el checkout, con TTL según medio de pago. Reservar al agregar al carrito permite que cualquiera bloquee inventario de piezas únicas abriendo pestañas.

**El PAN nunca entra a la base.** `payments` guarda `card_last4` y `card_brand`, que no son datos de tarjeta bajo PCI. El checkout es hospedado. La diferencia entre SAQ A y SAQ D es la diferencia entre un formulario y una auditoría anual.

**Los webhooks son idempotentes por esquema.** `UNIQUE (provider, external_event_id)` en `payment_events`. Bancard reintenta; sin esa restricción, un reintento confirma dos veces la misma venta.

**Agregar una vertical es una migración, no una reescritura.** `ALTER TYPE product_kind ADD VALUE 'x'` + `CREATE TABLE x_details` con la FK compuesta `(product_id, kind)`. Verificado: intentar cargar `perfume_details` sobre un producto `watch` es rechazado por la base.

---

## Pendiente antes de producción

1. **Confirmar el grupo SIFEN del RUC.** Condiciona si `fiscal_documents` se activa en el MVP o después.
2. **Validar el plan de cuentas con el contador.** El de `seed/` es una base razonable para retail paraguayo, no una verdad revelada.
3. **Definir el criterio de prorrateo de flete por defecto** (`by_value` está puesto como default) y documentarlo en un ADR.
4. **Contratar PITR y hacer un simulacro de restauración** a un proyecto nuevo, antes de migrar datos reales. Un backup que nunca se restauró es una creencia.
5. **Job nocturno sobre `v_balance_drift`.** Si devuelve filas, algo se escribió por fuera del flujo.
