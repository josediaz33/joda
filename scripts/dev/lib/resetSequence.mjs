// El orden de lo destructivo en `pnpm dev:setup` (WP-M18). Vive acá, con los pasos
// inyectados, para poder probar que una falla ANTES del reset no deja marcada una base
// que todavía tiene datos: la marca (resetGuard.mjs) dice «esta base la reinicia el setup»
// y la siguiente corrida se apoya en ella para no preguntar.

/**
 * @param {{
 *   confirm: () => Promise<void>;
 *   prepareAuth: () => Promise<void>;
 *   markDatabase: () => Promise<void>;
 *   resetDatabase: () => Promise<void>;
 *   flushRedis: () => Promise<void>;
 *   markRedis: () => Promise<void>;
 * }} steps
 */
export async function resetLocalState(steps) {
  // 1. Nada se toca hasta que se confirma (o no hay nada que perder).
  await steps.confirm();
  // 2. Todo lo que puede fallar sin haber borrado nada (bajar la imagen de GoTrue, crear su
  //    base) va ANTES de marcar: si falla, la base conserva sus datos y sigue sin marca.
  await steps.prepareAuth();
  // 3. La marca se deja justo antes de lanzar el reset. db:reset borra esquemas, no la base,
  //    así que la marca sobrevive; y si el reset se corta a la mitad, la base ya perdió lo
  //    que tenía y la próxima corrida no tiene nada que preguntar.
  await steps.markDatabase();
  await steps.resetDatabase();
  // 4. Redis recién cuando la base ya se reinició: las sesiones en caché eran de la anterior.
  await steps.flushRedis();
  await steps.markRedis();
}
