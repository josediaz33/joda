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

export default [
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/node_modules/**",
      // Fixture con violaciones a propósito (ver test/boundaries.test.ts):
      // se lintea por la API de Node con una ruta virtual, nunca como
      // archivo real de este paquete.
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
      "boundaries/dependencies": [
        "error",
        {
          default: "allow",
          checkAllOrigins: true,
          // pnpm crea packages/domain/node_modules/<paquete> por cada
          // dependencia declarada en su package.json — esa ruta resuelta cae
          // DENTRO de "packages/domain/**", así que el plugin clasifica esa
          // dependencia como "interna" (relationship.to: "internal"), no
          // como una dependencia externa cualquiera. Sin checkInternals:true
          // esas dependencias "internas" nunca se evalúan contra las
          // políticas de abajo — cualquier paquete que se instale acá (sea
          // Prisma, sea lo que sea) queda exento del chequeo en silencio.
          // Solo se atrapan los imports de paquetes NO instalados. Verificado
          // con ESLINT_PLUGIN_BOUNDARIES_DEBUG=1; test de regresión en
          // packages/config/test/boundaries.test.ts.
          checkInternals: true,
          policies: [
            {
              from: { element: { type: "domain" } },
              disallow: { to: { module: { origin: ["core", "external"] } } },
              message: DOMAIN_PURITY_MESSAGE,
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
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
      ],
      "no-restricted-syntax": [
        "error",
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
      ],
    },
  },

  // Los tests de packages/domain sí pueden traer su propio tooling (vitest,
  // fast-check, ...): la pureza aplica al código que se shippea, no a los
  // tests que lo verifican (mismo criterio que .claude/rules/testing.md,
  // que trata **/*.test.ts como un dominio de reglas aparte). Este bloque
  // va DESPUÉS del de arriba a propósito: en flat config, cuando dos
  // bloques matchean el mismo archivo, el de más abajo gana regla por
  // regla — acá solo se pisa "boundaries/dependencies" entero.
  {
    files: ["packages/domain/**/*.test.ts", "packages/domain/vitest.config.ts"],
    rules: {
      "boundaries/dependencies": "off",
      // "Date" (no fetch/crypto) se exceptúa acá, y solo acá: un fixture
      // como `new Date("2026-01-01")` es un literal fijo pasado por
      // parámetro al código bajo prueba, no una lectura del reloj real —
      // es justo la distinción que traza .claude/rules/testing.md
      // ("Nada de `new Date()` ... en el código bajo prueba", no en el
      // fixture que lo alimenta). LotSnapshot.receivedAt/expiryAt
      // (docs/domain-contracts.md §6.1) son `Date`, así que
      // inventory/*.test.ts (WP-A06) necesita poder construirlos.
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message:
            "packages/domain no hace I/O de red: el acceso HTTP entra por puerto (docs/engineering-principles.md Parte I·D).",
        },
        {
          name: "crypto",
          message:
            "packages/domain no puede generar aleatoriedad: entra por el puerto IdGenerator (docs/engineering-principles.md Parte I·D).",
        },
      ],
    },
  },
];
