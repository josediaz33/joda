import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// WP-B13 (docs/adr/016-rbac-tres-capas.md, "Modelo de confianza"): RLS y
// `app.has_permission()` confían en `app.user_id`, `app.tenant_id`,
// `app.audience` y `app.session_id`. Esos valores tienen que salir SIEMPRE
// de una sesión validada (`resolveRequestSession`, modules/auth/service.ts),
// nunca de la entrada del cliente. Hoy hay un solo lugar que los fija,
// `withTenantTx`, y cada caller construye su contexto desde una sesión
// resuelta. Esta prueba falla si aparece otro archivo de código de
// producción que fije cualquiera de esos valores: ese archivo tiene que
// auditarse (¿de dónde sale el valor?) y agregarse acá a propósito, no
// colarse en silencio.
//
// WP-M06: el directorio auditado se ancla a la raíz del monorepo, no a la
// carpeta de este archivo. Así audita `apps/api/src` corra donde corra: desde
// un build en `apps/api/dist`, la carpeta del archivo es el compilado, donde el
// filtro de `.ts` solo deja pasar `.d.ts` sin esos valores, y el guarda
// fallaría sin haber encontrado nada real.
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
const SESSION_SETTING = /app\.(user_id|tenant_id|audience|session_id)/;

function productionSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productionSourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("solo withTenantTx fija el contexto de sesión de Postgres (docs/adr/016-rbac-tres-capas.md, WP-B13)", () => {
  it("ningún otro archivo de apps/api/src menciona app.user_id, app.tenant_id, app.audience ni app.session_id", () => {
    const files = productionSourceFiles(SRC_ROOT)
      .filter((path) => SESSION_SETTING.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC_ROOT, path).replaceAll("\\", "/"));

    expect(files).toEqual(["db/withTenantTx.ts"]);
  });
});
