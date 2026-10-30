// Barandas del entorno de desarrollo (WP-M18). Los scripts de `scripts/dev/`
// crean usuarios con contraseñas CONOCIDAS (están en el runbook), escriben
// datos de muestra y reinician la base: nada de eso puede correr contra
// producción, ni contra una máquina que no sea esta. Cada script de entrada
// llama a `assertDevelopmentEnvironment` ANTES de hacer cualquier cosa.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * @param {string} value
 * @returns {string | null} el hostname, o null si no es una URL
 */
function hostnameOf(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/**
 * @param {string} hostname
 */
export function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * Lanza si el entorno no es de desarrollo local:
 *   - `NODE_ENV=production` (o `JODA_ENV=production`): nunca.
 *   - cualquiera de las URLs que el script va a tocar apunta fuera de esta máquina.
 *
 * @param {{ env: Record<string, string | undefined>; urls?: ReadonlyArray<readonly [string, string | undefined]> }} input
 */
export function assertDevelopmentEnvironment({ env, urls = [] }) {
  if (env.NODE_ENV === "production" || env.JODA_ENV === "production") {
    throw new Error(
      "Los scripts de scripts/dev/ no corren con NODE_ENV=production: crean usuarios con contraseñas de desarrollo y datos de muestra, y reinician la base. Son solo para el entorno local (docs/runbooks/entorno-local.md).",
    );
  }
  for (const [name, value] of urls) {
    if (!value) continue;
    const hostname = hostnameOf(value);
    if (hostname === null || !isLoopbackHost(hostname)) {
      throw new Error(
        `${name} no apunta a esta máquina (localhost/127.0.0.1): los scripts de scripts/dev/ solo corren contra el entorno local.`,
      );
    }
  }
}
