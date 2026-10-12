// packages/contracts — Zod + tipos tRPC, única fuente de verdad de tipos
// entre apps/api, apps/admin y apps/storefront (AGENTS.md § Documentación).
// Los DTO público/administrativo de cada módulo se agregan junto con el WP
// de ese módulo en el bloque C (docs/backlog.md, nota sobre alcance de A11).
export * from "./shared/index.js";
export * from "./auth.js";
export * from "./catalog.js";
export * from "./catalog-defaults.js";
export * from "./decant.js";
export * from "./inventory.js";
export * from "./media.js";
export * from "./market.js";
export * from "./sourcing.js";
export * from "./sales.js";
export * from "./security/permissions.js";
