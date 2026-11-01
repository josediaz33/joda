// node --test scripts/dev/lib/*.test.mjs  (ver "test:dev-scripts" en package.json)
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_PORTS, formatLocalEnv, resolveLocalEnv } from "./config.mjs";
import { parseDotenv } from "./dotenv.mjs";
import { isValidLocalJwt } from "./jwt.mjs";

// Azar determinista: cada llamada devuelve un hex distinto, siempre el mismo orden.
function sequentialHex() {
  let counter = 0;
  return (bytes) => (++counter).toString(16).padStart(bytes * 2, "0");
}

const NOW = 1_800_000_000;

function resolve(overrides = {}, existing = {}) {
  return resolveLocalEnv({
    existing,
    overrides,
    repoRoot: "C:\\Users\\jose\\JODA Parfums ERP Ecomm",
    randomHex: sequentialHex(),
    nowSeconds: NOW,
  });
}

// WP-M18, docs/security-spec.md §3.1: apps/api conecta SIEMPRE como `joda_api`
// (NOBYPASSRLS); el superusuario es solo para migrar y sembrar.
describe("resolveLocalEnv separa la credencial de la API de la del superusuario (docs/security-spec.md §3.1)", () => {
  test("DATABASE_URL_API usa el rol joda_api", () => {
    assert.match(resolve().DATABASE_URL_API, /^postgresql:\/\/joda_api:/);
  });

  test("DATABASE_URL usa el superusuario postgres", () => {
    assert.match(resolve().DATABASE_URL, /^postgresql:\/\/postgres:/);
  });

  test("la contraseña de joda_api es al azar, no la fija del seed de las pruebas", () => {
    assert.doesNotMatch(resolve().DATABASE_URL_API, /joda_api:joda_api@/);
  });

  test("los dos apuntan al mismo puerto de Postgres", () => {
    const values = resolve({ JODA_PG_PORT: "55620" });

    assert.match(values.DATABASE_URL, /@127\.0\.0\.1:55620\/joda/);
    assert.match(values.DATABASE_URL_API, /@127\.0\.0\.1:55620\/joda/);
  });
});

describe("resolveLocalEnv genera secretos al azar y los conserva (docs/runbooks/entorno-local.md)", () => {
  test("SESSION_SECRET alcanza los 32 caracteres que exige la API", () => {
    assert.ok(resolve().SESSION_SECRET.length >= 32);
  });

  test("MFA_ENCRYPTION_KEY son 64 caracteres hexadecimales (AES-256)", () => {
    assert.match(resolve().MFA_ENCRYPTION_KEY, /^[0-9a-f]{64}$/);
  });

  test("cada secreto es distinto de los demás", () => {
    const values = resolve();
    const secrets = [
      values.SESSION_SECRET,
      values.MFA_ENCRYPTION_KEY,
      values.GOTRUE_JWT_SECRET,
      values.GOTRUE_DB_PASSWORD,
    ];

    assert.equal(new Set(secrets).size, 4);
  });

  test("una segunda corrida con el .env.local existente conserva los secretos", () => {
    const first = resolve();

    const second = resolve({}, first);

    assert.deepEqual(second, first);
  });

  test("conserva la contraseña de joda_api del .env.local existente", () => {
    const first = resolve();

    const second = resolve({}, first);

    assert.equal(second.DATABASE_URL_API, first.DATABASE_URL_API);
  });
});

describe("resolveLocalEnv firma las claves del Auth local con el secreto de GoTrue (WP-M18)", () => {
  test("la clave anónima verifica con GOTRUE_JWT_SECRET y rol anon", () => {
    const values = resolve();

    assert.equal(
      isValidLocalJwt(values.SUPABASE_ANON_KEY, {
        secret: values.GOTRUE_JWT_SECRET,
        role: "anon",
        nowSeconds: NOW,
      }),
      true,
    );
  });

  test("la clave de servicio verifica con rol service_role", () => {
    const values = resolve();

    assert.equal(
      isValidLocalJwt(values.SUPABASE_SERVICE_ROLE_KEY, {
        secret: values.GOTRUE_JWT_SECRET,
        role: "service_role",
        nowSeconds: NOW,
      }),
      true,
    );
  });

  test("la clave anónima no pasa por una de servicio", () => {
    const values = resolve();

    assert.equal(
      isValidLocalJwt(values.SUPABASE_ANON_KEY, {
        secret: values.GOTRUE_JWT_SECRET,
        role: "service_role",
        nowSeconds: NOW,
      }),
      false,
    );
  });

  test("no verifica con otro secreto", () => {
    const values = resolve();

    assert.equal(
      isValidLocalJwt(values.SUPABASE_ANON_KEY, {
        secret: "otro-secreto",
        role: "anon",
        nowSeconds: NOW,
      }),
      false,
    );
  });

  test("si cambia GOTRUE_JWT_SECRET, las claves viejas se vuelven a firmar", () => {
    const first = resolve();

    const rotated = resolve({}, { ...first, GOTRUE_JWT_SECRET: "f".repeat(64) });

    assert.notEqual(rotated.SUPABASE_ANON_KEY, first.SUPABASE_ANON_KEY);
  });
});

describe("resolveLocalEnv: puertos y proyecto sobrescribibles (WP-M18, punto 7 del encargo)", () => {
  test("los valores por defecto son los del entorno de siempre", () => {
    const values = resolve();

    assert.deepEqual(
      [values.JODA_PG_PORT, values.JODA_REDIS_PORT, values.JODA_SUPABASE_PORT],
      ["55432", "6379", "54321"],
    );
  });

  test("el proyecto de compose por defecto es joda", () => {
    assert.equal(resolve().JODA_COMPOSE_PROJECT, "joda");
  });

  test("una variable de entorno cambia el puerto y las URL derivadas", () => {
    const values = resolve({ JODA_API_PORT: "55623" });

    assert.deepEqual(
      [values.PORT, values.APP_URL, values.JODA_API_URL],
      ["55623", "http://localhost:55623", "http://127.0.0.1:55623"],
    );
  });

  test("la variable de entorno gana sobre lo que ya tenía el .env.local", () => {
    const first = resolve({ JODA_PG_PORT: "55620" });

    const second = resolve({ JODA_PG_PORT: "55630" }, first);

    assert.equal(second.JODA_PG_PORT, "55630");
  });

  test("sin variable, el .env.local existente decide", () => {
    const first = resolve({ JODA_PG_PORT: "55620" });

    const second = resolve({}, first);

    assert.equal(second.JODA_PG_PORT, "55620");
  });

  test("el nombre de proyecto se puede cambiar", () => {
    assert.equal(resolve({ JODA_COMPOSE_PROJECT: "joda-otro" }).JODA_COMPOSE_PROJECT, "joda-otro");
  });

  test("rechaza un nombre de proyecto que compose no acepta", () => {
    assert.throws(() => resolve({ JODA_COMPOSE_PROJECT: "Mi Proyecto" }), /JODA_COMPOSE_PROJECT/);
  });

  test("rechaza un puerto fuera de rango", () => {
    assert.throws(() => resolve({ JODA_PG_PORT: "80" }), /JODA_PG_PORT/);
  });

  test("rechaza un puerto que no es un número", () => {
    assert.throws(() => resolve({ JODA_REDIS_PORT: "abc" }), /JODA_REDIS_PORT/);
  });

  test("rechaza dos servicios en el mismo puerto", () => {
    assert.throws(
      () => resolve({ JODA_API_PORT: "3500", JODA_MEDIA_PORT: "3500" }),
      /mismo puerto/,
    );
  });

  test("DEFAULT_PORTS son los de siempre: Postgres 55432, Redis 6379, Auth 54321, API 3333, medios 3334, admin 5173", () => {
    assert.deepEqual(Object.values(DEFAULT_PORTS), [55432, 6379, 54321, 3333, 3334, 5173]);
  });
});

describe("resolveLocalEnv: la API y los medios escuchan solo en loopback y en hosts distintos (docs/security-spec.md §5)", () => {
  test("API_HOST es 127.0.0.1", () => {
    assert.equal(resolve().API_HOST, "127.0.0.1");
  });

  test("los medios se sirven desde media.localhost, no desde el host de APP_URL", () => {
    const values = resolve();

    assert.equal(new URL(values.MEDIA_PUBLIC_BASE_URL).hostname, "media.localhost");
    assert.equal(new URL(values.APP_URL).hostname, "localhost");
  });

  test("MEDIA_STORAGE_DIR usa barras y cuelga de .data/ del repo", () => {
    assert.equal(resolve().MEDIA_STORAGE_DIR, "C:/Users/jose/JODA Parfums ERP Ecomm/.data/media");
  });
});

describe("formatLocalEnv escribe un .env que leen node, compose y Vite (WP-M18)", () => {
  test("se vuelve a leer igual, incluida una ruta con espacios", () => {
    const values = resolve();

    const parsed = parseDotenv(formatLocalEnv(values));

    assert.deepEqual(parsed, values);
  });

  test("la ruta con espacios va entre comillas", () => {
    assert.match(
      formatLocalEnv(resolve()),
      /^MEDIA_STORAGE_DIR="C:\/Users\/jose\/JODA Parfums ERP Ecomm\/\.data\/media"$/m,
    );
  });

  test("no contiene ninguna de las contraseñas fijas del repo", () => {
    assert.doesNotMatch(formatLocalEnv(resolve()), /joda_api:joda_api|JodaDev/);
  });

  test("rechaza un valor con comillas o $", () => {
    assert.throws(() => formatLocalEnv({ ...resolve(), SESSION_SECRET: 'a"b' }), /comillas/);
  });
});
