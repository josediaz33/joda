// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("docs/api-conventions.md §1 · carga multipart de C09 (WP-E05)", () => {
  it("manda campos antes del archivo por /media/products con la cookie de sesión", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "44444444-4444-4444-a444-444444444444",
        productId: "22222222-2222-4222-a222-222222222222",
        variantId: null,
        altText: "Estuche de cuero negro",
        position: 0,
        width: 100,
        height: 80,
        bytes: 400,
        mimeType: "image/jpeg",
        derivatives: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["jpeg"], "foto.jpg", { type: "image/jpeg" });

    await api.uploadProductMedia({
      productId: "22222222-2222-4222-a222-222222222222",
      altText: "Estuche de cuero negro",
      file,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/media/products",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toBeUndefined();
    expect([...(init.body as FormData).keys()]).toEqual(["productId", "altText", "file"]);
  });
});
