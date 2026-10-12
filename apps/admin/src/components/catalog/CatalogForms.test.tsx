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

// CreateVariantForm solo lee `product.id` y `product.kind` (más
// `watchDetails.requiresSerial` si es reloj, WP-E05c). Para una variante de
// cualquier otra vertical no hace falta un AdminProduct completo.
const genericProduct = {
  id: "22222222-2222-4222-a222-222222222222",
  kind: "accessory",
} as Parameters<typeof CreateVariantForm>[0]["product"];

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
    render(<CreateVariantForm product={genericProduct} onSaved={vi.fn()} />);

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
    render(<CreateVariantForm product={genericProduct} onSaved={vi.fn()} />);

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
            wasteFactor: 0.05,
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
    await user.click(screen.getByRole("radio", { name: "Sí" }));
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

// No todos los relojes llevan número de serie (0035_business_defaults_decisions.sql
// le quitó el DEFAULT a requires_serial): "no elegido" y "No" son estados
// distintos, y el formulario no puede guardar sin decidir.
describe("RN-SER · un reloj sin elegir si lleva serie no se puede guardar (WP-E05a)", () => {
  it("no envía el producto si no se elige 'Requiere número de serie'", async () => {
    vi.mocked(api.listCategories).mockResolvedValue({
      items: [{ id: categoryA, path: "relojes", name: "Relojes" }],
      nextCursor: null,
    } as Awaited<ReturnType<typeof api.listCategories>>);
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

    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    expect((screen.getByRole("radio", { name: "Sí" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("radio", { name: "No" }) as HTMLInputElement).checked).toBe(false);
    expect(api.createProduct).not.toHaveBeenCalled();
  });
});

// WP-E05e. Cambiar `requiresSerial` de un reloj se propaga a todas sus variantes (WP-C08h):
// el formulario lo manda solo si el operador lo cambió, y avisa antes de guardar.
describe("RN-SER-02 · el formulario del reloj manda requiresSerial solo si se tocó y avisa que se propaga (WP-E05e)", () => {
  const WATCH_ID = "22222222-2222-4222-a222-222222222299";

  function watchProduct(variantCount: number) {
    return {
      id: WATCH_ID,
      kind: "watch",
      slug: "submariner",
      name: "Submariner",
      description: null,
      brandId: null,
      brandName: null,
      categoryIds: [categoryA],
      primaryCategoryId: categoryA,
      tagIds: [],
      status: "active",
      publishedAt: null,
      seo: {},
      facets: {},
      variants: Array.from({ length: variantCount }, (_, index) => ({ id: `variante-${index}` })),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      watchDetails: {
        movement: "automatic",
        caseMaterial: "acero",
        caseDiameterMm: 40,
        waterResistanceM: 300,
        strapMaterial: null,
        crystal: null,
        warrantyMonths: 12,
        requiresSerial: true,
      },
    } as unknown as Parameters<typeof ProductEditor>[0]["product"];
  }

  function renderWatchEditor(variantCount: number) {
    vi.mocked(api.listCategories).mockResolvedValue({
      items: [{ id: categoryA, path: "relojes", name: "Relojes" }],
      nextCursor: null,
    } as Awaited<ReturnType<typeof api.listCategories>>);
    vi.mocked(api.updateProduct).mockResolvedValue({ id: "saved" } as Awaited<
      ReturnType<typeof api.updateProduct>
    >);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProductEditor
          kind="watch"
          product={watchProduct(variantCount)}
          onSaved={vi.fn()}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
  }

  function sentWatchDetails() {
    return vi.mocked(api.updateProduct).mock.calls[0]?.[0].watchDetails;
  }

  it("abrir el reloj, que otra persona cambie requiresSerial, corregir solo el nombre y guardar no manda el campo: no lo revierte", async () => {
    const user = userEvent.setup();
    renderWatchEditor(2);

    // El servidor ya tiene otro valor (lo cambió otra persona); este formulario cargó `true`.
    await user.clear(await screen.findByLabelText("Nombre *"));
    await user.type(screen.getByLabelText("Nombre *"), "Submariner Date");
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(api.updateProduct).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.updateProduct).mock.calls[0]?.[0]).toMatchObject({
      id: WATCH_ID,
      name: "Submariner Date",
    });
    expect(sentWatchDetails()).toBeDefined();
    expect(sentWatchDetails()).not.toHaveProperty("requiresSerial");
    // El resto del detalle sí viaja.
    expect(sentWatchDetails()).toMatchObject({ caseMaterial: "acero", warrantyMonths: 12 });
  });

  it("cambiar el campo lo manda, con el valor nuevo", async () => {
    const user = userEvent.setup();
    renderWatchEditor(2);

    await user.click(await screen.findByRole("radio", { name: "No" }));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(api.updateProduct).toHaveBeenCalledTimes(1));
    expect(sentWatchDetails()).toMatchObject({ requiresSerial: false });
  });

  it("cambiarlo y volver al valor que se cargó es no haberlo tocado: no se manda", async () => {
    const user = userEvent.setup();
    renderWatchEditor(2);

    await user.click(await screen.findByRole("radio", { name: "No" }));
    await user.click(screen.getByRole("radio", { name: "Sí" }));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(api.updateProduct).toHaveBeenCalledTimes(1));
    expect(sentWatchDetails()).not.toHaveProperty("requiresSerial");
  });

  it("antes de guardar, al cambiar el campo avisa a cuántas variantes llega y por qué la API puede rechazarlo, y el aviso se va si se vuelve al valor cargado", async () => {
    const user = userEvent.setup();
    renderWatchEditor(3);

    await user.click(await screen.findByRole("radio", { name: "No" }));
    const notice = screen.getByRole("status");
    expect(notice.textContent).toBe(
      "Las 3 variantes de este reloj dejan de llevar número de serie al guardar. Si alguna ya tiene unidades registradas, el guardado se rechaza y no cambia nada.",
    );
    expect(api.updateProduct).not.toHaveBeenCalled();

    await user.click(screen.getByRole("radio", { name: "Sí" }));
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("el aviso concuerda con una sola variante y con el cambio a «Sí»", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listCategories).mockResolvedValue({
      items: [{ id: categoryA, path: "relojes", name: "Relojes" }],
      nextCursor: null,
    } as Awaited<ReturnType<typeof api.listCategories>>);
    const sinSerie = watchProduct(1) as unknown as {
      watchDetails: { requiresSerial: boolean };
    };
    sinSerie.watchDetails.requiresSerial = false;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProductEditor
          kind="watch"
          product={sinSerie as unknown as Parameters<typeof ProductEditor>[0]["product"]}
          onSaved={vi.fn()}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole("radio", { name: "Sí" }));

    expect(screen.getByRole("status").textContent).toBe(
      "La variante de este reloj pasa a llevar número de serie al guardar. Si alguna se mide en ml, el guardado se rechaza y no cambia nada.",
    );
  });

  it("un reloj sin variantes no tiene nada que propagar: no avisa", async () => {
    const user = userEvent.setup();
    renderWatchEditor(0);

    await user.click(await screen.findByRole("radio", { name: "No" }));

    expect(screen.getByRole("status").textContent).toBe("");
  });
});

describe("RN-SER-02 · solo una variante en unit se serializa (WP-E05)", () => {
  it("no ofrece 'Requiere serie' al cambiar a granel y no lo envía", async () => {
    vi.mocked(api.createVariant).mockResolvedValue({ id: "saved" } as Awaited<
      ReturnType<typeof api.createVariant>
    >);
    const user = userEvent.setup();
    render(<CreateVariantForm product={genericProduct} onSaved={vi.fn()} />);

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

// WP-E05c: la variante de un reloj hereda is_serialized de requiresSerial del
// producto en el servicio de catálogo; marcarla aparte se rechaza con 400
// VALIDATION_SERIALIZED_INHERITED. El formulario no ofrece el control ni
// manda el campo: lo muestra de solo lectura.
describe("WP-E05c · la variante de un reloj hereda is_serialized del producto", () => {
  const watchWithSerial = {
    id: "55555555-5555-4555-a555-555555555555",
    kind: "watch",
    watchDetails: { requiresSerial: true },
  } as Parameters<typeof CreateVariantForm>[0]["product"];

  it("no ofrece el control de serie y lo muestra de solo lectura", async () => {
    vi.mocked(api.createVariant).mockResolvedValue({ id: "saved" } as Awaited<
      ReturnType<typeof api.createVariant>
    >);
    const user = userEvent.setup();
    render(<CreateVariantForm product={watchWithSerial} onSaved={vi.fn()} />);

    expect(screen.queryByRole("checkbox", { name: "Requiere serie" })).toBeNull();
    const inheritedNote = screen.getByText(
      (_, element) =>
        element?.tagName.toLowerCase() === "p" &&
        !!element.textContent?.includes("Requiere número de serie"),
    );
    expect(inheritedNote.textContent).toContain("Sí");

    await user.type(screen.getByLabelText("SKU *"), "RELOJ-01");
    await user.type(screen.getByLabelText("Precio (Gs.) *"), "3500000");
    await user.click(screen.getByRole("button", { name: "Crear variante" }));

    await waitFor(() => expect(api.createVariant).toHaveBeenCalled());
    expect(vi.mocked(api.createVariant).mock.calls[0]?.[0]).not.toHaveProperty("isSerialized");
  });
});

describe("RF-CAT-02 · el tamaño de un decant se declara, no se precarga (WP-E05)", () => {
  it("no precarga 1 ml al elegir decant", async () => {
    const user = userEvent.setup();
    render(<CreateVariantForm product={genericProduct} onSaved={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText("Presentación"), "decant");
    expect((screen.getByLabelText("Tamaño (ml) *") as HTMLInputElement).value).toBe("");
  });

  it("no envía 0 ml si el tamaño del decant queda vacío", async () => {
    vi.mocked(api.createVariant).mockResolvedValue({ id: "saved" } as Awaited<
      ReturnType<typeof api.createVariant>
    >);
    const user = userEvent.setup();
    render(<CreateVariantForm product={genericProduct} onSaved={vi.fn()} />);

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
