// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AdminProduct, AdminVariant } from "@joda/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import CatalogPreview from "./CatalogPreview";

vi.mock("../api", () => ({
  api: {
    current: vi.fn(),
    listProducts: vi.fn(),
    publishProduct: vi.fn(),
    unpublishProduct: vi.fn(),
    setVariantVisibility: vi.fn(),
  },
}));

Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
Element.prototype.scrollIntoView = () => {};

// RF-CAT-09 (docs/especificacion-software.md §2.1) · WP-C08g: publicar y
// despublicar al storefront con independencia del estado interno, y solo con
// `catalog.product:publish`.

const productId = "22222222-2222-4222-a222-222222222221";
const otherProductId = "22222222-2222-4222-a222-222222222222";
const variantId = "44444444-4444-4444-a444-444444444441";

function variant(overrides: Partial<AdminVariant>): AdminVariant {
  return {
    id: variantId,
    sku: "LAYTON-125",
    pricePyg: "2850000",
    onlineVisible: false,
    ...overrides,
  } as AdminVariant;
}

function product(overrides: Partial<AdminProduct>): AdminProduct {
  return {
    id: productId,
    name: "Layton",
    brandName: "Parfums de Marly",
    kind: "perfume",
    status: "active",
    publishedAt: null,
    variants: [],
    ...overrides,
  } as unknown as AdminProduct;
}

const PUBLISHER = [
  "catalog.product:read",
  "catalog.product:write",
  "catalog.product:publish",
] as const;
const WRITER = ["catalog.product:read", "catalog.product:write"] as const;

function renderCatalog(permissions: readonly string[], items: AdminProduct[]) {
  vi.mocked(api.current).mockResolvedValue({
    profile: { fullName: "Admin", mfaStatus: "satisfied" },
    permissions: [...permissions],
  } as Awaited<ReturnType<typeof api.current>>);
  vi.mocked(api.listProducts).mockResolvedValue({ items, nextCursor: null });
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CatalogPreview />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.publishProduct).mockResolvedValue({} as AdminProduct);
  vi.mocked(api.unpublishProduct).mockResolvedValue({} as AdminProduct);
  vi.mocked(api.setVariantVisibility).mockResolvedValue({} as AdminVariant);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RF-CAT-09 · el estado interno y la publicación se ven por separado", () => {
  it("un producto activo y sin publicar dice las dos cosas", async () => {
    renderCatalog(PUBLISHER, [product({ status: "active", publishedAt: null })]);

    const line = (await screen.findByText("Estado interno:")).parentElement;

    expect(line?.textContent).toBe("Estado interno: Activo · En la tienda: No publicado");
  });

  it("un borrador publicado avisa que todavía no se ve en la tienda", async () => {
    renderCatalog(PUBLISHER, [
      product({ status: "draft", publishedAt: "2026-01-01T12:00:00.000Z" }),
    ]);

    const line = (await screen.findByText("Estado interno:")).parentElement;

    expect(line?.textContent).toBe("Estado interno: Borrador · En la tienda: Publicado");
    expect(
      screen.getByText("Publicado, pero no se ve en la tienda hasta que esté activo."),
    ).toBeTruthy();
  });

  it("un producto activo y publicado no muestra el aviso", async () => {
    renderCatalog(PUBLISHER, [
      product({ status: "active", publishedAt: "2026-01-01T12:00:00.000Z" }),
    ]);

    await screen.findByText("Estado interno:");

    expect(screen.queryByText(/hasta que esté activo/)).toBeNull();
  });
});

describe("RF-CAT-09 · los controles de publicación son solo para catalog.product:publish", () => {
  it("quien puede escribir pero no publicar edita el producto y no ve ningún control de publicación", async () => {
    renderCatalog(WRITER, [product({ variants: [variant({})] })]);

    await screen.findByRole("button", { name: "Editar" });

    expect(screen.queryByRole("button", { name: /^Publicar/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Despublicar/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /en la tienda$/ })).toBeNull();
  });

  it("quien puede publicar ve Publicar en un producto sin publicar y Despublicar en uno publicado", async () => {
    renderCatalog(PUBLISHER, [
      product({ id: productId, name: "Layton", publishedAt: null }),
      product({
        id: otherProductId,
        name: "Herod",
        publishedAt: "2026-01-01T12:00:00.000Z",
      }),
    ]);

    expect(await screen.findByRole("button", { name: "Publicar Layton" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Despublicar Herod" })).toBeTruthy();
  });
});

describe("RF-CAT-09 · publicar, despublicar y mostrar variantes", () => {
  it("Publicar llama a la API con el id del producto y anuncia el resultado", async () => {
    const user = userEvent.setup();
    renderCatalog(PUBLISHER, [product({ publishedAt: null })]);

    await user.click(await screen.findByRole("button", { name: "Publicar Layton" }));

    await waitFor(() => expect(api.publishProduct).toHaveBeenCalledWith({ id: productId }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Layton se publicó."));
  });

  it("Despublicar llama a la API de despublicar", async () => {
    const user = userEvent.setup();
    renderCatalog(PUBLISHER, [product({ publishedAt: "2026-01-01T12:00:00.000Z" })]);

    await user.click(await screen.findByRole("button", { name: "Despublicar Layton" }));

    await waitFor(() => expect(api.unpublishProduct).toHaveBeenCalledWith({ id: productId }));
    expect(api.publishProduct).not.toHaveBeenCalled();
  });

  it("una variante oculta se muestra con Mostrar en la tienda, y una visible se oculta", async () => {
    const user = userEvent.setup();
    renderCatalog(PUBLISHER, [
      product({
        variants: [
          variant({ id: variantId, sku: "LAYTON-125", onlineVisible: false }),
          variant({
            id: "44444444-4444-4444-a444-444444444442",
            sku: "LAYTON-10ML",
            onlineVisible: true,
          }),
        ],
      }),
    ]);

    await user.click(
      await screen.findByRole("button", { name: "Mostrar LAYTON-125 en la tienda" }),
    );
    await waitFor(() =>
      expect(api.setVariantVisibility).toHaveBeenCalledWith({ id: variantId, onlineVisible: true }),
    );
    await user.click(screen.getByRole("button", { name: "Ocultar LAYTON-10ML en la tienda" }));

    await waitFor(() =>
      expect(api.setVariantVisibility).toHaveBeenCalledWith({
        id: "44444444-4444-4444-a444-444444444442",
        onlineVisible: false,
      }),
    );
  });

  it("cada variante dice si está visible en la tienda", async () => {
    renderCatalog(PUBLISHER, [
      product({
        variants: [
          variant({ sku: "LAYTON-125", onlineVisible: false }),
          variant({
            id: "44444444-4444-4444-a444-444444444442",
            sku: "LAYTON-10ML",
            onlineVisible: true,
          }),
        ],
      }),
    ]);

    const hidden = (await screen.findByText(/LAYTON-125/)).textContent;
    const shown = screen.getByText(/LAYTON-10ML/).textContent;

    expect(hidden).toContain("No visible en la tienda");
    expect(shown).toContain("Visible en la tienda");
  });

  it("si la API rechaza el cambio muestra el motivo, sin avisar éxito", async () => {
    const user = userEvent.setup();
    vi.mocked(api.setVariantVisibility).mockRejectedValue(
      new Error("Solo las variantes sellado, decant y unidad se pueden mostrar en la tienda."),
    );
    renderCatalog(PUBLISHER, [
      product({ variants: [variant({ sku: "LAYTON-GRANEL", onlineVisible: false })] }),
    ]);

    await user.click(
      await screen.findByRole("button", { name: "Mostrar LAYTON-GRANEL en la tienda" }),
    );

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/Solo las variantes sellado, decant y unidad/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
