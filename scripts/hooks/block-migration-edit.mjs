#!/usr/bin/env node
// PreToolUse, matcher "Edit|Write" (ver .claude/settings.json y
// CONTRIBUTING.md § Automatización).
//
// CONTRIBUTING.md §6 y ADR-018: nunca editar una migración ya APLICADA —
// aplicada significa fusionada a `main` y corrida en algún entorno real,
// no "existe como archivo en el árbol de trabajo actual". La versión
// anterior de este guarda bloqueaba por existsSync() en disco, lo que
// también bloqueaba editar una migración nueva de una rama sin fusionar
// todavía (donde sí es correcto poder editarla) — más estricto que la
// regla que implementa, lo cual empuja a bypasear el hook en vez de
// respetarlo. Corregido en la revisión cruzada de PR #50 (WP-B08): la
// condición pasa a ser si el archivo existe en el árbol de `main`.
//
// La lógica de detección vive en lib/migration-guard.mjs (testeada aparte
// en lib/migration-guard.test.mjs, con un repo git temporal real, no un
// mock) — este archivo solo lee stdin y decide el código de salida.
import { readHookInput, toPosixPath } from "./_read-hook-input.mjs";
import {
  existsInMainBranch,
  isMigrationFilePath,
  migrationRepoRelativePath,
} from "./lib/migration-guard.mjs";

const input = await readHookInput();
const filePath = input?.tool_input?.file_path;

if (!filePath) process.exit(0);
if (!isMigrationFilePath(filePath)) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const relativePath = migrationRepoRelativePath(filePath);

let alreadyInMain;
try {
  alreadyInMain = existsInMainBranch(relativePath, { cwd: projectDir });
} catch (error) {
  console.error(`Bloqueado: ${error.message}`);
  process.exit(2);
}

if (alreadyInMain) {
  console.error(
    `Bloqueado: ${toPosixPath(filePath)} ya está fusionado a main. Las migraciones no se ` +
      "editan una vez aplicadas (CONTRIBUTING.md §6, ADR-018). Si el cambio es necesario, " +
      "creá una migración nueva numerada a continuación en " +
      "packages/db/migrations/ en vez de tocar esta.",
  );
  process.exit(2);
}

process.exit(0);
