#!/usr/bin/env node
// Guardia del criterio de aceptación de WP-B04 ("el cliente tipado compila
// y expone los 61 modelos"). Corre al final de `db:pull`, después de
// `prisma generate`.
//
// No hardcodea "61": lee schema.prisma y cuenta sus propios bloques `model`
// y `view`, y compara contra lo que el cliente generado expone de verdad vía
// DMMF. Así el chequeo sigue siendo válido cuando el esquema crezca (una
// migración nueva, una vertical nueva) sin tener que tocar este archivo — y
// si algún día el generador silenciosamente deja un modelo afuera (el
// hallazgo que motivó este script: antes de WP-B04 esto se verificaba a
// mano, una sola vez, y nada lo protegía de una regresión futura), esto
// falla con un mensaje concreto en vez de que alguien lo note meses después
// en producción.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dbRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaPath = join(dbRoot, "prisma", "schema.prisma");
const schemaSource = readFileSync(schemaPath, "utf8");

const modelCount = (schemaSource.match(/^model \w+ \{/gm) ?? []).length;
const viewCount = (schemaSource.match(/^view \w+ \{/gm) ?? []).length;
const expected = modelCount + viewCount;

const { Prisma } = await import("@prisma/client");
const actual = Prisma.dmmf.datamodel.models.length;

if (actual !== expected) {
  console.error(
    `[db:pull] verify-prisma-client: FALLÓ — schema.prisma declara ${modelCount} modelo(s) + ${viewCount} vista(s) ` +
      `(${expected} en total), pero el cliente generado expone ${actual}. ` +
      "El cliente no refleja el esquema introspeccionado: no lo uses así.",
  );
  process.exit(1);
}

console.log(
  `[db:pull] verify-prisma-client: OK — ${modelCount} modelos + ${viewCount} vistas expuestos en el cliente`,
);
