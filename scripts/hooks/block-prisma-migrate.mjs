#!/usr/bin/env node
// PreToolUse, matcher "Bash" (ver .claude/settings.json y
// CONTRIBUTING.md § Automatización).
//
// ADR-018 prohíbe `prisma migrate dev`: el esquema es SQL escrito a mano en
// packages/db/migrations/, y schema.prisma se regenera por introspección con
// `pnpm db:pull`. Un `prisma migrate` corrido a mano crea una migración que
// el repositorio no versiona y que diverge del historial real.
//
// Exit code 2 bloquea la llamada a Bash y el stderr vuelve a Claude como
// motivo (contrato de PreToolUse).
import { readHookInput } from "./_read-hook-input.mjs";

const input = await readHookInput();
const command = String(input?.tool_input?.command ?? "");

if (/prisma\s+migrate/i.test(command)) {
  console.error(
    "Bloqueado por ADR-018 (SQL-first): nunca `prisma migrate`. " +
      "El esquema es SQL escrito a mano en packages/db/migrations/; " +
      "schema.prisma se regenera por introspección con `pnpm db:pull`. " +
      "Ver docs/adr/018-sql-first.md y packages/db/README.md.",
  );
  process.exit(2);
}

process.exit(0);
