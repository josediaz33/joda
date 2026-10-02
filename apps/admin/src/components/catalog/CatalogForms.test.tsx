// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { ProductEditor } from "./CatalogActions";
import { CreateVariantForm } from "./VariantForms";

vi.mock("../../api", () => ({
  api: {
    listCategories: vi.fn(),
    createProduct: vi.fn(),
    createVariant: vi.fn(),
  },
}));

Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
Element.prototype.scrollIntoView = () => {};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const categoryA = "33333333-3333-4333-a333-333333333331";
const categoryB = "33333333-3333-4333-a333-333333333332";

describe("RF-CAT-01/02 · alta por vertical y categoría primaria (WP-E05)", () => {
  it("crea un accesorio en dos categorías con exactamente una primaria", async () => {
    vi.mocked(api.listCategories).mockResolvedValue({
      items: [
        { id: categoryA, path: "accesorios", name: "Accesorios" },
        { id: categoryB, path: "regalos", name: "Regalos" },
      ],
      nextCursor: null,
    } as Awaited<ReturnType<typeof api.listCategories>>);
    vi.mocked(api.createProduct).mockResolvedValue({ id: "saved" } as Awaited<
      ReturnType<typeof api.createProduct>
    >);
    const saved = vi.fn();
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProductEditor kind="accessory" onSaved={saved} onClose={vi.fn()} />
      </QueryClientProvider>,
    );

    await user.type(await screen.findByLabelText("Nombre *"), "Estuche");
    await user.type(screen.getByLabelText("Slug *"), "estuche");
    await user.click(screen.getByRole("checkbox", { name: "accesorios" }));
    await user.click(screen.getByRole("checkbox", { name: "regalos" }));
    await user.click(screen.getAllByRole("radio", { name: "Primaria" })[1]!);
    await user.click(screen.getByRole("button", { name: "Crear producto" }));

    await waitFor(() =>
      expect(api.createProduct).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "accessory",
          categoryIds: [categoryA, categoryB],
          primaryCategoryId: categoryB,
        }),
      ),
    );
    expect(saved).toHaveBeenCalled();
  });
});

describe("docs/frontend-spec.md §9 · importes de variantes (WP-E05)", () => {
  it("muestra separadores de miles y envía un string de unidades menores", async () => {
    vi.mocked(api.createVariant).mockResolvedValue({ id: "saved" } as Awaited<
      ReturnType<typeof api.createVariant>
    >);
    const user = userEvent.setup();
    render(
      <CreateVariantForm productId="22222222-2222-4222-a222-222222222222" onSaved={vi.fn()} />,
    );

    await user.type(screen.getByLabelText("SKU *"), "EST-01");
    await user.type(screen.getByLabelText("Precio (Gs.) *"), "245000");
    expect((screen.getByLabelText("Precio (Gs.) *") as HTMLInputElement).value).toBe("Gs. 245.000");
    await user.click(screen.getByRole("button", { name: "Crear variante" }));

    await waitFor(() =>
      expect(api.createVariant).toHaveBeenCalledWith(
        expect.objectContaining({
          pricePyg: "245000",
        }),
      ),
    );
  });
});
