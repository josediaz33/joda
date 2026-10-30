import { existsSync, readFileSync } from "node:fs";
import { ENV_LOCAL_PATH } from "../../scripts/dev/lib/config.mjs";
import { parseDotenv } from "../../scripts/dev/lib/dotenv.mjs";

export interface E2eEnv {
  /** Origen del admin (Vite): lo que abre el navegador. */
  readonly adminUrl: string;
  /** Origen de la API, por si un spec prepara o comprueba datos sin pasar por la pantalla. */
  readonly apiUrl: string;
}

/** Lee `.env.local` (lo genera `pnpm dev:setup`); sin él no hay contra qué correr. */
export function readE2eEnv(): E2eEnv {
  if (!existsSync(ENV_LOCAL_PATH)) {
    throw new Error(
      "No existe .env.local: corré `pnpm dev:setup` antes del humo (docs/runbooks/entorno-local.md).",
    );
  }
  const values = parseDotenv(readFileSync(ENV_LOCAL_PATH, "utf8"));
  const adminUrl = values.ADMIN_URL;
  const apiUrl = values.JODA_API_URL;
  if (!adminUrl || !apiUrl) {
    throw new Error(".env.local no tiene ADMIN_URL/JODA_API_URL: volvé a correr `pnpm dev:setup`.");
  }
  return { adminUrl, apiUrl };
}
