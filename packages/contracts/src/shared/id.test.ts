import { describe, expect, it } from "vitest";
import { idSchema } from "./id.js";

describe("idSchema — identificadores uuid (data-model.md · Identificadores)", () => {
  it("acepta un uuid válido", () => {
    expect(() => idSchema.parse("0f3b6b2a-2e0e-4c1d-9c1a-2c9a9a9a9a9a")).not.toThrow();
  });

  it("rechaza un string que no tiene forma de uuid", () => {
    expect(() => idSchema.parse("no-es-un-uuid")).toThrow();
  });
});
