import { describe, expect, it } from "vitest";
import { decidePermissionAccess } from "./authorization.js";

describe("docs/api-conventions.md §4.3 · decidePermissionAccess — sin sesión de personal", () => {
  it("sin sesión → 404, incluso con el permiso exacto en el set (nunca debería pasar, pero el 404 manda igual)", () => {
    const outcome = decidePermissionAccess({
      hasStaffSession: false,
      requiredPermission: "sales.order:read",
      grantedPermissions: new Set(["sales.order:read"]),
    });

    expect(outcome).toEqual({ kind: "denied", httpStatus: 404 });
  });

  it("sin sesión y sin ningún permiso → 404", () => {
    const outcome = decidePermissionAccess({
      hasStaffSession: false,
      requiredPermission: "sales.order:read",
      grantedPermissions: new Set(),
    });

    expect(outcome).toEqual({ kind: "denied", httpStatus: 404 });
  });
});

describe("docs/api-conventions.md §4.3 · decidePermissionAccess — con sesión, permiso exacto", () => {
  it("el usuario tiene el permiso exacto requerido → granted", () => {
    const outcome = decidePermissionAccess({
      hasStaffSession: true,
      requiredPermission: "sales.order:read",
      grantedPermissions: new Set(["sales.order:read"]),
    });

    expect(outcome).toEqual({ kind: "granted" });
  });

  it("el usuario tiene el permiso exacto entre otros de módulos distintos → granted", () => {
    const outcome = decidePermissionAccess({
      hasStaffSession: true,
      requiredPermission: "sales.order:read",
      grantedPermissions: new Set(["catalog.product:read", "sales.order:read"]),
    });

    expect(outcome).toEqual({ kind: "granted" });
  });
});

describe("docs/runbooks/prompts-playbook.md Sesión 25 · decidePermissionAccess — la excepción del 403", () => {
  it("con sesión, sin el permiso exacto pero con otro permiso del MISMO módulo → 403, no 404", () => {
    const outcome = decidePermissionAccess({
      hasStaffSession: true,
      requiredPermission: "sales.order:write",
      grantedPermissions: new Set(["sales.order:read"]),
    });

    expect(outcome).toEqual({ kind: "denied", httpStatus: 403 });
  });

  it("con sesión, sin ningún permiso de ese módulo (pero sí de otros) → 404, no 403", () => {
    const outcome = decidePermissionAccess({
      hasStaffSession: true,
      requiredPermission: "sales.order:read",
      grantedPermissions: new Set(["catalog.product:read", "inventory.stock:read"]),
    });

    expect(outcome).toEqual({ kind: "denied", httpStatus: 404 });
  });

  it("con sesión, sin ningún permiso en absoluto → 404", () => {
    const outcome = decidePermissionAccess({
      hasStaffSession: true,
      requiredPermission: "sales.order:read",
      grantedPermissions: new Set(),
    });

    expect(outcome).toEqual({ kind: "denied", httpStatus: 404 });
  });

  it("un módulo con más de un segmento (market.purchase_order) no confunde acciones de módulos con prefijo compartido", () => {
    const outcome = decidePermissionAccess({
      hasStaffSession: true,
      requiredPermission: "market.purchase_order:approve",
      grantedPermissions: new Set(["market.purchase_order:read"]),
    });

    expect(outcome).toEqual({ kind: "denied", httpStatus: 403 });
  });
});
