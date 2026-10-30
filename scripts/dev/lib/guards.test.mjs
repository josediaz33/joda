// node --test scripts/dev/lib/*.test.mjs  (ver "test:dev-scripts" en package.json)
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertDevelopmentEnvironment, isLoopbackHost } from "./guards.mjs";

// WP-M18: los scripts de scripts/dev/ crean usuarios con contraseñas conocidas y
// reinician la base. docs/security-spec.md §3.1 (la API solo con su rol de runtime)
// y docs/runbooks/entorno-local.md los limitan a esta máquina.
describe("assertDevelopmentEnvironment se niega a correr fuera del entorno local (docs/runbooks/entorno-local.md)", () => {
  test("rechaza NODE_ENV=production", () => {
    assert.throws(
      () => assertDevelopmentEnvironment({ env: { NODE_ENV: "production" } }),
      /NODE_ENV=production/,
    );
  });

  test("rechaza JODA_ENV=production", () => {
    assert.throws(
      () => assertDevelopmentEnvironment({ env: { JODA_ENV: "production" } }),
      /NODE_ENV=production/,
    );
  });

  test("acepta NODE_ENV=development", () => {
    assert.doesNotThrow(() => assertDevelopmentEnvironment({ env: { NODE_ENV: "development" } }));
  });

  test("acepta un entorno sin NODE_ENV", () => {
    assert.doesNotThrow(() => assertDevelopmentEnvironment({ env: {} }));
  });

  test("rechaza una base que no está en esta máquina", () => {
    assert.throws(
      () =>
        assertDevelopmentEnvironment({
          env: {},
          urls: [["DATABASE_URL", "postgresql://postgres:x@db.example.com:5432/joda"]],
        }),
      /DATABASE_URL no apunta a esta máquina/,
    );
  });

  test("rechaza un proyecto de Supabase real", () => {
    assert.throws(
      () =>
        assertDevelopmentEnvironment({
          env: {},
          urls: [["SUPABASE_URL", "https://abcdefgh.supabase.co"]],
        }),
      /SUPABASE_URL no apunta a esta máquina/,
    );
  });

  test("rechaza una URL que no es una URL", () => {
    assert.throws(
      () => assertDevelopmentEnvironment({ env: {}, urls: [["JODA_API_URL", "no-es-una-url"]] }),
      /JODA_API_URL no apunta a esta máquina/,
    );
  });

  test("acepta localhost y 127.0.0.1", () => {
    assert.doesNotThrow(() =>
      assertDevelopmentEnvironment({
        env: {},
        urls: [
          ["DATABASE_URL", "postgresql://postgres:x@127.0.0.1:55432/joda"],
          ["APP_URL", "http://localhost:3333"],
        ],
      }),
    );
  });

  test("ignora las URL ausentes", () => {
    assert.doesNotThrow(() =>
      assertDevelopmentEnvironment({ env: {}, urls: [["DATABASE_URL", undefined]] }),
    );
  });
});

describe("isLoopbackHost (docs/runbooks/entorno-local.md)", () => {
  test("reconoce localhost, 127.0.0.1 y ::1", () => {
    assert.deepEqual(
      ["localhost", "LOCALHOST", "127.0.0.1", "::1", "[::1]"].map(isLoopbackHost),
      [true, true, true, true, true],
    );
  });

  test("no reconoce una IP de la red", () => {
    assert.equal(isLoopbackHost("10.200.11.34"), false);
  });
});
