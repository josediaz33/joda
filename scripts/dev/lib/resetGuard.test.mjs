// node --test scripts/dev/lib/*.test.mjs  (ver "test:dev-scripts" en package.json)
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { confirmDestructiveReset, isPreConfirmed, unmarkedDataReasons } from "./resetGuard.mjs";

const PORTS = { postgres: 55432, redis: 6379 };
const EMPTY = { database: { tables: 0, marked: false }, redis: { keys: 0, marked: false } };
const OWN = { database: { tables: 63, marked: true }, redis: { keys: 12, marked: true } };
const FOREIGN = { database: { tables: 63, marked: false }, redis: { keys: 12, marked: false } };

/**
 * @param {Partial<Parameters<typeof confirmDestructiveReset>[0]>} overrides
 */
function confirm(overrides = {}) {
  const asked = [];
  const warned = [];
  const input = {
    state: { ...EMPTY, ports: PORTS },
    argv: [],
    env: {},
    interactive: false,
    ask: async (/** @type {string} */ question) => {
      asked.push(question);
      return "";
    },
    warn: (/** @type {string} */ message) => warned.push(message),
    ...overrides,
  };
  return { run: () => confirmDestructiveReset(input), asked, warned };
}

// WP-M18, docs/runbooks/entorno-local.md: `pnpm dev:setup` reinicia la base y vacía Redis.
// Con los valores por defecto son los contenedores de desarrollo de siempre (55432, 6379):
// no se borra lo que el propio setup no creó sin que alguien lo confirme.
describe("unmarkedDataReasons dice qué se borraría sin haberlo creado el setup (docs/runbooks/entorno-local.md)", () => {
  test("una base y un Redis sin datos no tienen nada que perder", () => {
    assert.deepEqual(unmarkedDataReasons({ ...EMPTY, ports: PORTS }), []);
  });

  test("una base y un Redis con la marca del setup se pueden reiniciar", () => {
    assert.deepEqual(unmarkedDataReasons({ ...OWN, ports: PORTS }), []);
  });

  test("una base con tablas y sin marca es una razón, con su puerto", () => {
    const reasons = unmarkedDataReasons({
      database: { tables: 63, marked: false },
      redis: { keys: 0, marked: false },
      ports: PORTS,
    });

    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /base «joda» de 127\.0\.0\.1:55432 tiene 63 tablas/);
  });

  test("un Redis con claves y sin marca es otra razón, con su puerto", () => {
    const reasons = unmarkedDataReasons({
      database: { tables: 0, marked: false },
      redis: { keys: 12, marked: false },
      ports: PORTS,
    });

    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /Redis de 127\.0\.0\.1:6379 tiene 12 claves/);
  });

  test("las dos cosas sin marca son dos razones", () => {
    assert.equal(unmarkedDataReasons({ ...FOREIGN, ports: PORTS }).length, 2);
  });
});

describe("isPreConfirmed reconoce --yes y JODA_DEV_SETUP_YES (docs/runbooks/entorno-local.md)", () => {
  test("--yes en la línea de comandos confirma", () => {
    assert.equal(isPreConfirmed({ argv: ["--yes"], env: {} }), true);
  });

  test("JODA_DEV_SETUP_YES=1 confirma", () => {
    assert.equal(isPreConfirmed({ argv: [], env: { JODA_DEV_SETUP_YES: "1" } }), true);
  });

  test("JODA_DEV_SETUP_YES=true confirma", () => {
    assert.equal(isPreConfirmed({ argv: [], env: { JODA_DEV_SETUP_YES: "true" } }), true);
  });

  test("sin bandera ni variable no confirma", () => {
    assert.equal(isPreConfirmed({ argv: [], env: {} }), false);
  });

  test("JODA_DEV_SETUP_YES=0 no confirma", () => {
    assert.equal(isPreConfirmed({ argv: [], env: { JODA_DEV_SETUP_YES: "0" } }), false);
  });

  test("un argumento parecido no confirma", () => {
    assert.equal(isPreConfirmed({ argv: ["--yes-please", "yes"], env: {} }), false);
  });
});

describe("confirmDestructiveReset no borra datos ajenos sin confirmación (docs/runbooks/entorno-local.md)", () => {
  test("sin nada que perder sigue sin preguntar, aun sin terminal", async () => {
    const { run, asked, warned } = confirm({ state: { ...EMPTY, ports: PORTS } });

    await run();

    assert.deepEqual([asked, warned], [[], []]);
  });

  test("con la marca del setup sigue sin preguntar", async () => {
    const { run, asked } = confirm({ state: { ...OWN, ports: PORTS } });

    await run();

    assert.deepEqual(asked, []);
  });

  test("con datos sin marca y sin terminal ni bandera se niega y dice cómo seguir", async () => {
    const { run } = confirm({ state: { ...FOREIGN, ports: PORTS }, interactive: false });

    await assert.rejects(run, (error) => {
      assert.match(error.message, /se niega a borrar datos que no creó él/);
      assert.match(error.message, /127\.0\.0\.1:55432 tiene 63 tablas/);
      assert.match(error.message, /127\.0\.0\.1:6379 tiene 12 claves/);
      assert.match(error.message, /pnpm dev:setup --yes/);
      assert.match(error.message, /JODA_DEV_SETUP_YES=1/);
      return true;
    });
  });

  test("con --yes sigue y avisa qué borra", async () => {
    const { run, warned } = confirm({ state: { ...FOREIGN, ports: PORTS }, argv: ["--yes"] });

    await run();

    assert.equal(warned.length, 1);
    assert.match(warned[0], /127\.0\.0\.1:55432 tiene 63 tablas/);
  });

  test("con JODA_DEV_SETUP_YES=1 sigue sin terminal", async () => {
    const { run } = confirm({
      state: { ...FOREIGN, ports: PORTS },
      env: { JODA_DEV_SETUP_YES: "1" },
    });

    await run();
  });

  test("en una terminal pregunta, con lo que se borraría, y sigue con «si»", async () => {
    const asked = [];
    const { run } = confirm({
      state: { ...FOREIGN, ports: PORTS },
      interactive: true,
      ask: async (question) => {
        asked.push(question);
        return " Si ";
      },
    });

    await run();

    assert.equal(asked.length, 1);
    assert.match(asked[0], /127\.0\.0\.1:55432 tiene 63 tablas/);
  });

  test("en una terminal, cualquier respuesta que no sea afirmativa cancela", async () => {
    const { run } = confirm({
      state: { ...FOREIGN, ports: PORTS },
      interactive: true,
      ask: async () => "no",
    });

    await assert.rejects(run, /Cancelado: no se borró nada/);
  });

  test("en una terminal, la respuesta vacía (Enter) cancela", async () => {
    const { run } = confirm({
      state: { ...FOREIGN, ports: PORTS },
      interactive: true,
      ask: async () => "",
    });

    await assert.rejects(run, /Cancelado/);
  });

  test("con --yes no pregunta aunque haya terminal", async () => {
    const { run, asked } = confirm({
      state: { ...FOREIGN, ports: PORTS },
      argv: ["--yes"],
      interactive: true,
    });

    await run();

    assert.deepEqual(asked, []);
  });
});
