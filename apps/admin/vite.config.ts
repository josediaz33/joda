import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// WP-M18: el entorno local (`pnpm dev:setup`) escribe `.env.local` en la raíz del
// repo. Acá solo se leen las variables JODA_* —el puerto del admin y a dónde apunta el
// proxy—; ningún secreto de ese archivo llega a este proceso ni al navegador (Vite solo
// expone al cliente las que empiezan con VITE_, y `loadEnv` acá filtra por JODA_).
// Sin `.env.local` valen los defaults de siempre: admin en 5173, API en 3333.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, REPO_ROOT, "JODA_");
  const apiUrl = env.JODA_API_URL || "http://127.0.0.1:3333";

  return {
    plugins: [react(), tailwindcss()],
    resolve: { tsconfigPaths: true },
    server: {
      port: Number(env.JODA_ADMIN_PORT) || 5173,
      // Un puerto ocupado es un error, no un salto silencioso al siguiente: la cookie de
      // sesión, la URL del runbook y el humo de Playwright suponen este puerto.
      strictPort: true,
      // Mismo origen para el navegador: la cookie `__Host-joda_a` (httpOnly, Secure,
      // SameSite=Strict) viaja sin CORS. Chrome y Edge aceptan una cookie Secure sobre
      // http://localhost.
      proxy: { "/trpc": apiUrl, "/media/products": apiUrl },
    },
    build: { manifest: true },
    test: { testTimeout: 20_000 },
  };
});
