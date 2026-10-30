#!/usr/bin/env node
// `pnpm dev:setup` (WP-M18, docs/runbooks/entorno-local.md): deja el entorno local
// listo para entrar al admin con cada rol. Re-ejecutable: siempre termina en el
// mismo estado, con la base reiniciada.
//
//   1. genera .env.local (secretos al azar por máquina; los conserva si ya existe)
//   2. levanta Postgres, Redis, GoTrue y su proxy (docker compose) y espera a que estén sanos
//   3. pnpm db:reset (migraciones + seed base) y fija la contraseña de `joda_api`. Antes,
//      si la base o Redis tienen datos que este setup no creó, pide confirmación
//      (`--yes` o JODA_DEV_SETUP_YES=1; sin terminal y sin la bandera, se niega)
//   4. da de alta en GoTrue y en staff_users un usuario por rol
//   5. levanta la API un rato y siembra los datos de muestra POR LA API
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENV_LOCAL_PATH,
  OVERRIDABLE_KEYS,
  REPO_ROOT,
  formatLocalEnv,
  randomHexSecret,
  resolveLocalEnv,
} from "./lib/config.mjs";
import {
  ensureAuthDatabase,
  inspectDatabase,
  markDatabase,
  seedTenantAndStaff,
  setApiRolePassword,
  withSuperuser,
} from "./lib/database.mjs";
import { DEV_USERS } from "./lib/devUsers.mjs";
import { parseDotenv } from "./lib/dotenv.mjs";
import { createGoTrueAdmin } from "./lib/gotrue.mjs";
import { assertDevelopmentEnvironment } from "./lib/guards.mjs";
import {
  askQuestion,
  assertDockerIsRunning,
  assertPortsFree,
  compose,
  log,
  runOrFail,
  waitFor,
} from "./lib/process.mjs";
import { flushRedis, inspectRedis, markRedis } from "./lib/redis.mjs";
import { confirmDestructiveReset } from "./lib/resetGuard.mjs";
import { buildWorkspaceDependencies, startApiForSeeding } from "./lib/runtime.mjs";
import { seedSampleData } from "./lib/sampleData.mjs";
import { writeTotpSecrets } from "./lib/totp.mjs";

async function main() {
  // Antes de cualquier efecto: este script reinicia la base y crea usuarios con
  // contraseñas conocidas.
  assertDevelopmentEnvironment({ env: process.env });
  await assertDockerIsRunning();

  // --- 1. .env.local ---------------------------------------------------
  const hadEnvLocal = existsSync(ENV_LOCAL_PATH);
  const existing = hadEnvLocal ? parseDotenv(readFileSync(ENV_LOCAL_PATH, "utf8")) : {};
  const values = resolveLocalEnv({
    existing,
    overrides: Object.fromEntries(OVERRIDABLE_KEYS.map((key) => [key, process.env[key]])),
    repoRoot: REPO_ROOT,
    randomHex: randomHexSecret,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  assertDevelopmentEnvironment({
    env: process.env,
    urls: [
      ["DATABASE_URL", values.DATABASE_URL],
      ["REDIS_URL", values.REDIS_URL],
      ["SUPABASE_URL", values.SUPABASE_URL],
      ["APP_URL", values.APP_URL],
    ],
  });
  writeFileSync(ENV_LOCAL_PATH, formatLocalEnv(values), { mode: 0o600 });
  log(
    `.env.local ${hadEnvLocal ? "actualizado (se conservan los secretos)" : "creado"} — proyecto de compose: ${values.JODA_COMPOSE_PROJECT}`,
  );

  const project = values.JODA_COMPOSE_PROJECT;
  // NODE_ENV explícito: con `test` en la shell, la API no arrancaría.
  const childEnv = { ...values, NODE_ENV: "development" };

  // --- 2. Docker -------------------------------------------------------
  log("levantando Postgres y Redis…");
  await composeUp(project, ["postgres", "redis"], values);
  await waitFor(() => withSuperuser(values.DATABASE_URL, (client) => client.query("SELECT 1")), {
    what: "que Postgres acepte conexiones",
    timeoutMs: 60_000,
  });

  // Antes de borrar nada: ¿lo que hay lo creó este setup? Si no, hace falta confirmación.
  await confirmDestructiveReset({
    state: {
      database: await inspectDatabase(values.DATABASE_URL),
      redis: await inspectRedis(project),
      ports: { postgres: Number(values.JODA_PG_PORT), redis: Number(values.JODA_REDIS_PORT) },
    },
    argv: process.argv.slice(2),
    env: process.env,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: askQuestion,
    warn: log,
  });
  // La marca se deja ANTES del reset: db:reset borra esquemas, no la base, y una corrida
  // cortada a la mitad no tiene que volver a preguntar por lo que ya confirmaste.
  await markDatabase(values.DATABASE_URL);

  log("preparando la base del Auth local…");
  await ensureAuthDatabase(values.DATABASE_URL, values.GOTRUE_DB_PASSWORD);
  log("levantando el Auth local (GoTrue + proxy)…");
  await composeUp(project, ["auth", "auth-proxy"], values);

  // --- 3. Base de datos -----------------------------------------------
  log("db:reset — OJO: borra y recrea TODO el contenido de la base `joda` local");
  await runOrFail(process.execPath, [join(REPO_ROOT, "packages", "db", "scripts", "reset.mjs")], {
    env: { DATABASE_URL: values.DATABASE_URL },
  });
  const apiPassword = decodeURIComponent(new URL(values.DATABASE_URL_API).password);
  await setApiRolePassword(values.DATABASE_URL, apiPassword);
  log("contraseña de joda_api fijada desde .env.local (NOBYPASSRLS, la única que usa la API)");

  // Las sesiones y permisos cacheados de una base anterior no valen para esta.
  await flushRedis(project);
  await markRedis(project);

  // --- 4. Usuarios: GoTrue y staff_users --------------------------------
  const goTrue = createGoTrueAdmin({
    supabaseUrl: values.SUPABASE_URL,
    anonKey: values.SUPABASE_ANON_KEY,
    serviceRoleKey: values.SUPABASE_SERVICE_ROLE_KEY,
  });
  const staff = [];
  for (const user of DEV_USERS) {
    const authSubject = await goTrue.upsertUser({ email: user.email, password: user.password });
    staff.push({ ...user, authSubject });
  }
  await seedTenantAndStaff(values.DATABASE_URL, staff);
  // La base es nueva: ningún usuario tiene segundo factor inscripto todavía.
  mkdirSync(join(REPO_ROOT, ".data", "dev"), { recursive: true });
  writeTotpSecrets({});
  // La raíz de los derivados que sirve el servidor de medios tiene que existir al arrancar.
  mkdirSync(join(values.MEDIA_STORAGE_DIR, "catalog"), { recursive: true });
  log(`tenant JODA y ${DEV_USERS.length} usuarios de prueba creados (GoTrue + staff_users)`);

  // --- 5. Datos de muestra por la API -------------------------------------
  log("compilando los paquetes de los que depende la API…");
  await buildWorkspaceDependencies();
  await assertPortsFree([
    ["JODA_API_PORT", Number(values.JODA_API_PORT)],
    ["JODA_MEDIA_PORT", Number(values.JODA_MEDIA_PORT)],
  ]);
  log("levantando la API para sembrar los datos de muestra…");
  const api = await startApiForSeeding(childEnv);
  try {
    await seedSampleData({ apiUrl: values.JODA_API_URL, databaseUrl: values.DATABASE_URL });
  } catch (error) {
    error.message += `\n--- salida de la API ---\n${api.output().slice(-3000)}`;
    throw error;
  } finally {
    await api.stop();
  }

  printSummary(values);
}

/**
 * @param {string} project
 * @param {string[]} services
 * @param {Record<string, string>} values
 */
async function composeUp(project, services, values) {
  try {
    await compose(project, ["up", "-d", "--wait", ...services], { quiet: true });
  } catch (error) {
    throw new Error(
      `${error.message}\n\nSi dice «port is already allocated», otro programa usa ese puerto (JODA_PG_PORT=${values.JODA_PG_PORT}, JODA_REDIS_PORT=${values.JODA_REDIS_PORT}, JODA_SUPABASE_PORT=${values.JODA_SUPABASE_PORT}). Cerralo o elegí otro puerto y volvé a correr \`pnpm dev:setup\` (docs/runbooks/entorno-local.md).`,
    );
  }
}

/** @param {Record<string, string>} values */
function printSummary(values) {
  const rows = DEV_USERS.map(
    (user) => `  ${user.role.padEnd(9)} ${user.email.padEnd(22)} ${user.password}`,
  );
  console.log(`
Entorno local listo.

  Admin       http://localhost:${values.JODA_ADMIN_PORT}   (después de \`pnpm dev\`)
  API         ${values.APP_URL}
  Medios      ${values.MEDIA_PUBLIC_BASE_URL}   (resuelve solo en Chrome y Edge)
  Postgres    127.0.0.1:${values.JODA_PG_PORT}    Redis 127.0.0.1:${values.JODA_REDIS_PORT}    Auth ${values.SUPABASE_URL}

Usuarios de prueba (SOLO desarrollo local; el segundo factor es por máquina):
  rol       correo                 contraseña
${rows.join("\n")}

Código del segundo factor:   pnpm dev:totp <rol>      (ej.: pnpm dev:totp owner)
Levantar todo:               pnpm dev
Humo de punta a punta:       pnpm e2e:smoke
`);
}

main().catch((error) => {
  console.error(`\n[dev:setup] ${error.message}`);
  process.exit(1);
});
