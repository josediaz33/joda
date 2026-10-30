import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline/promises";
import { COMPOSE_FILE, ENV_LOCAL_PATH, REPO_ROOT } from "./config.mjs";

// Ejecución de procesos para los scripts de scripts/dev/ (WP-M18). Sin `shell`:
// en Windows `pnpm` es un `.cmd` y con shell las rutas con espacios (el repo
// de José está en "JODA Parfums ERP Ecomm") se parten. Por eso los scripts
// llaman a `node`, `docker` y los `.mjs`/`.js` de las dependencias directo.

export function log(message) {
  console.log(`[dev] ${message}`);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ env?: Record<string, string | undefined>; cwd?: string; quiet?: boolean }} [options]
 * @returns {Promise<{ code: number; stdout: string }>}
 */
export function run(command, args, { env, cwd = REPO_ROOT, quiet = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });
    let stdout = "";
    if (quiet) {
      child.stdout?.on("data", (chunk) => (stdout += chunk));
      child.stderr?.on("data", (chunk) => (stdout += chunk));
    }
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout }));
  });
}

/**
 * Corre y exige código 0.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {Parameters<typeof run>[2]} [options]
 */
export async function runOrFail(command, args, options) {
  const { code, stdout } = await run(command, args, options);
  if (code !== 0) {
    throw new Error(
      `"${command} ${args.join(" ")}" terminó con código ${code}.${stdout ? `\n${stdout}` : ""}`,
    );
  }
  return stdout;
}

/**
 * @param {() => Promise<boolean | void> | boolean | void} check
 * @param {{ what: string; timeoutMs?: number; intervalMs?: number }} options
 */
export async function waitFor(check, { what, timeoutMs = 120_000, intervalMs = 1_000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if ((await check()) !== false) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, intervalMs));
  }
  throw new Error(
    `Se agotó la espera de ${what} (${Math.round(timeoutMs / 1000)} s).${lastError ? ` Último error: ${lastError.message ?? lastError}` : ""}`,
  );
}

/**
 * @param {string} url
 * @param {{ what: string; timeoutMs?: number }} options
 */
export async function waitForHttp(url, { what, timeoutMs }) {
  await waitFor(
    async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      return response.status < 500;
    },
    { what, timeoutMs },
  );
}

export async function assertDockerIsRunning() {
  const { code } = await run("docker", ["info"], { quiet: true }).catch(() => ({ code: 127 }));
  if (code !== 0) {
    throw new Error(
      "Docker no responde. Abrí Docker Desktop, esperá a que diga «Engine running» y volvé a correr el comando (docs/runbooks/entorno-local.md, «Problemas frecuentes»).",
    );
  }
}

/**
 * `docker compose` con el proyecto y el `.env.local` de este entorno; el perfil
 * `auth` siempre activo (GoTrue y su proxy).
 *
 * @param {string} project
 * @param {string[]} args
 * @param {Parameters<typeof run>[2]} [options]
 */
export function compose(project, args, options) {
  return runOrFail(
    "docker",
    [
      "compose",
      "-p",
      project,
      "--env-file",
      ENV_LOCAL_PATH,
      "-f",
      COMPOSE_FILE,
      "--profile",
      "auth",
      ...args,
    ],
    options,
  );
}

/**
 * Falla con un mensaje claro si algún puerto de host ya está ocupado (otra
 * instancia del entorno, un Postgres nativo, un `pnpm dev` abierto): sin esto,
 * lo que contesta en ese puerto no es lo que el script cree.
 *
 * @param {ReadonlyArray<readonly [string, number]>} ports nombre de la variable y número
 */
export async function assertPortsFree(ports) {
  for (const [name, port] of ports) {
    // IPv4 e IPv6: `localhost` resuelve a uno u otro según la máquina, y en
    // Windows ocupar [::1]:puerto no impide abrir 127.0.0.1:puerto.
    for (const host of ["127.0.0.1", "::1"]) {
      await new Promise((done, reject) => {
        const probe = createServer();
        probe.once("error", (error) => {
          // Sin IPv6 en la máquina no hay nada que chocar.
          if (error.code !== "EADDRINUSE") return done(undefined);
          reject(
            new Error(
              `El puerto ${port} (${name}) ya está en uso en esta máquina. Cerrá lo que lo usa o elegí otro con ${name}=<puerto> (docs/runbooks/entorno-local.md, «Problemas frecuentes»).`,
            ),
          );
        });
        probe.listen(port, host, () => probe.close(() => done(undefined)));
      });
    }
  }
}

/**
 * Hace una pregunta en la terminal y devuelve lo que se escribió. Solo para cuando hay
 * terminal (`process.stdin.isTTY`): sin ella, el que llama no pregunta.
 *
 * @param {string} question
 */
export async function askQuestion(question) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
}
