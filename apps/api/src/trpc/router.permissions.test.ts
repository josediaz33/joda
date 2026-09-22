import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildCreateContext } from "./context.js";
import { createAppRouter } from "./router.js";
import { router, staffProcedure, type ProcedureMeta } from "./trpc.js";

// `router._def.procedures` es un mapa PLANO (ruta con puntos → procedimiento)
// que arma `createRouterFactory` de @trpc/server al construir cada router
// anidado — no está en el tipo público de RouterDef (genérico sobre
// TRecord, la misma forma que `_def.record`, el árbol SIN aplanar), así que
// esto lee un detalle interno de la librería, con el cast mínimo para
// acceder a `_def.meta` de cada procedimiento (`any` prohibido por AGENTS.md
// salvo frontera con biblioteca sin tipos, con comentario que lo
// justifique — este es exactamente ese caso).
//
// Confirmado leyendo el runtime instalado, no solo los tipos — @trpc/server
// 11.19.0 (pin exacto en apps/api/package.json), función interna `step()`
// de node_modules/.pnpm/@trpc+server@11.19.0_typescript@5.9.3/node_modules/
// @trpc/server/dist/tracked-*.mjs: por cada procedimiento hace
// `procedures[[...path, key].join(".")] = item` antes de devolver el árbol
// anidado por separado como `record`. Si una actualización de @trpc/server
// cambia esta forma, el control positivo de abajo lo va a gritar (mapa
// vacío o con otras claves), no un "pasa en silencio".
interface FlatProcedure {
  readonly _def: { readonly meta?: ProcedureMeta };
}

function flattenProcedures(
  appRouter: ReturnType<typeof createAppRouter>,
): Record<string, FlatProcedure> {
  return (appRouter._def as unknown as { procedures: Record<string, FlatProcedure> }).procedures;
}

// No hay un RN-XXX que citar: es la convención estructural de
// docs/api-conventions.md §9 ("un procedimiento sin meta.permission falla en
// el arranque, no en producción: un test recorre el router y verifica que
// todos lo declaran"), no una regla de negocio de perfumería — misma
// excepción que router.test.ts (WP-C01) ya usa para el esqueleto de
// transporte (docs/testing-strategy.md §2.2). Criterio de aceptación de
// WP-C05 (docs/backlog.md).
describe("docs/api-conventions.md §9 · todo procedimiento declara permission o permissionExempt", () => {
  it("ningún procedimiento del router montado queda sin declarar ninguno de los dos", () => {
    const procedures = flattenProcedures(createAppRouter(null));

    const undeclared = Object.entries(procedures)
      .filter(([, proc]) => !proc._def.meta?.permission && !proc._def.meta?.permissionExempt)
      .map(([path]) => path);

    expect(undeclared).toEqual([]);
  });

  // Control positivo: si `_def.procedures` alguna vez dejara de exponerse así
  // (por ejemplo, en una actualización de @trpc/server), el test de arriba
  // pasaría trivialmente sobre un mapa vacío sin recorrer nada — el mismo
  // riesgo que docs/backlog.md señaló para `pg_temp.expect_fail()` en
  // packages/db/tests/invariants.sql ("ningún error no prueba que un
  // invariante se cumple").
  it("de verdad recorrió los doce procedimientos montados hoy (example.ping.* + auth.session.* + auth.mfa.*)", () => {
    const procedures = flattenProcedures(createAppRouter(null));

    expect(Object.keys(procedures).sort()).toEqual([
      "auth.mfa.confirmEnroll",
      "auth.mfa.enroll",
      "auth.mfa.verify",
      "auth.session.login",
      "auth.session.logout",
      "auth.session.refresh",
      "example.ping.effectCount",
      "example.ping.failWithBug",
      "example.ping.failWithCheckViolation",
      "example.ping.irreversibleEffect",
      "example.ping.list",
      "example.ping.requiresPermission",
    ]);
  });
});

// El test de arriba prueba que el crawl ESTÁTICO detecta la falta — esto
// prueba que, si igual llegara a producción sin pasar por ese test (por
// ejemplo, alguien lo corre con `--changed` y este archivo no cambió), el
// guard de tiempo de ejecución (`MISSING_PERMISSION_DECLARATION_ERROR`,
// trpc.ts) también corta. No es una mutación del código fuente (esto no
// tiene permiso de escritura sobre trpc.ts): es un router nuevo, ad hoc,
// armado con los mismos `router`/`staffProcedure` reales, con UN
// procedimiento deliberadamente sin `meta`.
describe("apps/api/src/trpc/trpc.ts · enforcePermissionGate — el guard de tiempo de ejecución, no solo el crawl estático", () => {
  it("invocar un procedimiento sin meta.permission ni meta.permissionExempt responde 500 INTERNAL, no pasa en silencio", async () => {
    const brokenRouter = router({
      broken: staffProcedure
        .output(z.object({ ok: z.literal(true) }).strict())
        .query(() => ({ ok: true as const })),
    });

    const app = Fastify();
    app.register(fastifyTRPCPlugin, {
      prefix: "/trpc",
      trpcOptions: { router: brokenRouter, createContext: buildCreateContext(null) },
    });

    const response = await app.inject({ method: "GET", url: "/trpc/broken?input=%7B%7D" });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.data.appCode).toBe("INTERNAL");

    await app.close();
  });
});
