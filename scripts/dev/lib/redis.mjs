import { compose } from "./process.mjs";
import { REDIS_MARK_KEY } from "./resetGuard.mjs";

// El Redis del entorno local se maneja con `redis-cli` DENTRO del contenedor (WP-M18): el
// repo no depende de ningún cliente de Redis para esto, y no hay nada que instalar en el host.
//
// Todo acá es sobre la base lógica 0, que es la que usa la API (REDIS_URL no lleva índice).
// El setup la vacía con FLUSHDB, nunca con FLUSHALL: los datos que alguien tenga en las bases
// 1–15 del mismo Redis no son del entorno y no se tocan. Lo que se cuenta para decidir si
// hace falta confirmación (DBSIZE) es la misma base 0 que se vacía.

/**
 * @typedef {(command: string[]) => Promise<string>} RedisCli ejecuta un comando y devuelve su salida
 */

/**
 * @param {string} project proyecto de docker compose
 * @returns {RedisCli}
 */
export function composeRedisCli(project) {
  return async (command) => {
    const output = await compose(project, ["exec", "-T", "redis", "redis-cli", ...command], {
      quiet: true,
    });
    return output.trim();
  };
}

/**
 * Cuántas claves tiene la base 0 del Redis y si lleva la marca de un `pnpm dev:setup` previo.
 *
 * @param {RedisCli} cli
 * @returns {Promise<{ keys: number; marked: boolean }>}
 */
export async function inspectRedis(cli) {
  const keys = Number.parseInt(await cli(["DBSIZE"]), 10);
  if (!Number.isInteger(keys)) throw new Error("Redis no contestó cuántas claves tiene (DBSIZE).");
  const marked = (await cli(["EXISTS", REDIS_MARK_KEY])) === "1";
  return { keys, marked };
}

/**
 * Vacía la base 0 (FLUSHDB). No toca las bases 1–15.
 *
 * @param {RedisCli} cli
 */
export async function flushRedis(cli) {
  await cli(["FLUSHDB"]);
}

/** @param {RedisCli} cli */
export async function markRedis(cli) {
  await cli(["SET", REDIS_MARK_KEY, "1"]);
}
