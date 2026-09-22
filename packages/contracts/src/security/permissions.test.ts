import { describe, expect, it } from "vitest";
import { permissionCode } from "./permissions.js";

// No hay un RN-XXX que citar: esto no es una regla de negocio de perfumería,
// es el catálogo definicional de docs/security-spec.md §2 — misma excepción
// que .claude/rules/testing.md reconoce para las convenciones de frontera de
// packages/contracts (docs/testing-strategy.md §2.2).
describe("docs/security-spec.md §2 · permissionCode — catálogo exacto", () => {
  it("coincide, código por código y en el mismo orden, con el catálogo de la tabla del documento", () => {
    expect(permissionCode.options).toEqual([
      "catalog.product:read",
      "catalog.product:write",
      "catalog.product:publish",
      "inventory.stock:read",
      "inventory.stock:adjust",
      "inventory.decant:execute",
      "sales.order:read",
      "sales.order:write",
      "sales.order:refund",
      "accounting.cashbox:read",
      "accounting.cashbox:write",
      "accounting.deposit:read",
      "accounting.deposit:write",
      "accounting.journal:read",
      "accounting.journal:write",
      "market.supplier:read",
      "market.supplier:write",
      "market.purchase_order:read",
      "market.purchase_order:write",
      "market.purchase_order:approve",
      "market.purchase_order:receive",
      "market.sourcing:read",
      "market.sourcing:write",
      "market.channel:write",
      "fiscal.document:read",
      "fiscal.document:issue",
      "settings.user:read",
      "settings.user:write",
    ]);
  });

  it("rechaza un código que no está en el catálogo", () => {
    expect(permissionCode.safeParse("catalog.product:delete").success).toBe(false);
  });
});
