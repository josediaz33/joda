import { describe, expect, it } from "vitest";
import { assertLocalDiskStorageAllowedInProduction } from "./localDiskStorage.js";

// Mismo criterio que assertRlsNotBypassed (apps/api/src/db/client.ts,
// WP-C02, docs/security-spec.md §3.1): un adaptador que no debería llegar a
// producción no arranca el proceso en silencio.
describe("assertLocalDiskStorageAllowedInProduction · WP-C09", () => {
  it("lanza si NODE_ENV es production", () => {
    expect(() => assertLocalDiskStorageAllowedInProduction("production")).toThrow(
      /no puede usarse con NODE_ENV=production/,
    );
  });

  it("no lanza en development", () => {
    expect(() => assertLocalDiskStorageAllowedInProduction("development")).not.toThrow();
  });

  it("no lanza en test", () => {
    expect(() => assertLocalDiskStorageAllowedInProduction("test")).not.toThrow();
  });

  it("no lanza si NODE_ENV no está definido", () => {
    expect(() => assertLocalDiskStorageAllowedInProduction(undefined)).not.toThrow();
  });
});
