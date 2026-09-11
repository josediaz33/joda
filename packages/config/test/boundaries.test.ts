// Prueba de regresión permanente para la restricción mecánica de
// packages/domain (ver packages/config/eslint/index.js).
//
// Corre el binario real de ESLint como subproceso, con el cwd parado en
// packages/domain — exactamente como lo invoca Turbo — en vez de usar la
// API de Node de ESLint. Se probó primero con la API de Node
// (`new ESLint(...)` + `lintFiles`/`lintText`) y **no reproducía el bug**:
// esa API le entrega a las reglas la ruta absoluta del archivo, así que el
// patrón "packages/domain/**" de boundaries/elements matcheaba por sufijo
// aunque "boundaries/root-path" estuviera roto o ausente. El binario de
// ESLint sí le entrega a las reglas una ruta relativa al cwd de invocación
// ("src/x.ts", sin el prefijo "packages/domain"), que es la única situación
// en la que hace falta "boundaries/root-path" para que el patrón resuelva —
// y es exactamente la situación real cuando Turbo ejecuta "lint" adentro de
// cada paquete. Si el test usara la API de Node, pasaría igual aunque
// alguien volviera a romper "boundaries/root-path" sin que nadie se entere.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const FIXTURE_PATH = path.join(TEST_DIR, "fixtures/boundary-violations.ts");
const ESLINT_BIN = path.join(TEST_DIR, "../node_modules/eslint/bin/eslint.js");

const DOMAIN_PACKAGE_DIR = path.join(REPO_ROOT, "packages/domain");
// Generado en cada test y borrado en el afterEach de abajo — nunca se
// commitea (ver .gitignore).
const GENERATED_FILE_RELATIVE = "src/__boundary-check.generated.ts";
const GENERATED_FILE_ABSOLUTE = path.join(DOMAIN_PACKAGE_DIR, GENERATED_FILE_RELATIVE);
// Mismo mecanismo, pero con nombre de test — para la excepción de
// packages/domain/**/*.test.ts (ver packages/config/eslint/index.js).
const GENERATED_TEST_FILE_RELATIVE = "src/__boundary-check.generated.test.ts";
const GENERATED_TEST_FILE_ABSOLUTE = path.join(DOMAIN_PACKAGE_DIR, GENERATED_TEST_FILE_RELATIVE);

afterEach(() => {
  rmSync(GENERATED_FILE_ABSOLUTE, { force: true });
  rmSync(GENERATED_TEST_FILE_ABSOLUTE, { force: true });
});

interface EslintJsonMessage {
  ruleId: string | null;
  message: string;
}

function lintGeneratedFile(relativePath: string, absolutePath: string, code: string): EslintJsonMessage[] {
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, code);

  try {
    // eslint sale con código 1 cuando encuentra errores — no es un fallo del
    // subproceso, es el resultado que estamos evaluando. execFileSync lanza
    // en ese caso; el stdout con el JSON sigue viniendo en el error.
    const stdout = execFileSync(process.execPath, [ESLINT_BIN, "--format", "json", relativePath], {
      cwd: DOMAIN_PACKAGE_DIR,
      encoding: "utf8",
    });
    return JSON.parse(stdout)[0].messages;
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (!stdout) throw error;
    return JSON.parse(stdout)[0].messages;
  }
}

function lintAsRealDomainFile(code: string): EslintJsonMessage[] {
  return lintGeneratedFile(GENERATED_FILE_RELATIVE, GENERATED_FILE_ABSOLUTE, code);
}

function lintAsDomainTestFile(code: string): EslintJsonMessage[] {
  return lintGeneratedFile(GENERATED_TEST_FILE_RELATIVE, GENERATED_TEST_FILE_ABSOLUTE, code);
}

// El arranque en frío del subproceso de ESLint (cargar parser y plugins)
// tarda bastante más que el timeout por defecto de vitest (5 s).
const ESLINT_COLD_START_TIMEOUT = 30_000;

describe("pureza de packages/domain (restricción mecánica, no convención)", () => {
  it(
    "rechaza los ocho imports/globals prohibidos con exactamente 8 errores",
    () => {
      const code = readFileSync(FIXTURE_PATH, "utf8");
      const messages = lintAsRealDomainFile(code);

      expect(messages).toHaveLength(8);

      const ruleIds = messages.map((message) => message.ruleId).sort();
      expect(ruleIds).toEqual(
        [
          "boundaries/dependencies", // @prisma/client
          "boundaries/dependencies", // react
          "boundaries/dependencies", // node:fs
          "no-restricted-globals", // Date
          "no-restricted-globals", // crypto
          "no-restricted-globals", // fetch
          "no-restricted-syntax", // process.env
          "no-restricted-syntax", // Math.random
        ].sort(),
      );
    },
    ESLINT_COLD_START_TIMEOUT,
  );

  it(
    "no marca nada en un archivo de packages/domain que no viola la regla",
    () => {
      const messages = lintAsRealDomainFile(
        "export const suma = (a: number, b: number) => a + b;\n",
      );

      expect(messages).toHaveLength(0);
    },
    ESLINT_COLD_START_TIMEOUT,
  );

  // pnpm crea packages/domain/node_modules/<paquete> por cada dependencia
  // declarada en su package.json. Esa ruta cae DENTRO de "packages/domain/**",
  // así que sin checkInternals:true el plugin trata esa dependencia como
  // "interna" y la excluye del chequeo — cualquier paquete instalado ahí
  // (Prisma incluido) pasaría el lint en silencio. Se usa "vitest" porque es
  // el único paquete externo real que packages/domain ya tiene instalado;
  // no importa cuál sea, lo que se prueba es el mecanismo de resolución, no
  // que vitest en particular esté prohibido.
  it(
    "rechaza un paquete externo aunque esté instalado como dependencia de packages/domain",
    () => {
      const messages = lintAsRealDomainFile('import { describe } from "vitest";\nvoid describe;\n');

      expect(messages).toHaveLength(1);
      expect(messages[0]?.ruleId).toBe("boundaries/dependencies");
    },
    ESLINT_COLD_START_TIMEOUT,
  );

  it(
    "permite ese mismo import en un archivo *.test.ts — los tests no son código que se shippea",
    () => {
      const messages = lintAsDomainTestFile('import { describe } from "vitest";\nvoid describe;\n');

      expect(messages).toHaveLength(0);
    },
    ESLINT_COLD_START_TIMEOUT,
  );
});
