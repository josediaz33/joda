import { compose } from "./process.mjs";
import { REDIS_MARK_KEY } from "./resetGuard.mjs";

// El Redis del entorno local se maneja con `redis-cli` DENTRO del contenedor (WP-M18): el
// repo no depende de ningún cliente de Redis para esto, y no hay nada que instalar en el host.

/**
 * @param {string} project
 * @param {string[]} command
 */
async function redisCli(project, command) {
  const output = await compose(project, ["exec", "-T", "redis", "redis-cli", ...command], {
    quiet: true,
  });
  return output.trim();
}

/**
 * Cuántas claves tiene el Redis del proyecto y si lleva la marca de un `pnpm dev:setup` previo.
 *
 * @param {string} project
 * @returns {Promise<{ keys: number; marked: boolean }>}
 */
export async function inspectRedis(project) {
  const keys = Number.parseInt(await redisCli(project, ["DBSIZE"]), 10);
  if (!Number.isInteger(keys)) throw new Error("Redis no contestó cuántas claves tiene (DBSIZE).");
  const marked = (await redisCli(project, ["EXISTS", REDIS_MARK_KEY])) === "1";
  return { keys, marked };
}

/** @param {string} project */
export async function flushRedis(project) {
  await redisCli(project, ["FLUSHALL"]);
}

/** @param {string} project */
export async function markRedis(project) {
  await redisCli(project, ["SET", REDIS_MARK_KEY, "1"]);
}
