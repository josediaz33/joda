import { PERFUME_DEFAULTS, VARIANT_DEFAULTS, WATCH_DEFAULTS } from "@joda/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "../../db/testDb.js";

// WP-E05a. Los valores por defecto de negocio viven en dos sitios:
// `packages/contracts/src/catalog-defaults.ts` (lo que precarga el formulario
// del admin) y los DEFAULT de `packages/db/migrations/0003_catalog.sql` (lo que
// la base pone si la API no manda el campo). Si divergen, el formulario guarda
// un valor y la base habría guardado otro: una merma que cambia en silencio al
// crear un perfume. Mismo caso que WP-M11: es una convención mecánica entre dos
// archivos, no una regla de negocio, así que cita la fuente que la define
// (`.claude/rules/testing.md`, excepción de convención mecánica).
//
// Vive en apps/api y no en packages/db por la misma razón que
// permissionsParity.integration.test.ts: acá conviven `@joda/contracts` y
// `startTestDb`. Lo corre `pnpm test` y el CI.

type ColumnRef = { table: string; column: string };

// `satisfies` obliga a mapear cada clave de la constante a su columna: agregar
// un default sin su columna no compila.
const PERFUME_COLUMNS = {
  isDecantable: { table: "perfume_details", column: "is_decantable" },
  wasteFactor: { table: "perfume_details", column: "waste_factor" },
  unusableResidueMl: { table: "perfume_details", column: "unusable_residue_ml" },
  evaporationMlYear: { table: "perfume_details", column: "evaporation_ml_year" },
} satisfies Record<keyof typeof PERFUME_DEFAULTS, ColumnRef>;

const WATCH_COLUMNS = {
  requiresSerial: { table: "watch_details", column: "requires_serial" },
  warrantyMonths: { table: "watch_details", column: "warranty_months" },
} satisfies Record<keyof typeof WATCH_DEFAULTS, ColumnRef>;

const VARIANT_COLUMNS = {
  vatRate: { table: "product_variants", column: "vat_rate" },
  allocationPolicy: { table: "product_variants", column: "allocation_policy" },
  productionMode: { table: "product_variants", column: "production_mode" },
  isSerialized: { table: "product_variants", column: "is_serialized" },
  onlineVisible: { table: "product_variants", column: "online_visible" },
} satisfies Record<keyof typeof VARIANT_DEFAULTS, ColumnRef>;

interface ParityCase {
  name: string;
  // "tabla.columna" del DEFAULT que la constante debe reproducir.
  source: string;
  expected: unknown;
}

// Las claves salen de la constante: el tipo de `columns` exige una columna por
// cada una, así que `columns[key]` nunca es indefinido.
function parityCases<D extends Record<string, unknown>>(
  label: string,
  defaults: D,
  columns: Record<keyof D, ColumnRef>,
): ParityCase[] {
  return (Object.keys(defaults) as Array<keyof D & string>).map((key) => ({
    name: `${label}.${key}`,
    source: `${columns[key].table}.${columns[key].column}`,
    expected: defaults[key],
  }));
}

const CASES: ParityCase[] = [
  ...parityCases("PERFUME_DEFAULTS", PERFUME_DEFAULTS, PERFUME_COLUMNS),
  ...parityCases("WATCH_DEFAULTS", WATCH_DEFAULTS, WATCH_COLUMNS),
  ...parityCases("VARIANT_DEFAULTS", VARIANT_DEFAULTS, VARIANT_COLUMNS),
];

// information_schema guarda el DEFAULT como texto SQL: "0.02000", "2.000",
// "12", "true" o "'iva_10'::vat_rate" para un enum. Lo llevamos al tipo de la
// constante para comparar valores, no cadenas.
const ENUM_LITERAL = /^'(.*)'::[\w.]+$/;

function parseColumnDefault(raw: string | null): unknown {
  if (raw === null) return undefined;
  const enumValue = ENUM_LITERAL.exec(raw);
  if (enumValue) return enumValue[1];
  if (raw === "true" || raw === "false") return raw === "true";
  return Number(raw);
}

describe("paridad entre los defaults de contratos y los DEFAULT de 0003_catalog.sql (WP-E05a)", () => {
  let testDb: TestDb;
  // "tabla.columna" -> DEFAULT de la base, ya normalizado.
  let storedDefaults: Map<string, unknown>;

  beforeAll(async () => {
    testDb = await startTestDb();
    const { rows } = await testDb.superuserClient.query<{
      table_name: string;
      column_name: string;
      column_default: string | null;
    }>(
      `SELECT table_name, column_name, column_default
         FROM information_schema.columns
        WHERE table_schema = 'app'
          AND table_name IN ('perfume_details', 'watch_details', 'product_variants')`,
    );
    storedDefaults = new Map(
      rows.map((row) => [
        `${row.table_name}.${row.column_name}`,
        parseColumnDefault(row.column_default),
      ]),
    );
  }, 60_000);

  afterAll(async () => {
    await testDb.stop();
  });

  // Control positivo: sin esto, la paridad pasaría en vacío si la consulta no
  // devolviera columnas.
  it("la base de pruebas trae los DEFAULT de las columnas de detalle y de variantes", () => {
    expect(storedDefaults.has("product_variants.vat_rate")).toBe(true);
    expect(storedDefaults.has("perfume_details.waste_factor")).toBe(true);
  });

  it.each(CASES)("$name coincide con el DEFAULT de $source", ({ source, expected }) => {
    expect(storedDefaults.get(source)).toEqual(expected);
  });
});
