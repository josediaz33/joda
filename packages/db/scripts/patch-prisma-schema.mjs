#!/usr/bin/env node
// Parche determinístico sobre schema.prisma, aplicado entre `prisma db pull`
// y `prisma generate` (ver el script "db:pull" de package.json).
//
// Por qué existe: cuando la PK de una tabla es una sola columna y esa misma
// columna es el comienzo de una FK compuesta, la relación es uno a uno y
// las columnas de la FK son unique por transitividad — pero Prisma
// introspecciona uniqueness de forma literal, no transitiva, y sin una
// anotación @@unique en el modelo el generador de cliente falla con P1012
// ("A one-to-one relation must use unique fields on the defining side").
// Un UNIQUE real en Postgres tampoco sirve: Prisma lo omite por redundante
// con el @id. https://github.com/prisma/prisma/issues/10390
//
// Casos de hoy:
//   · (product_id, kind) -> products(id, kind) en las tablas de detalle
//     (docs/data-model.md §8): impide que un `watch` tenga `perfume_details`.
//   · (product_id, tenant_id) en las mismas tablas y (lot_id, tenant_id) en
//     inventory_balances (WP-B08c, 0023): las FK compuestas con tenant.
// No es una regla de negocio: las FKs ya hacen cumplir el invariante real.
//
// El script inserta la anotación en cada corrida de `db:pull`, así que
// sobrevive a que `schema.prisma` se reescriba entero en cada introspección
// sin que nadie tenga que acordarse de re-anotarlo a mano (ADR-018 prohíbe
// editar schema.prisma a mano; esto no es una edición manual, es parte del
// script).
//
// Detecta genéricamente toda relación cuyo primer campo es el @id de una
// sola columna del modelo y que tiene más de un campo — la próxima vertical
// o la próxima FK compuesta quedan cubiertas sin tocar este archivo.
// Después de parchar vuelve a escanear el resultado: si algún modelo que
// necesitaba la anotación se quedó sin ella, corta con exit 1 en vez de
// escribir un schema roto en silencio — `prisma generate` fallaría de todos
// modos con P1012, pero acá el error señala la causa real.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dbRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaPath = join(dbRoot, "prisma", "schema.prisma");

const modelRegex = /^model (\w+) \{\n([\s\S]*?)\n\}/gm;
const idFieldRegex = /^\s*(\w+)\s+\S+.*\s@id(\s|$)/m;
const relationFieldsRegex = /@relation\([^)]*fields:\s*\[([^\]]+)\]/g;
const uniqueRegex = /@@unique\(\[([^\]]+)\]/g;

function indentOf(body) {
  const firstLine = body.split("\n").find((line) => line.trim().length > 0);
  return firstLine ? firstLine.match(/^\s*/)[0] : "  ";
}

function normalize(fieldList) {
  return fieldList
    .split(",")
    .map((field) => field.trim())
    .join(", ");
}

/** Las listas de campos que necesitan @@unique en este modelo y no lo tienen. */
function missingUniques(body) {
  const id = body.match(idFieldRegex)?.[1];
  if (!id) return [];
  const present = new Set([...body.matchAll(uniqueRegex)].map((m) => normalize(m[1])));
  const needed = new Set();
  for (const match of body.matchAll(relationFieldsRegex)) {
    const fields = normalize(match[1]);
    const parts = fields.split(", ");
    if (parts.length > 1 && parts[0] === id && !present.has(fields)) {
      needed.add(fields);
    }
  }
  return [...needed];
}

const source = readFileSync(schemaPath, "utf8");

const added = [];
const patched = source.replace(modelRegex, (block, name, body) => {
  const missing = missingUniques(body);
  if (missing.length === 0) {
    return block;
  }
  const indent = indentOf(body);
  const lines = missing.map((fields) => `${indent}@@unique([${fields}])`).join("\n");
  added.push(...missing.map((fields) => `${name}(${fields})`));
  return `model ${name} {\n${body}\n${lines}\n}`;
});

// Auto-verificación: todo modelo que necesitaba la anotación tiene que
// tenerla en el resultado. Si no, el parche no hizo lo que creía hacer.
const stillMissing = [];
for (const match of patched.matchAll(modelRegex)) {
  const [, name, body] = match;
  for (const fields of missingUniques(body)) {
    stillMissing.push(`${name}(${fields})`);
  }
}

if (stillMissing.length > 0) {
  console.error(
    `[db:pull] patch-prisma-schema: FALLÓ — sin @@unique después de parchar: ${stillMissing.join(", ")}. ` +
      "Revisá scripts/patch-prisma-schema.mjs: probablemente el formato de introspección cambió.",
  );
  process.exit(1);
}

if (added.length === 0) {
  console.log("[db:pull] patch-prisma-schema: nada que parchar");
} else {
  writeFileSync(schemaPath, patched);
  console.log(`[db:pull] patch-prisma-schema: @@unique agregado en ${added.join(", ")}`);
}
