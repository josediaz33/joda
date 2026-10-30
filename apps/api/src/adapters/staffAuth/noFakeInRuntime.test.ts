import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// WP-M18, docs/security-spec.md §4: el login de personal verifica la contraseña
// contra el proveedor real (Supabase Auth, ADR-004; en el entorno local, un
// GoTrue de versión fija detrás del mismo adaptador). El proveedor falso
// (fakeStaffAuthProvider.ts) es solo de pruebas: si algún archivo de producción
// lo importara, una configuración podría dejar entrar con credenciales de
// memoria. Esta prueba falla si pasa; ningún `AUTH_PROVIDER=fake` es posible
// porque el arranque (index.ts) construye `createSupabasePasswordProvider` y nada más.
function findRepoRoot(from: string): string {
  let dir = from;
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error(`No se encontró pnpm-workspace.yaml subiendo desde ${from}`);
    dir = parent;
  }
  return dir;
}

const SRC_ROOT = join(findRepoRoot(dirname(fileURLToPath(import.meta.url))), "apps/api/src");

function productionSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productionSourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("el proveedor de auth falso no es alcanzable en producción (docs/security-spec.md §4, WP-M18)", () => {
  it("ningún archivo de producción de apps/api/src importa fakeStaffAuthProvider", () => {
    const importers = productionSourceFiles(SRC_ROOT)
      .filter((path) => /fakeStaffAuthProvider/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC_ROOT, path).replaceAll("\\", "/"));

    expect(importers).toEqual([]);
  });

  it("el arranque construye el proveedor real de Supabase Auth", () => {
    const index = readFileSync(join(SRC_ROOT, "index.ts"), "utf8");

    expect(index).toMatch(/createSupabasePasswordProvider\(/);
  });
});
