# Entorno local de punta a punta

Cómo levantar JODA en tu máquina con Windows y entrar al admin con cada rol: Postgres, Redis, un Auth local (GoTrue), la API, el servidor de medios y el admin, con datos de muestra. WP-M18.

Lo que queda funcionando al terminar:

- El **mismo adaptador de Supabase Auth** que usará producción (`supabasePasswordProvider.ts`, sin cambios) contra un **GoTrue local** de versión fija. No hay ningún proveedor de auth falso en el arranque de la API.
- **Un usuario por rol** (dueño, encargado, vendedor, depósito), cada uno con su segundo factor ya inscripto.
- **Datos de muestra** creados por la API: tres perfumes con frasco sellado, granel y decants, un reloj Casio serializado, un proveedor, una orden de compra y stock recibido.
- Un **humo de Playwright** (`pnpm e2e:smoke`) que entra con cada rol, navega el catálogo, crea un producto y comprueba que el vendedor no ve costos.

> **Todo esto es solo para desarrollo en tu máquina.** Los usuarios tienen contraseñas conocidas (están abajo, en este mismo archivo). Los scripts se niegan a correr con `NODE_ENV=production` o `JODA_ENV=production` (en cualquier grafía: `Production`, ` production`…) y contra cualquier servidor que no sea `localhost`/`127.0.0.1`; el humo de Playwright también, aunque lo corras a mano con `playwright test`. Nunca reutilices estas contraseñas en un entorno real.

---

## 1. Requisitos

| Qué                    | Detalle                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Node                   | 22.9 o más (`node -v`): la API arranca con `--env-file-if-exists`, que apareció en 22.9.                                             |
| pnpm                   | 9 o más. `pnpm -v`.                                                                                                                  |
| Git                    | Con `git config core.hooksPath .githooks` (ver `CONTRIBUTING.md` §1).                                                                |
| **Docker Desktop**     | Abierto y en «Engine running» antes de empezar. Con el backend WSL 2, el predeterminado.                                             |
| **Chrome o Edge**      | Para el admin y para las imágenes: `media.localhost` solo resuelve a tu máquina en navegadores Chromium. En Firefox/Safari no carga. |
| Espacio y red          | ~1,5 GB de imágenes de Docker la primera vez y ~120 MB de Chromium para Playwright (`pnpm e2e:smoke`).                               |
| Carpeta del repo corta | `C:\dev\joda`, no una ruta larga: `node_modules` de pnpm supera el límite de rutas de Windows en carpetas profundas.                 |

No hace falta instalar Postgres, Redis ni Supabase: todo corre en contenedores.

## 2. Primera vez

```powershell
git clone <repo> C:\dev\joda ; cd C:\dev\joda
git config core.hooksPath .githooks
pnpm install
pnpm dev:setup
pnpm dev
```

`pnpm dev:setup` tarda unos minutos la primera vez (baja imágenes y compila los paquetes). Hace, en orden:

1. Escribe **`.env.local`** (no versionado) con **secretos al azar por máquina**: `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`, el secreto de firma de GoTrue, la contraseña de `joda_api` y las dos claves de Supabase (JWT con rol `anon` y `service_role`, firmados con ese secreto). Si el archivo ya existe, **conserva los secretos**.
2. Levanta con `docker compose` Postgres 16, Redis 7, **GoTrue** (`supabase/gotrue`, versión fija) y un **nginx** mínimo que lo expone en `/auth/v1` y exige la cabecera `apikey`, como el gateway de Supabase. Espera a que los cuatro estén sanos.
3. **Comprueba que no borra lo que no creó él** (ver el aviso de abajo) y corre **`pnpm db:reset`**: borra y recrea toda la base `joda` (migraciones + seed base). Fija la contraseña de `joda_api` (la del `.env.local`) con un `ALTER ROLE` del setup. **Vacía también el Redis del proyecto** (sesiones y permisos en caché de una base anterior no valen).
4. Da de alta los cuatro usuarios **en GoTrue** (Admin API, correo confirmado) y **en `staff_users`**, con su rol, en el tenant `joda`.
5. Levanta la API un rato y **siembra por la API** (HTTP + tRPC, con la sesión del dueño) el segundo factor de los cuatro usuarios y los datos de muestra. La apaga al terminar.

**Es re-ejecutable.** Cada corrida termina en el mismo estado, con la base reiniciada. Si solo querés reponer los datos de muestra sin tocar la base, con la API ya levantada (`pnpm dev`): `pnpm dev:seed`.

> **Ojo:** `pnpm dev:setup` **borra todo el contenido** de la base `joda` y del Redis de su proyecto de compose. Con los valores por defecto (proyecto `joda`, puertos `55432` y `6379`) esos son el Postgres y el Redis de desarrollo de siempre: si tenés datos que querés conservar ahí, hacé un `pg_dump` antes.
>
> Para que no se lleve por delante lo que no creó él, el setup deja una **marca** (un comentario en la base `joda` y la clave `joda:dev-setup` en Redis). Un reinicio sobre una base o un Redis **con la marca** sigue sin preguntar; sobre una base con tablas o un Redis con claves **sin marca** (la primera vez sobre un entorno que armaste a mano) pide confirmación: en una terminal, escribí `si`; en un script o sin terminal, repetí con `pnpm dev:setup --yes` o con `JODA_DEV_SETUP_YES=1`. Sin eso se niega y no borra nada. Una base vacía o que no existe todavía no pregunta.

## 3. Qué quedó corriendo

Valores por defecto (los del entorno de siempre). Todos los puertos de host se publican **solo en `127.0.0.1`**.

| Qué                          | Dónde                                                      | Variable para moverlo  |
| ---------------------------- | ---------------------------------------------------------- | ---------------------- |
| Admin (Vite)                 | http://localhost:5173                                      | `JODA_ADMIN_PORT`      |
| API (Fastify + tRPC)         | http://localhost:3333                                      | `JODA_API_PORT`        |
| Servidor de medios           | http://media.localhost:3334 (otro _host_ que el de la API) | `JODA_MEDIA_PORT`      |
| Postgres 16                  | `127.0.0.1:55432`, base `joda`                             | `JODA_PG_PORT`         |
| Redis 7                      | `127.0.0.1:6379`                                           | `JODA_REDIS_PORT`      |
| Auth local (proxy + GoTrue)  | `http://127.0.0.1:54321/auth/v1`                           | `JODA_SUPABASE_PORT`   |
| Proyecto de `docker compose` | `joda` (contenedores `joda-postgres-1`, `joda-redis-1`, …) | `JODA_COMPOSE_PROJECT` |

**Para mover un puerto o tener dos entornos a la vez**, fijá las variables al correr el setup (se guardan en `.env.local`):

```powershell
$env:JODA_COMPOSE_PROJECT = "joda-otro"; $env:JODA_PG_PORT = "55640"; $env:JODA_REDIS_PORT = "55641"
$env:JODA_SUPABASE_PORT = "55642"; $env:JODA_API_PORT = "3433"; $env:JODA_MEDIA_PORT = "3434"; $env:JODA_ADMIN_PORT = "5273"
pnpm dev:setup
```

Los contenedores de las pruebas automáticas (Testcontainers usa puertos aleatorios) no chocan con estos. Si ya tenés otros contenedores de Postgres o Redis en tu máquina, elegí puertos que estén libres (`docker ps`).

**La API conecta siempre como `joda_api`** (`NOBYPASSRLS`, la credencial `DATABASE_URL_API`) y escucha solo en `127.0.0.1` (`API_HOST`). El superusuario (`DATABASE_URL`) y la clave de servicio de Supabase (`SUPABASE_SERVICE_ROLE_KEY`) los usan el setup, el seed y los scripts de `packages/db` para migrar y sembrar; la API **no los usa**: el código solo lee `DATABASE_URL_API`, y `assertRlsNotBypassed` aborta el arranque si esa conexión pudiera saltarse RLS. Ojo, sin embargo: `pnpm dev` carga el `.env.local` entero con `--env-file-if-exists`, así que esas dos variables **sí quedan en el entorno del proceso de la API** aunque nada las lea. Separarlas en otro archivo es el trabajo pendiente WP-M20 (`docs/backlog.md`).

## 4. Usuarios de prueba

| Rol        | Correo               | Contraseña              | Qué ve                                                     |
| ---------- | -------------------- | ----------------------- | ---------------------------------------------------------- |
| `owner`    | `owner@joda.test`    | `JodaDev-owner-2026`    | Todo: catálogo, contabilidad, sourcing.                    |
| `manager`  | `manager@joda.test`  | `JodaDev-manager-2026`  | Todo salvo gestión de usuarios.                            |
| `vendedor` | `vendedor@joda.test` | `JodaDev-vendedor-2026` | Catálogo en lectura. Sin contabilidad, sourcing ni costos. |
| `deposito` | `deposito@joda.test` | `JodaDev-deposito-2026` | Catálogo en lectura. Sin precios de compra ni márgenes.    |

**Segundo factor (TOTP).** El personal lo tiene obligatorio (WP-C04), así que después de la contraseña el admin pide un código de 6 dígitos. El setup inscribe el de los cuatro usuarios **con un secreto al azar por máquina** (no hay un código de desarrollo común: lo genera la API al inscribir y queda en `.data/dev/totp-secrets.json`, ignorado por git). Para sacar el código:

```powershell
pnpm dev:totp owner        # 758110   (vence en 20 s)
pnpm dev:totp              # los de los cuatro roles
```

Se acepta el código de la ventana anterior y de la siguiente (±30 s). Si preferís una app autenticadora en el teléfono, el secreto en base32 está en ese JSON.

## 5. Entrar al admin con cada rol

1. Abrí http://localhost:5173 en Chrome o Edge.
2. Correo y contraseña de la tabla de arriba → «Ingresar».
3. «Verificar segundo factor»: pegá el resultado de `pnpm dev:totp <rol>` → «Verificar».
4. Probá con otro rol (en una ventana de incógnito o después de «Salir») y compará lo que cada uno ve: el menú de arriba depende de los permisos de la sesión, y la API los vuelve a comprobar.

La cookie de sesión (`__Host-joda_a`, `httpOnly`, `Secure`, `SameSite=Strict`) funciona sobre `http://localhost` porque Chrome y Edge tratan `localhost` como origen seguro. El admin y la API comparten origen para el navegador: el servidor de desarrollo de Vite reenvía `/trpc` y `/media/products` a la API, sin CORS.

## 6. Datos de muestra

Creados **por la API** con la sesión del dueño (pasan por autorización, RLS, auditoría y reglas de dominio):

- Categorías `perfumes` y `relojes`.
- **Layton** (Parfums de Marly, EDP 125 ml): sellado `LAYTON-125`, granel `LAYTON-GRANEL`, decants de 5, 10 y 30 ml. **Activo y publicado**, con sus variantes visibles.
- **Aventus** (Creed, EDP 100 ml): sellado, granel, decants de 5 y 10 ml. Activo, **sin publicar**.
- **Baccarat Rouge 540** (MFK, extrait 70 ml): sellado, granel, decant de 10 ml. Activo, sin publicar.
- **Casio F-91W**, reloj que exige serie (`requires_serial`): variante `CASIO-F91W` serializada y 3 unidades (`F91W-DEV-0001` a `0003`).
- Proveedor `SUP-DEV-01` y orden de compra `OC-DEV-0001` (USD, Layton y Aventus), aprobada y enviada.
- Se **abrió un frasco de Layton** (`inventory.lot.open`): nace un lote de granel en ml que hereda el costo.

Sembrados **por SQL** (no hay API todavía; el mecanismo más fiel disponible), registrados también en el PR de WP-M18:

- **El tenant `joda` y su personal** (`staff_users` + roles): para llamar a la API hace falta ya una sesión, así que el primer usuario no puede crearse por ella. Usa las mismas funciones de siembra que la base (`seed_roles`, plan de cuentas, reglas de posteo).
- **El stock recibido**: un lote por producto con su movimiento `purchase_receipt` (el saldo lo proyecta el trigger), como lo hace la suite de integración de la API. La recepción de compras (WP-C15) todavía no existe; cuando exista, este tramo pasa a ser una llamada a la API.

No hay canales de venta (`sales_channels`): ningún WP los crea todavía (WP-C17b), así que no se pueden armar pedidos de mostrador desde el admin.

## 7. Humo de punta a punta (`pnpm e2e:smoke`)

```powershell
pnpm e2e:smoke                     # corre todo
pnpm e2e:smoke --headed            # con el navegador a la vista
pnpm e2e:smoke --grep "vendedor"   # solo lo que coincida
```

Compila los paquetes, instala Chromium de Playwright la primera vez y corre `e2e/`. Si la API y el admin ya están corriendo (`pnpm dev`) los reutiliza; si no, Playwright los levanta. Necesita el entorno sembrado (`pnpm dev:setup`).

Se puede correr **cuantas veces quieras sobre la misma base**: el humo busca los productos sembrados por nombre (paginando, no por posición en la lista) y archiva por la API los que crea, así que no se rompe a medida que la base crece.

Cubre: el ingreso de **cada rol** con contraseña y segundo factor (y los rechazos: contraseña mala, código malo, sin sesión, salir); la **lista de catálogo** sembrada y el **alta de un producto** desde el formulario; y que el **vendedor no ve costos**: ni el menú de contabilidad y sourcing, ni por URL directa, y la API le responde 404 en proveedores, órdenes de compra y costo de lotes mientras el dueño recibe el costo puesto.

**Cómo sumar pantallas** (WP-E06, WP-E07, …): un archivo `e2e/specs/<módulo>.spec.ts` por módulo del admin. `e2e/specs/catalog.spec.ts` es el modelo.

```ts
import { expect, test } from "@playwright/test";
import { apiAs } from "../helpers/api"; // cliente de la API con la sesión de un rol (datos, permisos)
import { loginAs } from "../helpers/login"; // contraseña + segundo factor por la pantalla

test.describe("<flujo> (<RF-XXX-nn, WP>)", () => {
  test("<comportamiento>", async ({ page }) => {
    await loginAs(page, "deposito");
    await page.goto("/ruta-del-modulo");
    await expect(page.getByRole("heading", { name: "…" })).toBeVisible();
  });
});
```

Si la pantalla necesita datos que la muestra no trae, se agregan **por la API** en `scripts/dev/lib/sampleData.mjs` (no en el spec). Para que el humo no envejezca, dos reglas: los productos sembrados se buscan por nombre con `findProductRow` (`e2e/helpers/catalog.ts`, que pagina hasta encontrarlos; nunca "lo que haya en la primera pantalla", porque la lista va de lo más nuevo a lo más viejo y la API no borra productos), y lo que un spec crea lleva un nombre único con un prefijo conocido y se archiva al terminar (`archiveSmokeProducts`).

**Un supuesto del humo:** los `loginAs`/`apiAs` de un mismo rol usan el mismo código TOTP dentro de su ventana de 30 s. Anda porque la API hoy acepta un código ya usado en la misma ventana. Si algún día se le agrega anti-replay (un código de un solo uso), hay que ajustar `currentTotp` en `e2e/helpers/login.ts` para esperar a la ventana siguiente.

En CI corre el job `E2E smoke (entorno local)`: levanta el mismo compose, corre `pnpm dev:setup`, el contrato de auth y el humo.

## 8. Auth local y el contrato de `StaffAuthProvider`

`pnpm test:auth-local` corre `staffAuthProvider.contract.test.ts` también contra el GoTrue local, con el adaptador real. Crea y borra su propio usuario en GoTrue (no toca a los de prueba) y se niega a correr si `SUPABASE_URL` no es de esta máquina. La corrida por defecto (`pnpm test`) sigue usando solo el proveedor falso y no toca la red.

Esto **avanza WP-C03b pero no lo cierra**: C03b es contra un proyecto real de Supabase, que nadie provisionó todavía. Falta también el flujo de MFA de Supabase (el TOTP de JODA lo hace la propia API, WP-C04, no GoTrue).

## 9. Apagar, limpiar, empezar de cero

```powershell
# apagar sin perder datos (el volumen queda)
docker compose -p joda --env-file .env.local -f infra/docker/docker-compose.yml --profile auth stop
# volver a prender
docker compose -p joda --env-file .env.local -f infra/docker/docker-compose.yml --profile auth up -d --wait
# borrar contenedores Y datos (volúmenes) de este entorno
docker compose -p joda --env-file .env.local -f infra/docker/docker-compose.yml --profile auth down -v
```

Con otro proyecto (`JODA_COMPOSE_PROJECT`), cambiá `-p joda`. Para regenerar los secretos, borrá `.env.local` y `.data/dev/` y corré `pnpm dev:setup`.

## 10. Problemas frecuentes

| Síntoma                                                                 | Causa y arreglo                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| «Docker no responde»                                                    | Docker Desktop no está abierto o sigue arrancando. Abrilo, esperá «Engine running» y repetí.                                                                                                                                                                       |
| «port is already allocated» / «El puerto N ya está en uso»              | Otro programa usa el puerto. Cerralo, o elegí otro (sección 3). En Windows, `netstat -ano \| findstr :55432` dice qué proceso. Un Postgres nativo en `5432` no choca: el compose usa `55432`.                                                                      |
| `pnpm dev` dice «Port N is already in use» (Vite)                       | Hay otro admin abierto en ese puerto (a veces solo en IPv6, `[::1]`). Vite no salta al siguiente a propósito: la URL del runbook y la del humo suponen ese puerto. Cerrá el otro o cambiá `JODA_ADMIN_PORT`.                                                       |
| «No existe .env.local»                                                  | Corré `pnpm dev:setup` primero.                                                                                                                                                                                                                                    |
| La API no arranca: «Configuración de entorno inválida»                  | Falta `.env.local` o está incompleto. `pnpm dev:setup` lo vuelve a escribir sin cambiar los secretos.                                                                                                                                                              |
| El ingreso dice «Email o contraseña incorrectos» con la contraseña bien | El Auth local no está sano (`docker ps`: `…-auth-1` y `…-auth-proxy-1` en «healthy») o la base se reinició sin recrear los usuarios. Corré `pnpm dev:setup`.                                                                                                       |
| Pide inscribir el segundo factor / «ya tiene el segundo factor»         | Se borró `.data/dev/totp-secrets.json` pero no la base. `pnpm dev:setup` recrea todo junto.                                                                                                                                                                        |
| «El código ingresado no es válido»                                      | El código vence a los 30 s: pedí uno nuevo con `pnpm dev:totp <rol>`. Si el reloj de Windows está desfasado, sincronizalo (Configuración → Hora e idioma → Sincronizar ahora). Varios intentos malos seguidos bloquean un rato (guardia de fuerza bruta en Redis). |
| Las imágenes no cargan                                                  | `media.localhost` solo resuelve a tu máquina en Chrome y Edge. En otro navegador, agregá `127.0.0.1 media.localhost` al archivo `hosts`.                                                                                                                           |
| `ENAMETOOLONG` / «path too long» al instalar o compilar                 | La ruta del repo es muy larga. Cloná en `C:\dev\joda`. En Windows 10/11 también se puede activar «Rutas largas» (`LongPathsEnabled`), pero una ruta corta evita el problema de raíz.                                                                               |
| `pnpm e2e:smoke` dice que falta el navegador                            | La primera vez baja Chromium; si falló la descarga, `pnpm --filter @joda/e2e exec playwright install chromium`.                                                                                                                                                    |
| Cambié un paquete (`packages/*`) y la API no lo ve                      | La API consume los paquetes compilados (`dist/`). `pnpm dev` los compila al arrancar; si los tocás con el servidor andando, `pnpm build --filter=@joda/domain` (o el que sea) y reiniciá la API.                                                                   |
| GoTrue no arranca: «relation … does not exist»                          | La base `gotrue` quedó a medias de una corrida cortada. `docker compose … down -v` (sección 9) y `pnpm dev:setup`.                                                                                                                                                 |
| Quiero correr `pnpm db:test` contra esta base                           | Las herramientas de `packages/db` leen `DATABASE_URL` del entorno, no de `.env.local`: copiá el valor de ese archivo a la variable de tu shell. Ojo: `db:test` es para bases descartables.                                                                         |

## 11. Qué hay dónde

| Archivo                                         | Para qué                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `infra/docker/docker-compose.yml`               | Postgres, Redis y, en el perfil `auth`, GoTrue (versión fija) y su proxy.                     |
| `infra/docker/auth-proxy/`                      | Configuración de nginx: `/auth/v1` y exigencia de `apikey`.                                   |
| `scripts/dev/setup.mjs`, `seed.mjs`, `totp.mjs` | `pnpm dev:setup`, `pnpm dev:seed`, `pnpm dev:totp`.                                           |
| `scripts/dev/lib/`                              | Configuración, usuarios de prueba, cliente tRPC, datos de muestra y barandas (con sus tests). |
| `e2e/`                                          | Playwright: un spec por módulo, helpers de ingreso por rol y de API.                          |
| `.env.local`, `.data/`                          | Secretos y datos generados. **Nunca se versionan.**                                           |
