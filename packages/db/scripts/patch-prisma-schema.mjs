#!/usr/bin/env node
// Parche determinístico sobre schema.prisma, aplicado entre `prisma db pull`
// y `prisma generate` (ver el script "db:pull" de package.json).
//
// Por qué existe: la FK compuesta (product_id, kind) -> products(id, kind)
// (docs/data-model.md §8, "Cómo agregar una vertical de producto") es lo que
// impide en Postgres que un producto `watch` tenga `perfume_details`. Como
// `product_id` ya es PRIMARY KEY de cada tabla de detalle, (product_id, kind)
// es unique por transitividad — pero Prisma introspecciona uniqueness de
// forma literal, no transitiva, y sin una anotación @@unique en el modelo
// el generador de cliente falla con P1012 ("A one-to-one relation must use
// unique fields on the defining side"). No es una regla de negocio: la FK
// compuesta ya hace cumplir el invariante real: https://github.com/prisma/prisma/issues/10390
//
// La alternativa sería un índice UNIQUE(product_id, kind) real en Postgres,
// pero sería puramente redundante (product_id solo ya es unique) y violaría
// el alcance de WP-B04 ("sin cambios al esquema"). En cambio, este script
// inserta la anotación en cada corrida de `db:pull`, así que sobrevive a que
// `schema.prisma` se reescriba entero en cada introspección sin que nadie
// tenga que acordarse de re-anotarlo a mano (ADR-018 prohíbe editar
// schema.prisma a mano; esto no es una edición manual, es parte del script).
//
// Detecta genéricamente cualquier modelo con una relación
// "fields: [product_id, kind], references: [id, kind]" — así que la próxima
// vertical que se agregue (docs/data-model.md §8) queda cubierta sin tocar
// este archivo. Después de parchar, vuelve a escanear el resultado: si algún
// modelo que necesitaba la anotación se quedó sin ella (regex que no matchea
// más por un cambio de formato del introspector, un @@schema distinto de
// "app", etc.), corta con exit 1 en vez de escribir un schema roto en
// silencio — `prisma generate` fallaría de todos modos con P1012, pero acá
// el error señala la causa real en vez de la validación genérica de Prisma.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dbRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaPath = join(dbRoot, "prisma", "schema.prisma");

const NEEDS_UNIQUE = /fields:\s*\[product_id,\s*kind\],\s*references:\s*\[id,\s*kind\]/;
const HAS_UNIQUE = /@@unique\(\[product_id,\s*kind\]\)/;
const modelRegex = /^model (\w+) \{\n([\s\S]*?)\n\}/gm;

function indentOf(body) {
  const firstLine = body.split("\n").find((line) => line.trim().length > 0);
  return firstLine ? firstLine.match(/^\s*/)[0] : "  ";
}

const source = readFileSync(schemaPath, "utf8");

let patchedCount = 0;
const patched = source.replace(modelRegex, (block, name, body) => {
  if (!NEEDS_UNIQUE.test(body) || HAS_UNIQUE.test(body)) {
    return block;
  }
  patchedCount += 1;
  const indent = indentOf(body);
  return `model ${name} {\n${body}\n${indent}@@unique([product_id, kind])\n}`;
});

// Auto-verificación: todo modelo que necesitaba la anotación tiene que
// tenerla en el resultado. Si no, el parche no hizo lo que creía hacer.
const stillMissing = [];
for (const match of patched.matchAll(modelRegex)) {
  const [, name, body] = match;
  if (NEEDS_UNIQUE.test(body) && !HAS_UNIQUE.test(body)) {
    stillMissing.push(name);
  }
}

if (stillMissing.length > 0) {
  console.error(
    `[db:pull] patch-prisma-schema: FALLÓ — ${stillMissing.join(", ")} necesita @@unique([product_id, kind]) y no se le pudo agregar. ` +
      "Revisá scripts/patch-prisma-schema.mjs: probablemente el formato de introspección cambió.",
  );
  process.exit(1);
}

if (patchedCount === 0) {
  console.log("[db:pull] patch-prisma-schema: nada que parchar");
} else {
  writeFileSync(schemaPath, patched);
  console.log(
    `[db:pull] patch-prisma-schema: @@unique([product_id, kind]) agregado en ${patchedCount} modelo(s)`,
  );
}
