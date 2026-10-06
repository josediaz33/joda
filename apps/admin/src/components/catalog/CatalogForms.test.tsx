// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { ImageUpload, ProductEditor } from "./CatalogActions";
import { CreateVariantForm, EditVariantForm } from "./VariantForms";

vi.mock("../../api", () => ({
  api: {
    listCategories: vi.fn(),
    createCategory: vi.fn(),
    createProduct: vi.fn(),
    updateProduct: vi.fn(),
    createVariant: vi.fn(),
    updateVariant: vi.fn(),
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
  it("permite crear la primera categoría y luego dar de alta un producto", async () => {
    let categories: Awaited<ReturnType<typeof api.listCategories>> = {
      items: [],
      nextCursor: null,
    };
    vi.mocked(api.listCategories).mockImplementation(async () => categories);
    vi.mocked(api.createCategory).mockImplementation(async (input) => {
      const created = {
        id: categoryA,
        path: input.slug,
        name: input.name,
      } as Awaited<ReturnType<typeof api.createCategory>>;
      categories = { items: [created], nextCursor: null };
      return created;
    });
    vi.mocked(api.createProduct).mockResolvedValue({ id: "saved" } as Awaited<
      ReturnType<typeof api.createProduct>
    >);
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProductEditor kind="accessory" onSaved={vi.fn()} onClose={vi.fn()} />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText("Para cargar el primer producto, creá una categoría raíz."),
    ).toBeTruthy();
    await user.type(screen.getByLabelText("Nombre de la categoría *"), "Accesorios");
    await user.type(screen.getByLabelText("Slug de la categoría *"), "accesorios");
    await user.click(screen.getByRole("button", { name: "Crear primera categoría" }));
    await waitFor(() =>
      expect(api.createCategory).toHaveBeenCalledWith({ name: "Accesorios", slug: "accesorios" }),
    );

    await user.type(await screen.findByLabelText("Nombre *"), "Estuche");
    await user.type(screen.getByLabelText("Slug *"), "estuche");
    await user.click(screen.getByRole("checkbox", { name: "accesorios" }));
    await user.click(screen.getByRole("button", { name: "Crear producto" }));
    await waitFor(() =>
      expect(api.createProduct).toHaveBeenCalledWith(
        expect.objectContaining({ categoryIds: [categoryA], primaryCategoryId: categoryA }),
      ),
    );
  });

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

  it("edita la vertical y categorías sin modificar el estado de publicación", async () => {
    vi.mocked(api.listCategories).mockResolvedValue({
      items: [{ id: categoryA, path: "accesorios", name: "Accesorios" }],
      nextCursor: null,
    } as Awaited<ReturnType<typeof api.listCategories>>);
    vi.mocked(api.updateProduct).mockResolvedValue({ id: "saved" } as Awaited<
      ReturnType<typeof api.updateProduct>
    >);
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProductEditor
          kind="accessory"
          product={{
            id: "22222222-2222-4222-a222-222222222222",
            kind: "accessory",
            slug: "estuche",
            name: "Estuche",
            description: null,
            brandId: null,
            brandName: null,
            categoryIds: [categoryA],
            primaryCategoryId: categoryA,
            tagIds: [],
            status: "active",
            publishedAt: "2026-01-01T00:00:00.000Z",
            seo: {},
            facets: {},
            variants: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            accessoryDetails: { material: null, color: null, sizeLabel: null },
          }}
          onSaved={vi.fn()}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );

    await user.clear(await screen.findByLabelText("Nombre *"));
    await user.type(screen.getByLabelText("Nombre *"), "Estuche de viaje");
    await user.type(screen.getByLabelText("Material"), "Cuero");
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() => expect(api.updateProduct).toHaveBeenCalled());
    expect(api.updateProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Estuche de viaje",
        categoryIds: [categoryA],
        primaryCategoryId: categoryA,
        accessoryDetails: expect.objectContaining({ material: "Cuero" }),
      }),
    );
    expect(vi.mocked(api.updateProduct).mock.calls[0]?.[0]).not.toHaveProperty("status");
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

describe("GLOSARIO.md · el granel no se vende directo (WP-E05)", () => {
  it("no ofrece publicación ni envía onlineVisible al crear granel", async () => {
    vi.mocked(api.createVariant).mockResolvedValue({ id: "saved" } as Awaited<
      ReturnType<typeof api.createVariant>
    >);
    const user = userEvent.setup();
    render(
      <CreateVariantForm productId="22222222-2222-4222-a222-222222222222" onSaved={vi.fn()} />,
    );

    await user.selectOptions(screen.getByLabelText("Presentación"), "bulk");
    expect(screen.queryByRole("checkbox", { name: "Visible en línea" })).toBeNull();
    await user.type(screen.getByLabelText("SKU *"), "GRANEL-01");
    await user.type(screen.getByLabelText("Precio (Gs.) *"), "245000");
    await user.click(screen.getByRole("button", { name: "Crear variante" }));

    await waitFor(() =>
      expect(api.createVariant).toHaveBeenCalledWith(
        expect.objectContaining({ variantType: "bulk" }),
      ),
    );
    expect(vi.mocked(api.createVariant).mock.calls[0]?.[0]).not.toHaveProperty("onlineVisible");
  });

  it("no ofrece publicación al editar un granel que ya tenía visibilidad", async () => {
    vi.mocked(api.updateVariant).mockResolvedValue({ id: "saved" } as Awaited<
      ReturnType<typeof api.updateVariant>
    >);
    const user = userEvent.setup();
    render(
      <EditVariantForm
        variant={
          {
            id: "44444444-4444-4444-a444-444444444444",
            sku: "GRANEL-01",
            variantType: "bulk",
            pricePyg: "245000",
            compareAtPyg: null,
            vatRate: "iva_10",
            onlineVisible: true,
            position: 0,
          } as Parameters<typeof EditVariantForm>[0]["variant"]
        }
        onSaved={vi.fn()}
      />,
    );

    expect(screen.queryByRole("checkbox", { name: "Visible en línea" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Guardar variante" }));
    await waitFor(() => expect(api.updateVariant).toHaveBeenCalled());
    expect(vi.mocked(api.updateVariant).mock.calls[0]?.[0]).not.toHaveProperty("onlineVisible");
  });
});

describe("RN-FRA-05 · el perfume nuevo nace con la merma de negocio (WP-E05a)", () => {
  it("crea un perfume sin tocar merma ni decantable y envía los valores de PERFUME_DEFAULTS", async () => {
    vi.mocked(api.listCategories).mockResolvedValue({
      items: [{ id: categoryA, path: "perfumes", name: "Perfumes" }],
      nextCursor: null,
    } as Awaited<ReturnType<typeof api.listCategories>>);
    vi.mocked(api.createProduct).mockResolvedValue({ id: "saved" } as Awaited<
      ReturnType<typeof api.createProduct>
    >);
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProductEditor kind="perfume" onSaved={vi.fn()} onClose={vi.fn()} />
      </QueryClientProvider>,
    );

    await user.type(await screen.findByLabelText("Nombre *"), "Sauvage");
    await user.type(screen.getByLabelText("Slug *"), "sauvage");
    await user.click(screen.getByRole("checkbox", { name: "perfumes" }));
    await user.click(screen.getByRole("button", { name: "Crear producto" }));

    await waitFor(() =>
      expect(api.createProduct).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "perfume",
          perfumeDetails: expect.objectContaining({
            isDecantable: true,
            wasteFactor: 0.02,
            unusableResidueMl: 2,
            evaporationMlYear: 0,
          }),
        }),
      ),
    );
  });
});

describe("RN-SER · el reloj nuevo lleva serie y garantía de negocio (WP-E05a)", () => {
  it("crea un reloj sin tocar serie ni garantía y envía los valores de WATCH_DEFAULTS", async () => {
    vi.mocked(api.listCategories).mockResolvedValue({
      items: [{ id: categoryA, path: "relojes", name: "Relojes" }],
      nextCursor: null,
    } as Awaited<ReturnType<typeof api.listCategories>>);
    vi.mocked(api.createProduct).mockResolvedValue({ id: "saved" } as Awaited<
      ReturnType<typeof api.createProduct>
    >);
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProductEditor kind="watch" onSaved={vi.fn()} onClose={vi.fn()} />
      </QueryClientProvider>,
    );

    await user.type(await screen.findByLabelText("Nombre *"), "Submariner");
    await user.type(screen.getByLabelText("Slug *"), "submariner");
    await user.click(screen.getByRole("checkbox", { name: "relojes" }));
    await user.click(screen.getByRole("button", { name: "Crear producto" }));

    await waitFor(() =>
      expect(api.createProduct).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "watch",
          // Campos numéricos vacíos: null, nunca 0 (sin resistencia medida, no es 0 m).
          watchDetails: expect.objectContaining({
            requiresSerial: true,
            warrantyMonths: 12,
            caseDiameterMm: null,
            waterResistanceM: null,
          }),
        }),
      ),
    );
  });
});

describe("RN-SER-02 · solo una variante en unit se serializa (WP-E05)", () => {
  it("no ofrece 'Requiere serie' al cambiar a granel y no lo envía", async () => {
    vi.mocked(api.createVariant).mockResolvedValue({ id: "saved" } as Awaited<
      ReturnType<typeof api.createVariant>
    >);
    const user = userEvent.setup();
    render(
      <CreateVariantForm productId="22222222-2222-4222-a222-222222222222" onSaved={vi.fn()} />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Requiere serie" }));
    await user.selectOptions(screen.getByLabelText("Presentación"), "bulk");
    expect(screen.queryByRole("checkbox", { name: "Requiere serie" })).toBeNull();
    await user.type(screen.getByLabelText("SKU *"), "GRANEL-02");
    await user.type(screen.getByLabelText("Precio (Gs.) *"), "245000");
    await user.click(screen.getByRole("button", { name: "Crear variante" }));

    await waitFor(() =>
      expect(api.createVariant).toHaveBeenCalledWith(
        expect.objectContaining({ variantType: "bulk", isSerialized: false }),
      ),
    );
  });
});

describe("RF-CAT-02 · el tamaño de un decant se declara, no se precarga (WP-E05)", () => {
  it("no precarga 1 ml al elegir decant", async () => {
    const user = userEvent.setup();
    render(
      <CreateVariantForm productId="22222222-2222-4222-a222-222222222222" onSaved={vi.fn()} />,
    );

    await user.selectOptions(screen.getByLabelText("Presentación"), "decant");
    expect((screen.getByLabelText("Tamaño (ml) *") as HTMLInputElement).value).toBe("");
  });

  it("no envía 0 ml si el tamaño del decant queda vacío", async () => {
    vi.mocked(api.createVariant).mockResolvedValue({ id: "saved" } as Awaited<
      ReturnType<typeof api.createVariant>
    >);
    const user = userEvent.setup();
    render(
      <CreateVariantForm productId="22222222-2222-4222-a222-222222222222" onSaved={vi.fn()} />,
    );

    await user.selectOptions(screen.getByLabelText("Presentación"), "decant");
    await user.type(screen.getByLabelText("SKU *"), "DECANT-EMPTY");
    await user.type(screen.getByLabelText("Precio (Gs.) *"), "95000");
    await user.click(screen.getByRole("button", { name: "Crear variante" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Tamaño (ml) *").getAttribute("aria-invalid")).toBe("true"),
    );
    expect(api.createVariant).not.toHaveBeenCalled();
  });
});
