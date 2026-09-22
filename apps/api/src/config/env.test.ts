import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

// docs/security-spec.md §3.1: apps/api no tiene una credencial de base de
// datos por defecto — sin DATABASE_URL_API explícita, el proceso no arranca.
// No es una regla de negocio (RN-XXX), es la convención de arranque que fija
// ese documento, así que el describe cita la sección en vez de inventar un
// número (.claude/rules/testing.md).
describe("loadEnv exige DATABASE_URL_API sin fallback a DATABASE_URL (docs/security-spec.md §3.1)", () => {
  it("rechaza un entorno sin DATABASE_URL_API", () => {
    expect(() =>
      loadEnv({ DATABASE_URL: "postgresql://postgres:postgres@localhost:55432/joda" }),
    ).toThrow(/DATABASE_URL_API/);
  });

  it("rechaza DATABASE_URL_API vacía", () => {
    expect(() => loadEnv({ DATABASE_URL_API: "" })).toThrow(/DATABASE_URL_API/);
  });

  it("acepta un entorno con DATABASE_URL_API definida, sin exigir DATABASE_URL", () => {
    const env = loadEnv({
      DATABASE_URL_API: "postgresql://joda_api:joda_api@localhost:55432/joda",
      ...VALID_SESSION_ENV,
    });

    expect(env.DATABASE_URL_API).toBe("postgresql://joda_api:joda_api@localhost:55432/joda");
  });
});

// WP-C03 (docs/security-spec.md §4): REDIS_URL, SESSION_SECRET, SUPABASE_URL
// y SUPABASE_ANON_KEY son tan obligatorias como DATABASE_URL_API arriba —
// mismo criterio, un proceso que arranca sin ellas tiene el login roto desde
// el primer request. MFA_ENCRYPTION_KEY se suma en WP-C04 (docs/security-spec.md
// §4.3): sin ella no hay dónde guardar el secreto TOTP de personal.
const VALID_SESSION_ENV = {
  REDIS_URL: "redis://localhost:6379",
  SESSION_SECRET: "0".repeat(32),
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  MFA_ENCRYPTION_KEY: "0".repeat(64),
  APP_URL: "http://localhost:3333",
  MEDIA_STORAGE_DIR: "./.data/media",
  MEDIA_PUBLIC_BASE_URL: "http://media.localhost:3334",
};

describe("loadEnv exige REDIS_URL, SESSION_SECRET, SUPABASE_URL y SUPABASE_ANON_KEY (docs/security-spec.md §4)", () => {
  const DATABASE_URL_API = "postgresql://joda_api:joda_api@localhost:55432/joda";

  it("rechaza un entorno sin REDIS_URL", () => {
    expect(() => loadEnv({ DATABASE_URL_API, ...VALID_SESSION_ENV, REDIS_URL: undefined })).toThrow(
      /REDIS_URL/,
    );
  });

  it("rechaza SESSION_SECRET de menos de 32 caracteres", () => {
    expect(() =>
      loadEnv({ DATABASE_URL_API, ...VALID_SESSION_ENV, SESSION_SECRET: "corta" }),
    ).toThrow(/SESSION_SECRET/);
  });

  it("rechaza un entorno sin SUPABASE_URL", () => {
    expect(() =>
      loadEnv({ DATABASE_URL_API, ...VALID_SESSION_ENV, SUPABASE_URL: undefined }),
    ).toThrow(/SUPABASE_URL/);
  });

  it("rechaza un entorno sin SUPABASE_ANON_KEY", () => {
    expect(() =>
      loadEnv({ DATABASE_URL_API, ...VALID_SESSION_ENV, SUPABASE_ANON_KEY: undefined }),
    ).toThrow(/SUPABASE_ANON_KEY/);
  });

  it("acepta un entorno con las cinco variables completas", () => {
    const env = loadEnv({ DATABASE_URL_API, ...VALID_SESSION_ENV });

    expect(env.REDIS_URL).toBe(VALID_SESSION_ENV.REDIS_URL);
    expect(env.SUPABASE_URL).toBe(VALID_SESSION_ENV.SUPABASE_URL);
  });
});

describe("loadEnv exige MFA_ENCRYPTION_KEY — 64 caracteres hex, 32 bytes de AES-256 (docs/security-spec.md §4.3)", () => {
  const DATABASE_URL_API = "postgresql://joda_api:joda_api@localhost:55432/joda";

  it("rechaza un entorno sin MFA_ENCRYPTION_KEY", () => {
    expect(() =>
      loadEnv({ DATABASE_URL_API, ...VALID_SESSION_ENV, MFA_ENCRYPTION_KEY: undefined }),
    ).toThrow(/MFA_ENCRYPTION_KEY/);
  });

  it("rechaza una MFA_ENCRYPTION_KEY que no son 64 caracteres hex", () => {
    expect(() =>
      loadEnv({ DATABASE_URL_API, ...VALID_SESSION_ENV, MFA_ENCRYPTION_KEY: "demasiado-corta" }),
    ).toThrow(/MFA_ENCRYPTION_KEY/);
  });

  it("acepta una MFA_ENCRYPTION_KEY de 64 caracteres hex", () => {
    const env = loadEnv({ DATABASE_URL_API, ...VALID_SESSION_ENV });

    expect(env.MFA_ENCRYPTION_KEY).toBe(VALID_SESSION_ENV.MFA_ENCRYPTION_KEY);
  });
});

// WP-C09, docs/security-spec.md §5 ("Carga de archivos": "servidos desde
// dominio distinto al del admin"). MEDIA_PUBLIC_BASE_URL con el MISMO host
// que APP_URL parece cumplir la regla (dos orígenes técnicamente distintos
// si el puerto difiere) y no la cumple: las cookies no se aíslan por
// puerto (RFC 6265) — solo por host. loadEnv lo rechaza al arrancar, no en
// el primer request que filtre la cookie.
describe("loadEnv exige APP_URL, MEDIA_STORAGE_DIR, MEDIA_PUBLIC_BASE_URL, y que sus hosts difieran (docs/security-spec.md §5)", () => {
  const DATABASE_URL_API = "postgresql://joda_api:joda_api@localhost:55432/joda";

  it("rechaza un entorno sin APP_URL", () => {
    expect(() => loadEnv({ DATABASE_URL_API, ...VALID_SESSION_ENV, APP_URL: undefined })).toThrow(
      /APP_URL/,
    );
  });

  it("rechaza un APP_URL que no es una URL válida", () => {
    expect(() =>
      loadEnv({ DATABASE_URL_API, ...VALID_SESSION_ENV, APP_URL: "no-es-una-url" }),
    ).toThrow(/APP_URL/);
  });

  it("rechaza un entorno sin MEDIA_STORAGE_DIR", () => {
    expect(() =>
      loadEnv({ DATABASE_URL_API, ...VALID_SESSION_ENV, MEDIA_STORAGE_DIR: undefined }),
    ).toThrow(/MEDIA_STORAGE_DIR/);
  });

  it("rechaza un entorno sin MEDIA_PUBLIC_BASE_URL", () => {
    expect(() =>
      loadEnv({ DATABASE_URL_API, ...VALID_SESSION_ENV, MEDIA_PUBLIC_BASE_URL: undefined }),
    ).toThrow(/MEDIA_PUBLIC_BASE_URL/);
  });

  it("rechaza MEDIA_PUBLIC_BASE_URL con el mismo host que APP_URL, aunque el puerto difiera", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL_API,
        ...VALID_SESSION_ENV,
        APP_URL: "http://localhost:3333",
        MEDIA_PUBLIC_BASE_URL: "http://localhost:3334",
      }),
    ).toThrow(/host distinto/);
  });

  it("acepta hosts distintos incluso con el mismo puerto", () => {
    const env = loadEnv({
      DATABASE_URL_API,
      ...VALID_SESSION_ENV,
      APP_URL: "http://localhost:3333",
      MEDIA_PUBLIC_BASE_URL: "http://media.localhost:3333",
    });

    expect(env.MEDIA_PUBLIC_BASE_URL).toBe("http://media.localhost:3333");
  });
});
