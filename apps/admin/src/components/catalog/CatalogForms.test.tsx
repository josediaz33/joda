// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { ImageUpload, ProductEditor } from "./CatalogActions";
import { CreateVariantForm } from "./VariantForms";

vi.mock("../../api", () => ({
  api: {
    listCategories: vi.fn(),
    createProduct: vi.fn(),
    createVariant: vi.fn(),
    uploadProductMedia: vi.fn(),
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

describe("RF-CAT-08 · vista previa de imagen (WP-E05)", () => {
  it("no reserva un alto inventado si el servicio no devuelve dimensiones", async () => {
    vi.mocked(api.uploadProductMedia).mockResolvedValue({
      id: "44444444-4444-4444-a444-444444444444",
      productId: "22222222-2222-4222-a222-222222222222",
      variantId: null,
      altText: "Estuche negro",
      position: 0,
      width: 100,
      height: null,
      bytes: 400,
      mimeType: "image/jpeg",
      derivatives: [{ width: 320, format: "webp", url: "https://example.com/320.webp" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const user = userEvent.setup();
    render(
      <ImageUpload
        product={
          { id: "22222222-2222-4222-a222-222222222222", name: "Estuche" } as Parameters<
            typeof ImageUpload
          >[0]["product"]
        }
        onClose={vi.fn()}
      />,
    );

    await user.upload(
      screen.getByLabelText("Archivo de imagen *"),
      new File(["jpeg"], "foto.jpg", { type: "image/jpeg" }),
    );
    await user.type(screen.getByLabelText("Descripción de la imagen *"), "Estuche negro");
    expect((screen.getByLabelText("Archivo de imagen *") as HTMLInputElement).files?.length).toBe(
      1,
    );
    expect(
      (screen.getByRole("button", { name: "Subir imagen" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    // jsdom considera inválido un file input required aun con `files` cargado.
    fireEvent.submit(
      (screen.getByRole("button", { name: "Subir imagen" }) as HTMLButtonElement).form!,
    );

    await waitFor(() => expect(api.uploadProductMedia).toHaveBeenCalled());

    expect(
      await screen.findByText("La vista previa no tiene dimensiones disponibles."),
    ).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });
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
