import { describe, expect, it } from "vitest";
import { createAppRouter } from "./router.js";
import type { ProcedureMeta } from "./trpc.js";

// `router._def.procedures` es un mapa PLANO (ruta con puntos → procedimiento)
// que arma `createRouterFactory` de @trpc/server al construir cada router
// anidado — no está en el tipo público de RouterDef (genérico sobre
// TRecord), así que esto lee un detalle interno de la librería, con el cast
// mínimo para acceder a `_def.meta` de cada procedimiento (`any` prohibido
// por AGENTS.md salvo frontera con biblioteca sin tipos, con comentario que
// lo justifique — este es exactamente ese caso).
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
  it("de verdad recorrió los diez procedimientos montados hoy (example.ping.* + auth.session.* + auth.mfa.*)", () => {
    const procedures = flattenProcedures(createAppRouter(null));

    expect(Object.keys(procedures).sort()).toEqual([
      "auth.mfa.confirmEnroll",
      "auth.mfa.enroll",
      "auth.mfa.verify",
      "auth.session.login",
      "auth.session.logout",
      "auth.session.refresh",
      "example.ping.failWithBug",
      "example.ping.failWithCheckViolation",
      "example.ping.list",
      "example.ping.requiresPermission",
    ]);
  });
});
