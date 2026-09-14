#!/usr/bin/env node
// Stop, async: true (ver .claude/settings.json y CONTRIBUTING.md §
// Automatización).
//
// Corre pnpm typecheck, lint y test al terminar el turno y deja el
// resultado en un log — no en el chat: un hook `async` corre en paralelo y
// no hay forma documentada de que su salida se inyecte de vuelta en la
// conversación (ver la nota de incertidumbre en CONTRIBUTING.md sobre este
// punto). Por eso es un chequeo de higiene de fondo, no el reemplazo de
// correr `pnpm typecheck && pnpm lint && pnpm test` a mano antes de un PR
// (AGENTS.md/CLAUDE.md § Cómo verificar tu trabajo) — accountability real
// sigue siendo la de esa lista.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir =
  process.env.CLAUDE_PROJECT_DIR ?? path.resolve(fileURLToPath(import.meta.url), "../../..");

const STEPS = ["typecheck", "lint", "test"];
const PER_STEP_TIMEOUT_MS = 10 * 60 * 1000;

const results = STEPS.map((step) => {
  // shell: true es necesario en Windows: "pnpm" resuelve a pnpm.CMD, y
  // spawnSync no ejecuta .cmd/.bat directamente sin pasar por una shell.
  const run = spawnSync("pnpm", [step], {
    cwd: projectDir,
    encoding: "utf8",
    timeout: PER_STEP_TIMEOUT_MS,
    shell: true,
  });
  return {
    step,
    ok: run.status === 0,
    timedOut: run.error?.code === "ETIMEDOUT",
    output:
      `${run.stdout ?? ""}${run.stderr ?? ""}${run.error ? `\n${run.error.stack}` : ""}`.trim(),
  };
});

const allOk = results.every((r) => r.ok);
const timestamp = new Date().toISOString();

const report = [
  `Verificación de Stop hook — ${timestamp}`,
  allOk ? "RESULTADO: todo en verde" : "RESULTADO: hay fallas",
  "",
  ...results.flatMap((r) => [
    `## pnpm ${r.step} — ${r.ok ? "OK" : r.timedOut ? "TIMEOUT" : "FALLÓ"}`,
    r.output || "(sin salida)",
    "",
  ]),
].join("\n");

const logDir = path.join(projectDir, ".claude", "hook-logs");
mkdirSync(logDir, { recursive: true });
writeFileSync(path.join(logDir, "stop-verify-latest.log"), report, "utf8");

if (allOk) {
  console.log(
    `[verify-on-stop] typecheck+lint+test en verde. Log: ${logDir}/stop-verify-latest.log`,
  );
} else {
  const failed = results.filter((r) => !r.ok).map((r) => r.step);
  console.error(
    `[verify-on-stop] fallaron: ${failed.join(", ")}. Detalle en ${logDir}/stop-verify-latest.log`,
  );
}

process.exit(0);
