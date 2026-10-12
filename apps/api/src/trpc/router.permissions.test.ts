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
  it("de verdad recorrió los procedimientos montados hoy, incluidos inventario y compras", () => {
    const procedures = flattenProcedures(createAppRouter(null));

    expect(Object.keys(procedures).sort()).toEqual([
      "auth.mfa.confirmEnroll",
      "auth.mfa.enroll",
      "auth.mfa.verify",
      "auth.session.current",
      "auth.session.login",
      "auth.session.logout",
      "auth.session.refresh",
      "catalog.bom.create",
      "catalog.bom.list",
      "catalog.bom.remove",
      "catalog.bom.update",
      "catalog.category.create",
      "catalog.category.list",
      "catalog.category.update",
      "catalog.product.activate",
      "catalog.product.archive",
      "catalog.product.byId",
      "catalog.product.create",
      "catalog.product.list",
      "catalog.product.publish",
      "catalog.product.unpublish",
      "catalog.product.update",
      "catalog.tag.create",
      "catalog.tag.list",
      "catalog.tag.update",
      "catalog.variant.byId",
      "catalog.variant.create",
      "catalog.variant.list",
      "catalog.variant.setVisibility",
      "catalog.variant.update",
      "example.ping.effectCount",
      "example.ping.failWithBug",
      "example.ping.failWithCheckViolation",
      "example.ping.irreversibleEffect",
      "example.ping.list",
      "example.ping.requiresPermission",
      "inventory.adjustment.create",
      "inventory.decant.execute",
      "inventory.decant.list",
      "inventory.decant.plan",
      "inventory.decant.start",
      "inventory.lot.history",
      "inventory.lot.open",
      "inventory.serial.create",
      "inventory.serial.history",
      "inventory.serial.list",
      "inventory.stock.available",
      "market.purchaseOrder.approve",
      "market.purchaseOrder.byId",
      "market.purchaseOrder.create",
      "market.purchaseOrder.list",
      "market.purchaseOrder.remove",
      "market.purchaseOrder.transition",
      "market.supplier.byId",
      "market.supplier.create",
      "market.supplier.list",
      "market.supplier.update",
    ]);
  });

  // WP-C11: el permiso de la apertura de frasco es el que va a usar WP-B11
  // para la política de escritura de `inventory_lots` (docs/backlog.md,
  // fila de WP-B11: "apertura de frasco → el mismo permiso que use el
  // endpoint de WP-C11"). Si alguien lo cambia acá sin cambiar B11, la
  // política de la base y el endpoint dejan de coincidir.
  it("inventory.lot.open exige inventory.decant:execute (RN-LOT-02, mapeo de WP-B11)", () => {
    const procedures = flattenProcedures(createAppRouter(null));

    expect(procedures["inventory.lot.open"]?._def.meta?.permission).toBe(
      "inventory.decant:execute",
    );
  });

  // WP-C13: planificar, iniciar y ejecutar una orden de fraccionamiento exigen
  // el permiso que la política de escritura de `inventory_movements` (WP-B11d,
  // docs/security-spec.md §3.1) pide para los movimientos `decant_consumption`,
  // `waste` y `bom_consumption`; la cola solo lee. Si alguien cambia un
  // permiso acá sin cambiar la política, la ejecución deja de coincidir con la
  // base y falla a mitad de la transacción.
  it("inventory.decant.* exige inventory.decant:execute para planificar, iniciar y ejecutar, e inventory.stock:read para la cola (RF-FRA-01…06)", () => {
    const procedures = flattenProcedures(createAppRouter(null));

    expect(procedures["inventory.decant.plan"]?._def.meta?.permission).toBe(
      "inventory.decant:execute",
    );
    expect(procedures["inventory.decant.start"]?._def.meta?.permission).toBe(
      "inventory.decant:execute",
    );
    expect(procedures["inventory.decant.execute"]?._def.meta?.permission).toBe(
      "inventory.decant:execute",
    );
    expect(procedures["inventory.decant.list"]?._def.meta?.permission).toBe("inventory.stock:read");
  });

  // WP-C12: el alta suelta de una unidad es un ajuste; leer y trazar exigen
  // poder ver stock. El flujo real (cargar los seriales al recibir la
  // compra) tendrá el permiso de recepción, en WP-C15.
  it("inventory.serial.* exige inventory.stock:adjust para el alta y inventory.stock:read para consultar (RF-INV-10)", () => {
    const procedures = flattenProcedures(createAppRouter(null));

    expect(procedures["inventory.serial.create"]?._def.meta?.permission).toBe(
      "inventory.stock:adjust",
    );
    expect(procedures["inventory.serial.list"]?._def.meta?.permission).toBe("inventory.stock:read");
    expect(procedures["inventory.serial.history"]?._def.meta?.permission).toBe(
      "inventory.stock:read",
    );
  });

  it("RF-MKT-03 · aprobar requiere el permiso de aprobación, separado del permiso de escritura", () => {
    const procedures = flattenProcedures(createAppRouter(null));
    expect(procedures["market.purchaseOrder.approve"]?._def.meta?.permission).toBe(
      "market.purchase_order:approve",
    );
    expect(procedures["market.purchaseOrder.transition"]?._def.meta?.permission).toBe(
      "market.purchase_order:write",
    );
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
