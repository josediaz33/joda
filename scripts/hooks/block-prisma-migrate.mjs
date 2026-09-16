#!/usr/bin/env node
// PreToolUse, matcher "Bash" (ver .claude/settings.json y
// CONTRIBUTING.md § Automatización).
//
// ADR-018 prohíbe `prisma migrate dev` y `prisma db push`: el esquema es SQL
// escrito a mano en packages/db/migrations/, y schema.prisma se regenera por
// introspección con `pnpm db:pull`. Cualquiera de los dos crea o reescribe
// el esquema por fuera de ese flujo.
//
// La lógica de detección vive en lib/prisma-guard.mjs (testeada aparte en
// lib/prisma-guard.test.mjs) — este archivo solo lee stdin y decide el
// código de salida.
//
// Exit code 2 bloquea la llamada a Bash y el stderr vuelve a Claude como
// motivo (contrato de PreToolUse).
import { readHookInput } from "./_read-hook-input.mjs";
import { findBlockedPrismaSegment } from "./lib/prisma-guard.mjs";

const input = await readHookInput();
const command = String(input?.tool_input?.command ?? "");

const blockedSegment = findBlockedPrismaSegment(command);
if (blockedSegment) {
  console.error(
    "Bloqueado por ADR-018 (SQL-first): nunca `prisma migrate` ni `prisma db push`. " +
      `Sentencia detectada: "${blockedSegment.trim()}". ` +
      "El esquema es SQL escrito a mano en packages/db/migrations/; " +
      "schema.prisma se regenera por introspección con `pnpm db:pull`. " +
      "Ver docs/adr/018-sql-first.md y packages/db/README.md.",
  );
  process.exit(2);
}

process.exit(0);
