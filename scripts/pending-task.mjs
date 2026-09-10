#!/usr/bin/env node
// Stub para scripts de pnpm que CLAUDE.md documenta pero que todavía no
// están implementados. Existen para que la interfaz de comandos sea
// estable desde el día uno (WP-A01); dejan de ser un stub cuando se toma
// el paquete de trabajo que les da contenido real.
//
// Uso: node scripts/pending-task.mjs "<script>" <WP-nn>
const [, , label, wp] = process.argv;

if (!label) {
  console.error("Uso: pending-task.mjs <script> [WP-nn]");
  process.exit(1);
}

const ref = wp ? ` — ver docs/backlog.md (${wp})` : " — ver docs/backlog.md";
console.log(`[pendiente] ${label}${ref}`);
