// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AdminCategory } from "@joda/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import Categories from "./Categories";

vi.mock("../api", () => ({
  api: {
    current: vi.fn(),
    listCategories: vi.fn(),
    createCategory: vi.fn(),
    updateCategory: vi.fn(),
  },
}));

Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
Element.prototype.scrollIntoView = () => {};

// RF-CAT-03 (docs/especificacion-software.md §2.1) · WP-E05b: administrar el
// árbol de categorías con jerarquía padre-hijo, orden y visibilidad.

const perfumeriaId = "33333333-3333-4333-a333-333333333331";
const nichoId = "33333333-3333-4333-a333-333333333332";
const arabesId = "33333333-3333-4333-a333-333333333333";
const relojesId = "33333333-3333-4333-a333-333333333334";

function category(
  overrides: Partial<AdminCategory> & Pick<AdminCategory, "id" | "name" | "path">,
): AdminCategory {
  return {
    parentId: null,
    slug: overrides.path,
    position: 0,
    isVisible: true,
    seo: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const perfumeria = category({ id: perfumeriaId, name: "Perfumería", path: "perfumeria" });
const nicho = category({
  id: nichoId,
  name: "Nicho",
  path: "perfumeria/nicho",
  parentId: perfumeriaId,
  position: 1,
});
const arabes = category({
  id: arabesId,
  name: "Árabes",
  path: "perfumeria/nicho/arabes",
  parentId: nichoId,
});
const relojes = category({ id: relojesId, name: "Relojes", path: "relojes", position: 1 });

const WRITER = ["catalog.product:read", "catalog.product:write"] as const;

function renderCategories(permissions: readonly string[], items: AdminCategory[]) {
  vi.mocked(api.current).mockResolvedValue({
    profile: { fullName: "Admin", mfaStatus: "satisfied" },
    permissions: [...permissions],
  } as Awaited<ReturnType<typeof api.current>>);
  vi.mocked(api.listCategories).mockResolvedValue({ items, nextCursor: null });
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Categories />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.updateCategory).mockResolvedValue({} as AdminCategory);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RF-CAT-03 · la pantalla muestra el árbol", () => {
  it("lista las categorías en orden de árbol, con su dirección", async () => {
    renderCategories(WRITER, [relojes, arabes, nicho, perfumeria]);

    const items = await screen.findAllByRole("listitem");

    expect(items.map((item) => within(item).getByText(/^[a-z/]+$/).textContent)).toEqual([
      "perfumeria",
      "perfumeria/nicho",
      "perfumeria/nicho/arabes",
      "relojes",
    ]);
  });

  it("marca como oculta a la categoría que no es visible", async () => {
    renderCategories(WRITER, [{ ...relojes, isVisible: false }]);

    const item = (await screen.findAllByRole("listitem"))[0]!;

    expect(within(item).getByText("Oculta")).toBeTruthy();
    expect(within(item).getByRole("button", { name: "Mostrar Relojes" })).toBeTruthy();
  });

  it("sin permiso de escritura muestra el árbol pero ninguna acción", async () => {
    renderCategories(["catalog.product:read"], [perfumeria, nicho]);

    await screen.findByText("Perfumería");

    expect(screen.queryByRole("button", { name: "Nueva categoría raíz" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mover Nicho" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Renombrar Nicho" })).toBeNull();
  });
});

describe("RF-CAT-03 · orden y visibilidad", () => {
  it("subir una categoría la intercambia con su hermana anterior y renumera", async () => {
    const user = userEvent.setup();
    renderCategories(WRITER, [perfumeria, relojes]);

    await user.click(await screen.findByRole("button", { name: "Subir Relojes" }));

    await waitFor(() => expect(api.updateCategory).toHaveBeenCalledTimes(2));
    expect(api.updateCategory).toHaveBeenCalledWith({ id: relojesId, position: 0 });
    expect(api.updateCategory).toHaveBeenCalledWith({ id: perfumeriaId, position: 1 });
  });

  it("la primera hermana no se puede subir ni la última bajar", async () => {
    renderCategories(WRITER, [perfumeria, relojes]);

    const subirPrimera = await screen.findByRole("button", { name: "Subir Perfumería" });
    const bajarUltima = screen.getByRole("button", { name: "Bajar Relojes" });

    expect((subirPrimera as HTMLButtonElement).disabled).toBe(true);
    expect((bajarUltima as HTMLButtonElement).disabled).toBe(true);
  });

  it("ocultar manda solo la visibilidad", async () => {
    const user = userEvent.setup();
    renderCategories(WRITER, [relojes]);

    await user.click(await screen.findByRole("button", { name: "Ocultar Relojes" }));

    await waitFor(() =>
      expect(api.updateCategory).toHaveBeenCalledWith({ id: relojesId, isVisible: false }),
    );
  });
});

describe("RF-CAT-03 · alta y renombrado", () => {
  it("crea una subcategoría dentro de la elegida, al final de sus hermanas", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createCategory).mockResolvedValue({} as AdminCategory);
    renderCategories(WRITER, [perfumeria, nicho]);

    await user.click(
      await screen.findByRole("button", { name: "Agregar subcategoría a Perfumería" }),
    );
    await user.type(await screen.findByLabelText("Nombre *"), "Diseñador");
    await user.type(screen.getByLabelText("Slug *"), "disenador");
    await user.click(screen.getByRole("button", { name: "Crear categoría" }));

    await waitFor(() =>
      expect(api.createCategory).toHaveBeenCalledWith({
        name: "Diseñador",
        slug: "disenador",
        parentId: perfumeriaId,
        position: 2,
      }),
    );
  });

  it("crea una categoría raíz sin parentId, al final de las raíces", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createCategory).mockResolvedValue({} as AdminCategory);
    renderCategories(WRITER, [perfumeria, relojes]);

    await user.click(await screen.findByRole("button", { name: "Nueva categoría raíz" }));
    await user.type(await screen.findByLabelText("Nombre *"), "Accesorios");
    await user.type(screen.getByLabelText("Slug *"), "accesorios");
    await user.click(screen.getByRole("button", { name: "Crear categoría" }));

    await waitFor(() =>
      expect(api.createCategory).toHaveBeenCalledWith({
        name: "Accesorios",
        slug: "accesorios",
        position: 2,
      }),
    );
  });

  it("renombra sin tocar el slug", async () => {
    const user = userEvent.setup();
    renderCategories(WRITER, [perfumeria]);

    await user.click(await screen.findByRole("button", { name: "Renombrar Perfumería" }));
    const field = await screen.findByLabelText("Nombre *");
    await user.clear(field);
    await user.type(field, "Perfumes");
    await user.click(screen.getByRole("button", { name: "Guardar nombre" }));

    await waitFor(() =>
      expect(api.updateCategory).toHaveBeenCalledWith({ id: perfumeriaId, name: "Perfumes" }),
    );
  });
});

describe("RF-CAT-03 · reubicar una categoría", () => {
  it("el selector no ofrece la categoría ni su subárbol", async () => {
    const user = userEvent.setup();
    renderCategories(WRITER, [perfumeria, nicho, arabes, relojes]);

    await user.click(await screen.findByRole("button", { name: "Mover Nicho" }));
    const select = await screen.findByLabelText("Dentro de");

    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Ninguna (categoría raíz)", "perfumeria", "relojes"]);
  });

  it("mueve la categoría bajo otro padre", async () => {
    const user = userEvent.setup();
    renderCategories(WRITER, [perfumeria, nicho, relojes]);

    await user.click(await screen.findByRole("button", { name: "Mover Nicho" }));
    await user.selectOptions(await screen.findByLabelText("Dentro de"), "relojes");
    await user.click(screen.getByRole("button", { name: "Mover" }));

    await waitFor(() =>
      expect(api.updateCategory).toHaveBeenCalledWith({ id: nichoId, parentId: relojesId }),
    );
  });

  it("la pasa a raíz con parentId null", async () => {
    const user = userEvent.setup();
    renderCategories(WRITER, [perfumeria, nicho]);

    await user.click(await screen.findByRole("button", { name: "Mover Nicho" }));
    await user.selectOptions(await screen.findByLabelText("Dentro de"), "Ninguna (categoría raíz)");
    await user.click(screen.getByRole("button", { name: "Mover" }));

    await waitFor(() =>
      expect(api.updateCategory).toHaveBeenCalledWith({ id: nichoId, parentId: null }),
    );
  });

  it("sin elegir otro destino no llama a la API", async () => {
    const user = userEvent.setup();
    renderCategories(WRITER, [perfumeria, nicho]);

    await user.click(await screen.findByRole("button", { name: "Mover Nicho" }));
    await user.click(await screen.findByRole("button", { name: "Mover" }));

    expect(api.updateCategory).not.toHaveBeenCalled();
  });

  it("muestra el rechazo de la API y deja el diálogo abierto", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateCategory).mockRejectedValue(
      new Error("Una categoría no puede quedar dentro de sí misma ni de una de sus subcategorías."),
    );
    renderCategories(WRITER, [perfumeria, nicho, relojes]);

    await user.click(await screen.findByRole("button", { name: "Mover Nicho" }));
    await user.selectOptions(await screen.findByLabelText("Dentro de"), "relojes");
    await user.click(screen.getByRole("button", { name: "Mover" }));

    expect(
      await screen.findByText(
        "Una categoría no puede quedar dentro de sí misma ni de una de sus subcategorías.",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("Dentro de")).toBeTruthy();
  });
});
