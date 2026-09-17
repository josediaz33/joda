// Dataset dorado — estructura (docs/domain-contracts.md §8.1,
// docs/testing-strategy.md §5). No verifica una regla de negocio: verifica
// que el dataset en sí cumpla su propia convención, la misma excepción que
// .claude/rules/testing.md ya reconoce para los objetos de valor de
// shared/ y para packages/contracts — acá el "documento que la define" es
// domain-contracts.md §8.1.
//
// `node:fs`/`node:path` están permitidos acá porque este archivo es un
// `.test.ts`: packages/config/eslint/index.js apaga `boundaries/dependencies`
// solo para tests (la pureza aplica al código que se shippea, no al que lo
// verifica).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GoldenCaseFile } from "./case.js";

const GOLDEN_DIR = dirname(fileURLToPath(import.meta.url));

// El propio patrón lo impone la convención de nombres de
// docs/testing-strategy.md §5 ("01-compra-usd-con-flete.json", ...): dos
// dígitos de orden + slug, para que el árbol de archivos ya cuente algo.
const CASE_FILENAME_PATTERN = /^(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;

// Umbral deliberadamente bajo: no puede verificar que la nota sea CIERTA
// (eso solo lo sabe José, ver la nota sobre A10 en docs/backlog.md), solo
// que no esté vacía o sea un placeholder de una palabra.
const MIN_NOTA_LENGTH = 20;

function listCaseFiles(): string[] {
  return readdirSync(GOLDEN_DIR)
    .filter((file: string) => file.endsWith(".json"))
    .sort();
}

function readCase(file: string): GoldenCaseFile {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, file), "utf-8")) as GoldenCaseFile;
}

describe("Dataset dorado · convención de archivo (docs/domain-contracts.md §8.1)", () => {
  const files = listCaseFiles();

  it("packages/domain/test/golden/ existe y el runner la encuentra", () => {
    expect(GOLDEN_DIR.endsWith(join("test", "golden"))).toBe(true);
  });

  it.each(files)("%s sigue el patrón NN-slug.json", (file: string) => {
    expect(CASE_FILENAME_PATTERN.test(file)).toBe(true);
  });

  it.each(files)("%s tiene un .test.ts hermano que lo ejecuta", (file: string) => {
    const siblingTestFile = file.replace(/\.json$/, ".test.ts");
    expect(readdirSync(GOLDEN_DIR).includes(siblingTestFile)).toBe(true);
  });

  it.each(files)("%s: el .test.ts hermano importa este caso", (file: string) => {
    const siblingTestFile = file.replace(/\.json$/, ".test.ts");
    const siblingPath = join(GOLDEN_DIR, siblingTestFile);
    const source = readFileSync(siblingPath, "utf-8");
    expect(source.includes(`./${file}`)).toBe(true);
  });

  it.each(files)("%s: id coincide con el nombre de archivo", (file: string) => {
    const data = readCase(file);
    expect(data.id).toBe(file.replace(/\.json$/, ""));
  });

  it.each(files)("%s cita la regla que verifica", (file: string) => {
    const data = readCase(file);
    expect(typeof data.regla).toBe("string");
    expect(data.regla.length).toBeGreaterThan(0);
  });

  it.each(files)(
    "%s cita su origen en 'nota' (docs/backlog.md, nota sobre A10)",
    (file: string) => {
      const data = readCase(file);
      expect(typeof data.nota).toBe("string");
      expect(data.nota.length).toBeGreaterThanOrEqual(MIN_NOTA_LENGTH);
    },
  );

  it.each(files)("%s trae input y expected", (file: string) => {
    const data = readCase(file);
    expect(data.input).toBeDefined();
    expect(data.expected).toBeDefined();
  });
});
