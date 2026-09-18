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
// este archivo.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dbRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaPath = join(dbRoot, "prisma", "schema.prisma");

const source = readFileSync(schemaPath, "utf8");
const modelRegex = /^model (\w+) \{\n([\s\S]*?)\n\}/gm;

let patchedCount = 0;
const patched = source.replace(modelRegex, (block, name, body) => {
  const needsUnique = /fields:\s*\[product_id,\s*kind\],\s*references:\s*\[id,\s*kind\]/.test(body);
  if (!needsUnique || /@@unique\(\[product_id,\s*kind\]\)/.test(body)) {
    return block;
  }
  patchedCount += 1;
  const withUnique = body.replace(
    /\n(\s*)(@@schema\("app"\))/,
    `\n$1@@unique([product_id, kind])\n$1$2`,
  );
  return `model ${name} {\n${withUnique}\n}`;
});

if (patchedCount === 0) {
  console.log("[db:pull] patch-prisma-schema: nada que parchar");
} else {
  writeFileSync(schemaPath, patched);
  console.log(
    `[db:pull] patch-prisma-schema: @@unique([product_id, kind]) agregado en ${patchedCount} modelo(s)`,
  );
}
