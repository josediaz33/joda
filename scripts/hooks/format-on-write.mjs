#!/usr/bin/env node
// PostToolUse, matcher "Edit|Write" (ver .claude/settings.json y
// CONTRIBUTING.md § Automatización).
//
// Corre prettier --write sobre el archivo que la herramienta acaba de tocar,
// solo si la extensión es ts/tsx/md/json. Nunca bloquea el turno: si
// prettier falla (archivo con sintaxis rota a medio editar, por ejemplo), se
// reporta a stderr y se sale en 0 — formatear es una cortesía, no un gate.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readHookInput } from "./_read-hook-input.mjs";

const FORMATTABLE_EXT = new Set([".ts", ".tsx", ".md", ".json"]);

const input = await readHookInput();
const filePath = input?.tool_input?.file_path;

if (!filePath) process.exit(0);
if (!FORMATTABLE_EXT.has(path.extname(filePath))) process.exit(0);
if (!existsSync(filePath)) process.exit(0); // el hook de Write pudo borrarlo o el path no es real

const projectDir =
  process.env.CLAUDE_PROJECT_DIR ?? path.resolve(fileURLToPath(import.meta.url), "../../..");

// Solo archivos DENTRO del repo: un Write/Edit sobre un scratchpad o un
// archivo temporal fuera del proyecto no debe arrastrar el estilo de
// Prettier de este monorepo ni depender de que exista en esa ruta.
const relativeToProject = path.relative(projectDir, path.resolve(filePath));
if (relativeToProject.startsWith("..") || path.isAbsolute(relativeToProject)) {
  process.exit(0);
}

const prettierBin = path.join(projectDir, "node_modules", "prettier", "bin", "prettier.cjs");

if (!existsSync(prettierBin)) {
  console.error(`[format-on-write] no se encontró prettier en ${prettierBin}; ¿pnpm install?`);
  process.exit(0);
}

const result = spawnSync(process.execPath, [prettierBin, "--write", filePath], {
  cwd: projectDir,
  encoding: "utf8",
});

if (result.status !== 0) {
  console.error(`[format-on-write] prettier no pudo formatear ${filePath}:`);
  console.error(result.stderr || result.stdout);
}

process.exit(0);
