import { readE2eTargets } from "../../scripts/dev/lib/e2eEnv.mjs";

export interface E2eEnv {
  /** Origen del admin (Vite): lo que abre el navegador. */
  readonly adminUrl: string;
  /** Origen de la API, por si un spec prepara o comprueba datos sin pasar por la pantalla. */
  readonly apiUrl: string;
}

/**
 * Lee `.env.local` (lo genera `pnpm dev:setup`); sin él no hay contra qué correr. Se
 * niega con NODE_ENV/JODA_ENV=production y si el admin o la API no están en esta máquina:
 * lo comprueba `readE2eTargets` (scripts/dev/lib/e2eEnv.mjs), así que vale también para
 * quien corre `playwright test` sin pasar por `pnpm e2e:smoke`.
 */
export function readE2eEnv(): E2eEnv {
  return readE2eTargets();
}
