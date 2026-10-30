import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { ENV_LOCAL_PATH, REPO_ROOT } from "./config.mjs";
import { parseDotenv } from "./dotenv.mjs";
import { runOrFail, waitForHttp } from "./process.mjs";

/** Lee `.env.local` o explica cómo crearlo. */
export function readLocalEnv() {
  if (!existsSync(ENV_LOCAL_PATH)) {
    throw new Error(
      "No existe .env.local. Corré `pnpm dev:setup` primero: genera el archivo, levanta Docker y siembra los datos (docs/runbooks/entorno-local.md).",
    );
  }
  return parseDotenv(readFileSync(ENV_LOCAL_PATH, "utf8"));
}

const TURBO_BIN = join(REPO_ROOT, "node_modules", "turbo", "bin", "turbo");

/**
 * Compila los paquetes de los que dependen la API y el admin (`dist/`): la API
 * los consume compilados, y sin esto `tsx` falla al importar `@joda/domain`.
 * Turbo lo cachea: la segunda vez es instantáneo.
 *
 * @param {string[]} [targets]
 */
export async function buildWorkspaceDependencies(targets = ["@joda/api", "@joda/admin"]) {
  await runOrFail(
    process.execPath,
    [TURBO_BIN, "run", "build", ...targets.map((target) => `--filter=${target}^...`)],
    { env: { TURBO_TELEMETRY_DISABLED: "1" } },
  );
}

/**
 * Levanta la API con el `.env.local` (para sembrar los datos de muestra) y
 * devuelve cómo apagarla. Es el mismo arranque que `pnpm dev` (`tsx`), sin
 * `watch`: nada de lo que se siembra necesita recargar.
 *
 * @param {Record<string, string>} values
 */
export async function startApiForSeeding(values) {
  const requireFromApi = createRequire(join(REPO_ROOT, "apps", "api", "package.json"));
  const tsxCli = requireFromApi.resolve("tsx/cli");
  const apiCwd = join(REPO_ROOT, "apps", "api");

  const child = spawn(process.execPath, [tsxCli, `--env-file=${ENV_LOCAL_PATH}`, "src/index.ts"], {
    cwd: apiCwd,
    env: { ...process.env, ...values },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  async function stop() {
    if (exited || child.pid === undefined) return;
    if (process.platform === "win32") {
      // tsx lanza el proceso de la API como hijo: `kill()` solo mataría al lanzador.
      await new Promise((done) => {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
        killer.on("close", done);
        killer.on("error", done);
      });
    } else {
      child.kill("SIGTERM");
    }
  }

  try {
    await waitForHttp(`${values.JODA_API_URL}/`, {
      what: "que la API responda (¿falta `pnpm build` de los paquetes o hay un puerto ocupado?)",
      timeoutMs: 90_000,
    });
    if (exited) throw new Error("La API terminó apenas arrancó.");
  } catch (error) {
    await stop();
    throw new Error(`${error.message}\n--- salida de la API ---\n${output.slice(-3000)}`);
  }
  return { stop, output: () => output };
}
