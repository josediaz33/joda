// Configuración ESLint compartida (flat config, ESLint 9+).
// La consume el eslint.config.js de la raíz del monorepo — no se importa
// por nombre de paquete, sino por ruta relativa, como el resto de la
// configuración de packages/config.
//
// packages/domain no importa nada con I/O (CLAUDE.md § Código, y en más
// detalle .claude/rules/domain.md y docs/engineering-principles.md Parte I·D).
// Acá esa regla deja de ser una convención: eslint-plugin-boundaries hace
// fallar el lint si domain importa Prisma, React, Fastify, cualquier otro
// framework o un módulo nativo de Node (fs, path, crypto, ...). Lo que no
// es un import — fetch, Date, crypto y process.env como globals, y
// Math.random — lo cierran no-restricted-globals y no-restricted-syntax
// en el mismo bloque.
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import boundaries from "eslint-plugin-boundaries";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

// Turbo ejecuta "lint" con cwd en cada paquete (packages/domain, apps/api,
// ...), no en la raíz. El patrón "packages/domain/**" de boundaries/elements
// necesita un punto de referencia fijo para no depender de esa cwd — ver
// docs/guides/monorepo-setup de eslint-plugin-boundaries.
const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CONFIG_DIR, "../../..");

const DOMAIN_PURITY_MESSAGE =
  "packages/domain no puede depender de I/O ni de frameworks: es lógica pura " +
  "(CLAUDE.md § Código, .claude/rules/domain.md). Módulo prohibido: {{dependency.source}}";

// Registro de excepciones de pureza. Toda ampliación debe agregar acá fecha,
// motivo, WP y alcance exacto, junto con una regresión en test/boundaries.test.ts.
// - 2026-09-10 · WP-A03 · 30b7897: checkInternals:true cerró el bypass de
//   dependencias instaladas por pnpm; para habilitar vitest/fast-check se
//   apagó boundaries/dependencies en *.test.ts y vitest.config.ts.
// - 2026-09-13 · WP-A06 · 7141aa2: se permitió Date en esos mismos archivos
//   para fixtures de LotSnapshot.receivedAt/expiryAt (domain-contracts.md §6.1).
// - 2026-09-17 · WP-A10 · f3861d2: registry.test.ts empezó a leer y enumerar
//   los JSON del dataset dorado con node:fs, node:path y node:url, amparado
//   por la excepción general. WP-A12 registra retrospectivamente ese uso.
// - 2026-09-17 · WP-A12: se reemplaza el apagado por listas exactas:
//   tests → vitest/fast-check; vitest.config.ts → vitest/config;
//   test/golden/registry.test.ts → vitest/fast-check + node:fs/path/url.
//   Date solo en tests, con lecturas directas del reloj real prohibidas.
//
// Decisión WP-A12: vías 2 + 3 del backlog (mínimos permisos + registro).
// No se adopta la vía 1: mover todos los tests a test/ contradice la ubicación
// junto al código de testing-strategy.md §8 y amplía este WP sin reducir los
// permisos por sí solo. El sufijo sigue clasificando tests, pero ya no apaga
// una regla completa. Los helpers .ts conservan las restricciones de producción.
const DOMAIN_TEST_IMPORTS = ["vitest", "fast-check"];

function domainDependencies(allowedImports = []) {
  return [
    "error",
    {
      default: "allow",
      checkAllOrigins: true,
      // pnpm resuelve dependencias dentro de packages/domain/node_modules:
      // boundaries las clasifica como internas. Sin esto quedan exentas,
      // incluso si se instala Prisma. Ver la regresión con vitest instalado.
      checkInternals: true,
      policies: [
        {
          from: { element: { type: "domain" } },
          disallow: { to: { module: { origin: ["core", "external"] } } },
          message: DOMAIN_PURITY_MESSAGE,
        },
        // La última política coincidente gana. dependency.source conserva
        // la subruta literal; module.source agruparía vitest/config como
        // vitest, ensanchando el permiso. Sin comodines ni todo Node.
        ...allowedImports.map((source) => ({
          from: { element: { type: "domain" } },
          allow: { dependency: { source } },
        })),
      ],
    },
  ];
}

const DOMAIN_RESTRICTED_GLOBALS = [
  {
    name: "fetch",
    message:
      "packages/domain no hace I/O de red: el acceso HTTP entra por puerto (docs/engineering-principles.md Parte I·D).",
  },
  {
    name: "Date",
    message:
      "packages/domain no puede leer el reloj real: el tiempo entra por el puerto Clock (docs/engineering-principles.md Parte I·D).",
  },
  {
    name: "crypto",
    message:
      "packages/domain no puede generar aleatoriedad: entra por el puerto IdGenerator (docs/engineering-principles.md Parte I·D).",
  },
];

const DOMAIN_RESTRICTED_SYNTAX = [
  {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message:
      "packages/domain no lee variables de entorno: la configuración entra por parámetro (.claude/rules/domain.md).",
  },
  {
    selector: "MemberExpression[object.name='Math'][property.name='random']",
    message:
      "packages/domain no puede usar Math.random: la aleatoriedad entra por el puerto IdGenerator (.claude/rules/domain.md).",
  },
];

export default [
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/node_modules/**",
      // Fixture con violaciones a propósito (ver test/boundaries.test.ts):
      // se copia a domain y se lintea por el CLI, nunca como archivo real
      // de este paquete.
      "packages/config/test/fixtures/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,

  // --- Pureza de packages/domain: restricción mecánica, no convención ---
  {
    files: ["packages/domain/**/*.ts"],
    plugins: { boundaries },
    settings: {
      "boundaries/root-path": REPO_ROOT,
      "boundaries/elements": [{ type: "domain", pattern: "packages/domain/**" }],
    },
    rules: {
      "boundaries/dependencies": domainDependencies(),
      "no-restricted-globals": ["error", ...DOMAIN_RESTRICTED_GLOBALS],
      "no-restricted-syntax": ["error", ...DOMAIN_RESTRICTED_SYNTAX],
    },
  },

  // Flat config reemplaza reglas enteras: derivar las restricciones de las
  // mismas listas evita que una prohibición futura desaparezca de los tests.
  {
    files: ["packages/domain/**/*.test.ts"],
    rules: {
      "boundaries/dependencies": domainDependencies(DOMAIN_TEST_IMPORTS),
      "no-restricted-globals": [
        "error",
        ...DOMAIN_RESTRICTED_GLOBALS.filter(({ name }) => name !== "Date"),
      ],
      "no-restricted-syntax": [
        "error",
        ...DOMAIN_RESTRICTED_SYNTAX,
        {
          selector:
            "NewExpression[callee.name='Date'][arguments.length=0], " +
            "CallExpression[callee.name='Date'], " +
            "MemberExpression[object.name='Date'][property.name='now'], " +
            "MemberExpression[object.name='Date'][computed=true][property.value='now']",
          message:
            "Los tests usan fechas fijas, no el reloj real (docs/testing-strategy.md §8, WP-A12).",
        },
      ],
    },
  },

  {
    files: ["packages/domain/vitest.config.ts"],
    rules: {
      "boundaries/dependencies": domainDependencies(["vitest/config"]),
    },
  },

  {
    files: ["packages/domain/test/golden/registry.test.ts"],
    rules: {
      "boundaries/dependencies": domainDependencies([
        ...DOMAIN_TEST_IMPORTS,
        "node:fs",
        "node:path",
        "node:url",
      ]),
    },
  },
];
