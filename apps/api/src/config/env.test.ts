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
    });

    expect(env.DATABASE_URL_API).toBe("postgresql://joda_api:joda_api@localhost:55432/joda");
  });
});
