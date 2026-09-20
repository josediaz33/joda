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
// el primer request.
const VALID_SESSION_ENV = {
  REDIS_URL: "redis://localhost:6379",
  SESSION_SECRET: "0".repeat(32),
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
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

  it("acepta un entorno con las cuatro variables completas", () => {
    const env = loadEnv({ DATABASE_URL_API, ...VALID_SESSION_ENV });

    expect(env.REDIS_URL).toBe(VALID_SESSION_ENV.REDIS_URL);
    expect(env.SUPABASE_URL).toBe(VALID_SESSION_ENV.SUPABASE_URL);
  });
});
