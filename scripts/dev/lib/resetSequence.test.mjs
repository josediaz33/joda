// node --test scripts/dev/lib/*.test.mjs  (ver "test:dev-scripts" en package.json)
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resetLocalState } from "./resetSequence.mjs";

/**
 * Pasos que anotan en qué orden se llamaron; `failAt` hace fallar uno.
 *
 * @param {string | null} failAt
 */
function recordedSteps(failAt = null) {
  /** @type {string[]} */
  const calls = [];
  const step = (/** @type {string} */ name) => async () => {
    calls.push(name);
    if (name === failAt) throw new Error(`falló ${name}`);
  };
  return {
    calls,
    steps: {
      confirm: step("confirm"),
      prepareAuth: step("prepareAuth"),
      markDatabase: step("markDatabase"),
      resetDatabase: step("resetDatabase"),
      flushRedis: step("flushRedis"),
      markRedis: step("markRedis"),
    },
  };
}

// WP-M18, docs/runbooks/entorno-local.md: la marca de la base dice «la reinicia el setup» y
// la siguiente corrida se apoya en ella para no preguntar. Si se dejara antes de que el
// reset pueda empezar, una falla previa dejaría una base con datos ajenos ya marcada.
describe("resetLocalState marca la base justo antes del reset, no antes (docs/runbooks/entorno-local.md)", () => {
  test("sin fallas, hace todo en este orden", async () => {
    const { calls, steps } = recordedSteps();

    await resetLocalState(steps);

    assert.deepEqual(calls, [
      "confirm",
      "prepareAuth",
      "markDatabase",
      "resetDatabase",
      "flushRedis",
      "markRedis",
    ]);
  });

  test("si la confirmación se niega, no se hace nada más", async () => {
    const { calls, steps } = recordedSteps("confirm");

    await assert.rejects(resetLocalState(steps), /falló confirm/);

    assert.deepEqual(calls, ["confirm"]);
  });

  test("si falla la preparación del Auth, la base queda SIN marca y sin reiniciar", async () => {
    const { calls, steps } = recordedSteps("prepareAuth");

    await assert.rejects(resetLocalState(steps), /falló prepareAuth/);

    assert.deepEqual(calls, ["confirm", "prepareAuth"]);
  });

  test("si falla el reset, Redis no se vacía ni se marca", async () => {
    const { calls, steps } = recordedSteps("resetDatabase");

    await assert.rejects(resetLocalState(steps), /falló resetDatabase/);

    assert.deepEqual(calls, ["confirm", "prepareAuth", "markDatabase", "resetDatabase"]);
  });

  test("si falla el vaciado de Redis, Redis no se marca", async () => {
    const { calls, steps } = recordedSteps("flushRedis");

    await assert.rejects(resetLocalState(steps), /falló flushRedis/);

    assert.deepEqual(calls, [
      "confirm",
      "prepareAuth",
      "markDatabase",
      "resetDatabase",
      "flushRedis",
    ]);
  });
});
