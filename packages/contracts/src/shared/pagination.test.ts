import { z } from "zod";
import { describe, expect, it } from "vitest";
import { MAX_PAGE_SIZE, paginatedOutputSchema, paginationInputSchema } from "./pagination.js";

describe("paginationInputSchema — cursor, no offset (api-conventions.md §6)", () => {
  it("acepta la entrada vacía: cursor y limit son opcionales", () => {
    expect(() => paginationInputSchema.parse({})).not.toThrow();
  });

  it("rechaza un limit por encima del máximo", () => {
    expect(() => paginationInputSchema.parse({ limit: MAX_PAGE_SIZE + 1 })).toThrow();
  });

  it("rechaza campos no declarados (.strict())", () => {
    expect(() => paginationInputSchema.parse({ cursor: "abc", total: 10 })).toThrow();
  });
});

describe("paginatedOutputSchema — nunca expone total (api-conventions.md §6)", () => {
  it("la salida solo trae items y nextCursor", () => {
    const schema = paginatedOutputSchema(z.object({ id: z.string() }).strict());
    const parsed = schema.parse({ items: [{ id: "x" }], nextCursor: null });
    expect(Object.keys(parsed)).toEqual(["items", "nextCursor"]);
  });

  it("rechaza un campo total colado en la salida (.strict())", () => {
    const schema = paginatedOutputSchema(z.object({ id: z.string() }).strict());
    expect(() => schema.parse({ items: [], nextCursor: null, total: 0 })).toThrow();
  });
});
