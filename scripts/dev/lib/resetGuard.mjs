// Confirmación antes de borrar lo que `pnpm dev:setup` no creó (WP-M18).
//
// `pnpm dev:setup` reinicia la base `joda` (db:reset) y vacía el Redis de su proyecto de
// compose (FLUSHALL). Con los valores por defecto (proyecto `joda`, puertos 55432 y 6379)
// esos son los mismos contenedores del Postgres y el Redis de desarrollo de siempre, que
// pueden tener datos de quien lo corre. El entorno local es descartable POR DEFINICIÓN
// solo cuando lo creó este mismo setup: por eso cada reinicio deja una marca (un
// comentario en la base y una clave en Redis) y el siguiente solo procede sin preguntar si
// la encuentra. Si la base tiene tablas o Redis tiene claves y no hay marca, hace falta
// confirmación explícita.

/** Comentario de la base `joda` que deja `pnpm dev:setup` (`COMMENT ON DATABASE`). */
export const DATABASE_MARK = "joda-dev-setup:1";
/** Clave de Redis que deja `pnpm dev:setup` (valor irrelevante). */
export const REDIS_MARK_KEY = "joda:dev-setup";

const AFFIRMATIVE_ANSWERS = new Set(["s", "si", "sí", "y", "yes"]);

/**
 * @typedef {{ tables: number; marked: boolean }} DatabaseState
 * @typedef {{ keys: number; marked: boolean }} RedisState
 */

/**
 * ¿Hay algo que perder? Solo lo que tiene datos Y no lleva la marca de un setup previo.
 *
 * @param {{ database: DatabaseState; redis: RedisState; ports: { postgres: number; redis: number } }} state
 * @returns {string[]} una razón por cada cosa que se borraría sin que la haya creado el setup
 */
export function unmarkedDataReasons({ database, redis, ports }) {
  /** @type {string[]} */
  const reasons = [];
  if (database.tables > 0 && !database.marked) {
    reasons.push(
      `la base «joda» de 127.0.0.1:${ports.postgres} tiene ${database.tables} tablas y no la creó \`pnpm dev:setup\` (db:reset las borra)`,
    );
  }
  if (redis.keys > 0 && !redis.marked) {
    reasons.push(
      `el Redis de 127.0.0.1:${ports.redis} tiene ${redis.keys} claves y no lo preparó \`pnpm dev:setup\` (FLUSHALL las borra)`,
    );
  }
  return reasons;
}

/**
 * ¿El usuario ya confirmó de antemano? `--yes` en la línea de comandos o `JODA_DEV_SETUP_YES=1`.
 *
 * @param {{ argv: readonly string[]; env: Record<string, string | undefined> }} input
 */
export function isPreConfirmed({ argv, env }) {
  const flag = env.JODA_DEV_SETUP_YES?.trim().toLowerCase();
  return argv.includes("--yes") || flag === "1" || flag === "true";
}

/**
 * Lanza si el setup está por borrar datos que no creó él y nadie lo confirmó.
 *
 * - Sin datos sin marca: sigue, sin preguntar.
 * - Con `--yes` / `JODA_DEV_SETUP_YES=1`: sigue (avisa qué va a borrar).
 * - En una terminal: pregunta y sigue solo con una respuesta afirmativa.
 * - Sin terminal y sin la bandera: se niega con un mensaje que dice cómo seguir.
 *
 * @param {{
 *   state: { database: DatabaseState; redis: RedisState; ports: { postgres: number; redis: number } };
 *   argv: readonly string[];
 *   env: Record<string, string | undefined>;
 *   interactive: boolean;
 *   ask: (question: string) => Promise<string>;
 *   warn: (message: string) => void;
 * }} input
 */
export async function confirmDestructiveReset({ state, argv, env, interactive, ask, warn }) {
  const reasons = unmarkedDataReasons(state);
  if (reasons.length === 0) return;

  const list = reasons.map((reason) => `  - ${reason}`).join("\n");

  if (isPreConfirmed({ argv, env })) {
    warn(`se borra lo que no creó este setup, confirmado con --yes / JODA_DEV_SETUP_YES:\n${list}`);
    return;
  }

  if (!interactive) {
    throw new Error(
      `\`pnpm dev:setup\` se niega a borrar datos que no creó él:\n${list}\n\nSi es un entorno de desarrollo descartable, repetí el comando con --yes (\`pnpm dev:setup --yes\`) o con JODA_DEV_SETUP_YES=1. Si tiene datos que querés conservar, hacé antes un \`pg_dump\`, o elegí otro proyecto de compose y otros puertos (docs/runbooks/entorno-local.md, sección 3).`,
    );
  }

  const answer = await ask(
    `\`pnpm dev:setup\` va a borrar datos que no creó él:\n${list}\n\n¿Seguir y borrarlos? (escribí «si» para confirmar): `,
  );
  if (!AFFIRMATIVE_ANSWERS.has(answer.trim().toLowerCase())) {
    throw new Error("Cancelado: no se borró nada.");
  }
}
