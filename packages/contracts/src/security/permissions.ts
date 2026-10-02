// Catálogo de permisos (docs/security-spec.md §2, forma
// `recurso.subrecurso:acción`) — los mismos 28 códigos que siembra
// packages/db/seed/0001_seed_base.sql en la tabla `permissions`. Vive en
// packages/contracts, no en packages/domain, porque es la única fuente de
// verdad de tipos entre apps/api, apps/admin y apps/storefront
// (AGENTS.md § Documentación): apps/admin va a necesitar este mismo literal
// para ocultar en la UI acciones sin permiso (guarda de UX, no de
// seguridad — docs/security-spec.md §3.4), no solo apps/api para declarar
// `meta.permission` (WP-C05, docs/api-conventions.md §9).
//
// No inventar un código nuevo acá sin actualizar primero
// docs/security-spec.md §2 y packages/db/seed/0001_seed_base.sql — los tres
// tienen que decir exactamente lo mismo. Contrato y seed los compara
// apps/api/src/modules/auth/permissionsParity.integration.test.ts (WP-M11);
// el documento, nadie. Hay una cuarta copia, el literal de permissions.test.ts
// (que se actualiza a mano), y los otorgamientos por rol (`seed_roles()` y
// security-spec §2.1), que ese test no mira.
import { z } from "zod";

export const permissionCode = z.enum([
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
export type PermissionCode = z.infer<typeof permissionCode>;
