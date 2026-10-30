import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatDotenv } from "./dotenv.mjs";
import { isValidLocalJwt, signLocalJwt } from "./jwt.mjs";

// Configuración del entorno local (WP-M18, docs/runbooks/entorno-local.md).
// `resolveLocalEnv` es pura (el azar y el reloj entran por parámetro) para
// poder probarla; lo que lee y escribe archivos está en setup.mjs.

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const ENV_LOCAL_PATH = join(REPO_ROOT, ".env.local");
export const COMPOSE_FILE = join(REPO_ROOT, "infra", "docker", "docker-compose.yml");
/** Ignorado por git (`.data/`): el secreto TOTP de cada usuario de prueba. */
export const DEV_DATA_DIR = join(REPO_ROOT, ".data", "dev");
export const TOTP_SECRETS_PATH = join(DEV_DATA_DIR, "totp-secrets.json");

/** Valores por defecto: los del entorno de siempre (55432, 6379) y los de Supabase local (54321). */
export const DEFAULT_PORTS = Object.freeze({
  JODA_PG_PORT: 55432,
  JODA_REDIS_PORT: 6379,
  JODA_SUPABASE_PORT: 54321,
  JODA_API_PORT: 3333,
  JODA_MEDIA_PORT: 3334,
  JODA_ADMIN_PORT: 5173,
});
export const DEFAULT_COMPOSE_PROJECT = "joda";

/** Variables que se pueden fijar en el entorno del proceso al correr `pnpm dev:setup`. */
export const OVERRIDABLE_KEYS = Object.freeze([
  "JODA_COMPOSE_PROJECT",
  ...Object.keys(DEFAULT_PORTS),
]);

/** Diez años: las claves locales no se rotan; se regeneran con el resto al borrar `.env.local`. */
const LOCAL_KEY_TTL_SECONDS = 10 * 365 * 24 * 3600;

/**
 * @param {string} key
 * @param {string | undefined} raw
 * @param {number} fallback
 */
function readPort(key, raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `${key} tiene que ser un puerto entre 1024 y 65535 (valor recibido: "${raw}").`,
    );
  }
  return port;
}

/**
 * @param {{
 *   existing: Record<string, string>;
 *   overrides: Record<string, string | undefined>;
 *   repoRoot: string;
 *   randomHex: (bytes: number) => string;
 *   nowSeconds: number;
 * }} input
 * @returns {Record<string, string>} las variables de `.env.local`, ya resueltas
 */
export function resolveLocalEnv({ existing, overrides, repoRoot, randomHex, nowSeconds }) {
  const pick = (/** @type {string} */ key) => overrides[key] || existing[key] || undefined;

  const project = pick("JODA_COMPOSE_PROJECT") ?? DEFAULT_COMPOSE_PROJECT;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) {
    throw new Error(
      `JODA_COMPOSE_PROJECT ("${project}") tiene que ser minúsculas, números, - o _ (regla de nombres de proyecto de docker compose).`,
    );
  }

  /** @type {Record<string, number>} */
  const ports = {};
  for (const [key, fallback] of Object.entries(DEFAULT_PORTS)) {
    ports[key] = readPort(key, pick(key), fallback);
  }
  const seen = new Map();
  for (const [key, port] of Object.entries(ports)) {
    const other = seen.get(port);
    if (other) throw new Error(`${key} y ${other} usan el mismo puerto (${port}).`);
    seen.set(port, key);
  }

  // Los secretos se conservan entre corridas: regenerarlos invalidaría las
  // sesiones abiertas y los secretos TOTP ya cifrados con MFA_ENCRYPTION_KEY.
  const keep = (/** @type {string} */ key, /** @type {number} */ bytes) =>
    existing[key] || randomHex(bytes);

  const jwtSecret = keep("GOTRUE_JWT_SECRET", 32);
  const keyFor = (/** @type {"anon" | "service_role"} */ role, /** @type {string} */ name) => {
    const current = existing[name];
    if (current && isValidLocalJwt(current, { secret: jwtSecret, role, nowSeconds }))
      return current;
    return signLocalJwt({
      secret: jwtSecret,
      role,
      issuedAtSeconds: nowSeconds,
      ttlSeconds: LOCAL_KEY_TTL_SECONDS,
    });
  };

  let apiPassword = "";
  if (existing.DATABASE_URL_API) {
    try {
      apiPassword = decodeURIComponent(new URL(existing.DATABASE_URL_API).password);
    } catch {
      apiPassword = "";
    }
  }
  if (!apiPassword) apiPassword = randomHex(16);

  const mediaDir = `${repoRoot.replaceAll("\\", "/")}/.data/media`;

  return {
    JODA_COMPOSE_PROJECT: project,
    ...Object.fromEntries(Object.entries(ports).map(([key, port]) => [key, String(port)])),
    JODA_API_URL: `http://127.0.0.1:${ports.JODA_API_PORT}`,
    // Superusuario: SOLO migrar y sembrar (packages/db, scripts/dev). Nunca el runtime.
    DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${ports.JODA_PG_PORT}/joda?schema=app`,
    // Lo único que usa apps/api: `joda_api`, NOBYPASSRLS, con una contraseña al azar.
    DATABASE_URL_API: `postgresql://joda_api:${encodeURIComponent(apiPassword)}@127.0.0.1:${ports.JODA_PG_PORT}/joda?schema=app`,
    REDIS_URL: `redis://127.0.0.1:${ports.JODA_REDIS_PORT}`,
    SUPABASE_URL: `http://127.0.0.1:${ports.JODA_SUPABASE_PORT}`,
    SUPABASE_ANON_KEY: keyFor("anon", "SUPABASE_ANON_KEY"),
    SUPABASE_SERVICE_ROLE_KEY: keyFor("service_role", "SUPABASE_SERVICE_ROLE_KEY"),
    GOTRUE_JWT_SECRET: jwtSecret,
    GOTRUE_DB_PASSWORD: keep("GOTRUE_DB_PASSWORD", 16),
    SESSION_SECRET: keep("SESSION_SECRET", 32),
    MFA_ENCRYPTION_KEY: keep("MFA_ENCRYPTION_KEY", 32),
    APP_URL: `http://localhost:${ports.JODA_API_PORT}`,
    ADMIN_URL: `http://localhost:${ports.JODA_ADMIN_PORT}`,
    // Solo loopback: el admin de desarrollo tiene usuarios de prueba.
    HOST: "127.0.0.1",
    PORT: String(ports.JODA_API_PORT),
    MEDIA_STORAGE_DIR: mediaDir,
    // `media.localhost` es otro HOST que APP_URL (docs/security-spec.md §5) y
    // resuelve solo a 127.0.0.1 en Chrome y Edge.
    MEDIA_PUBLIC_BASE_URL: `http://media.localhost:${ports.JODA_MEDIA_PORT}`,
  };
}

const HEADER = `Generado por \`pnpm dev:setup\` (WP-M18). Entorno LOCAL de desarrollo.
NO se versiona (.gitignore): los secretos de acá son al azar por máquina.
Para cambiar un puerto: editá la variable JODA_*_PORT y corré \`pnpm dev:setup\`.`;

/** @param {Record<string, string>} values */
export function formatLocalEnv(values) {
  const pickEntries = (/** @type {string[]} */ keys) =>
    keys.map((key) => /** @type {const} */ ([key, values[key] ?? ""]));
  return formatDotenv(
    [
      {
        comment:
          "Proyecto de compose y puertos de host (todos en 127.0.0.1). Se pueden sobrescribir\ncon variables de entorno al correr `pnpm dev:setup`.",
        entries: pickEntries([
          "JODA_COMPOSE_PROJECT",
          ...Object.keys(DEFAULT_PORTS),
          "JODA_API_URL",
        ]),
      },
      {
        comment:
          "Base de datos. DATABASE_URL es el SUPERUSUARIO: solo migraciones y siembra.\nDATABASE_URL_API es `joda_api` (NOBYPASSRLS), la única que usa apps/api.",
        entries: pickEntries(["DATABASE_URL", "DATABASE_URL_API", "REDIS_URL"]),
      },
      {
        comment:
          "Auth local (GoTrue tras un proxy en /auth/v1). Las claves son JWT firmados con\nGOTRUE_JWT_SECRET. La de servicio NO la lee apps/api.",
        entries: pickEntries([
          "SUPABASE_URL",
          "SUPABASE_ANON_KEY",
          "SUPABASE_SERVICE_ROLE_KEY",
          "GOTRUE_JWT_SECRET",
          "GOTRUE_DB_PASSWORD",
        ]),
      },
      {
        comment: "Aplicación.",
        entries: pickEntries([
          "SESSION_SECRET",
          "MFA_ENCRYPTION_KEY",
          "APP_URL",
          "ADMIN_URL",
          "HOST",
          "PORT",
          "MEDIA_STORAGE_DIR",
          "MEDIA_PUBLIC_BASE_URL",
        ]),
      },
    ],
    HEADER,
  );
}

/** @param {number} bytes */
export function randomHexSecret(bytes) {
  return randomBytes(bytes).toString("hex");
}
