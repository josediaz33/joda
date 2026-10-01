import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { tsconfigPaths: true },
  server: { proxy: { "/trpc": "http://localhost:3333" } },
  build: { manifest: true },
  test: { testTimeout: 20_000 },
});
