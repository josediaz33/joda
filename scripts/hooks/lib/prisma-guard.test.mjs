// node --test scripts/hooks/lib/  (ver "test:hooks" en package.json)
import { test } from "node:test";
import assert from "node:assert/strict";
import { findBlockedPrismaSegment } from "./prisma-guard.mjs";

test("bloquea prisma migrate simple", () => {
  assert.ok(findBlockedPrismaSegment("npx prisma migrate dev"));
});

test("bloquea con mayúsculas y espacios múltiples entre prisma y migrate", () => {
  assert.ok(findBlockedPrismaSegment("PRISMA   MIGRATE deploy"));
});

test("bloquea dentro de un comando compuesto con &&, aunque vaya después", () => {
  assert.ok(findBlockedPrismaSegment("echo ok && npx prisma migrate dev"));
});

test("bloquea en la segunda sentencia separada por ;", () => {
  assert.ok(findBlockedPrismaSegment("pnpm install; npx prisma migrate dev"));
});

test("bloquea en la segunda línea de un comando multilínea (sentencias separadas por salto de línea)", () => {
  assert.ok(findBlockedPrismaSegment("echo uno\nnpx prisma migrate dev"));
});

test("bloquea con una continuación de línea de Bash entre prisma y migrate (evasión por barra + salto)", () => {
  assert.ok(findBlockedPrismaSegment("npx prisma \\\nmigrate dev"));
});

test("bloquea prisma@version migrate", () => {
  assert.ok(findBlockedPrismaSegment("npx prisma@5.9.1 migrate dev"));
});

test("bloquea prisma db push", () => {
  assert.ok(findBlockedPrismaSegment("npx prisma db push"));
});

test("bloquea prisma db push con espacio múltiple entre db y push", () => {
  assert.ok(findBlockedPrismaSegment("npx prisma db   push --accept-data-loss"));
});

test("no bloquea un comando inocuo", () => {
  assert.equal(findBlockedPrismaSegment("pnpm test"), null);
});

test("no bloquea prisma generate", () => {
  assert.equal(findBlockedPrismaSegment("npx prisma generate"), null);
});

test("no bloquea prisma db pull (lo usa db:pull)", () => {
  assert.equal(findBlockedPrismaSegment("npx prisma db pull"), null);
});

test("no bloquea un comando vacío o indefinido", () => {
  assert.equal(findBlockedPrismaSegment(""), null);
  assert.equal(findBlockedPrismaSegment(undefined), null);
});
