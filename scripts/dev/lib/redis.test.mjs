// node --test scripts/dev/lib/*.test.mjs  (ver "test:dev-scripts" en package.json)
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { flushRedis, inspectRedis, markRedis } from "./redis.mjs";
import { REDIS_MARK_KEY } from "./resetGuard.mjs";

/**
 * Un `redis-cli` falso: anota los comandos y contesta lo que se le pidió.
 *
 * @param {Record<string, string>} answers respuesta por nombre de comando
 */
function fakeCli(answers = {}) {
  /** @type {string[][]} */
  const commands = [];
  return {
    commands,
    cli: async (/** @type {string[]} */ command) => {
      commands.push(command);
      return answers[command[0]] ?? "OK";
    },
  };
}

// WP-M18, docs/runbooks/entorno-local.md: el setup vacía SOLO la base 0 de Redis, la que usa
// la API. Los datos que alguien tenga en las bases 1–15 del mismo Redis no son del entorno.
describe("el setup vacía solo la base 0 de Redis (docs/runbooks/entorno-local.md)", () => {
  test("flushRedis manda FLUSHDB, nunca FLUSHALL", async () => {
    const { cli, commands } = fakeCli();

    await flushRedis(cli);

    assert.deepEqual(commands, [["FLUSHDB"]]);
  });

  test("inspectRedis cuenta las claves de la base 0 (DBSIZE) y busca la marca", async () => {
    const { cli, commands } = fakeCli({ DBSIZE: "12", EXISTS: "1" });

    const state = await inspectRedis(cli);

    assert.deepEqual(state, { keys: 12, marked: true });
    assert.deepEqual(commands, [["DBSIZE"], ["EXISTS", REDIS_MARK_KEY]]);
  });

  test("sin la clave de marca, inspectRedis dice que no está marcado", async () => {
    const { cli } = fakeCli({ DBSIZE: "3", EXISTS: "0" });

    assert.deepEqual(await inspectRedis(cli), { keys: 3, marked: false });
  });

  test("si Redis no contesta un número, inspectRedis falla en vez de suponer que está vacío", async () => {
    const { cli } = fakeCli({ DBSIZE: "ERR algo", EXISTS: "0" });

    await assert.rejects(inspectRedis(cli), /DBSIZE/);
  });

  test("markRedis deja la clave de marca", async () => {
    const { cli, commands } = fakeCli();

    await markRedis(cli);

    assert.deepEqual(commands, [["SET", REDIS_MARK_KEY, "1"]]);
  });
});
