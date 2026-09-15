#!/usr/bin/env node
// PreToolUse, matcher "Edit|Write" (ver .claude/settings.json y
// CONTRIBUTING.md § Automatización).
//
// CONTRIBUTING.md §6 y ADR-018: nunca editar una migración ya aplicada,
// siempre una nueva. El proxy mecánico es simple a propósito: si el archivo
// packages/db/migrations/*.sql YA EXISTE en disco, tocarlo (Edit siempre, o
// un Write que lo sobrescriba) se bloquea. Crear un archivo .sql nuevo en
// ese directorio (Write sobre un path que no existe todavía) se permite.
//
// Esto no sabe si la migración llegó a aplicarse contra una base real —
// no tiene forma de saberlo desde un hook— pero "ya existe en el repo" es
// la señal disponible y es la misma que exige la regla: una migración
// commiteada no se toca, se reemplaza por una nueva numerada.
//
// La lógica de "¿esta ruta es una migración?" vive en lib/migration-guard.mjs
// (testeada aparte en lib/migration-guard.test.mjs, con el path real que
// Windows manda — con backslashes) — este archivo solo hace la parte de I/O
// (leer stdin, existsSync) y decide el código de salida.
import { existsSync } from "node:fs";
import { readHookInput, toPosixPath } from "./_read-hook-input.mjs";
import { isMigrationFilePath } from "./lib/migration-guard.mjs";

const input = await readHookInput();
const filePath = input?.tool_input?.file_path;

if (!filePath) process.exit(0);
if (!isMigrationFilePath(filePath)) process.exit(0);

if (existsSync(filePath)) {
  console.error(
    `Bloqueado: ${toPosixPath(filePath)} ya existe. Las migraciones no se editan una vez ` +
      "commiteadas (CONTRIBUTING.md §6, ADR-018). Si el cambio es necesario, " +
      "creá una migración nueva numerada a continuación en " +
      "packages/db/migrations/ en vez de tocar esta.",
  );
  process.exit(2);
}

process.exit(0);
