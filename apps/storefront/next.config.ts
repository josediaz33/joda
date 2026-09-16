import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js 16 escribe AGENTS.md/CLAUDE.md propios en este directorio en
  // cada `next dev`/`next build` (ver node_modules/next/dist/server/lib/
  // generate-agent-files.js). Este repo ya gobierna AGENTS.md/CLAUDE.md
  // desde la raíz (ver AGENTS.md § Herramientas por agente) — un segundo
  // archivo con el mismo nombre acá adentro compite con esa fuente única.
  agentRules: false,
};

export default nextConfig;
