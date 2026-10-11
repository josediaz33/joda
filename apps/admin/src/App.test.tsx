// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, configure, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TRPCClientError } from "@trpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { api } from "./api";

vi.mock("./api", () => ({
  api: {
    current: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    enroll: vi.fn(),
    confirmEnroll: vi.fn(),
    verify: vi.fn(),
    listProducts: vi.fn(),
  },
}));

// CI carga los módulos lazy mientras corren las demás suites del monorepo.
// El segundo por defecto de Testing Library no alcanza bajo esa contención.
configure({ asyncUtilTimeout: 8_000 });

function renderApp(path: string) {
  window.history.pushState({}, "", path);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

const profile = {
  id: "22222222-2222-4222-a222-222222222222",
  email: "vendedor@jodaparfums.com",
  fullName: "Vendedor",
} as const;

// jsdom no implementa la captura de puntero que Radix usa en Select.
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
Element.prototype.scrollIntoView = () => {};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("docs/security-spec.md §4.3 · guardas MFA del admin (WP-E04)", () => {
  it("sin cookie muestra ingreso, sin navegación del admin", async () => {
    vi.mocked(api.current).mockRejectedValue(
      Object.assign(new TRPCClientError("Sin sesión"), { data: { httpStatus: 401 } }),
    );
    renderApp("/contabilidad");

    expect(await screen.findByRole("heading", { name: "Ingresar" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Principal" })).toBeNull();
  });

  it("sin MFA inscripto, aun con URL de contabilidad solo muestra inscripción", async () => {
    vi.mocked(api.current).mockResolvedValue({
      profile: { ...profile, mfaStatus: "pending_enrollment" },
      permissions: [],
    });
    renderApp("/contabilidad");

    expect(await screen.findByRole("heading", { name: "Inscribir segundo factor" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Principal" })).toBeNull();
    expect(window.location.pathname).toBe("/inscribir-mfa");
  });

  it("una sesión inscrita pendiente de desafío solo muestra verificación", async () => {
    vi.mocked(api.current).mockResolvedValue({
      profile: { ...profile, mfaStatus: "pending_verification" },
      permissions: [],
    });
    renderApp("/");

    expect(await screen.findByRole("heading", { name: "Verificar segundo factor" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Principal" })).toBeNull();
  });
});

describe("docs/security-spec.md §3.4 · permisos de presentación (WP-E04)", () => {
  it("un vendedor no ve el enlace contable y una URL directa vuelve al inicio", async () => {
    vi.mocked(api.current).mockResolvedValue({
      profile: { ...profile, mfaStatus: "satisfied" },
      permissions: ["catalog.product:read"],
    });
    renderApp("/contabilidad");

    expect(await screen.findByRole("heading", { name: "Buen día, Vendedor" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Contabilidad" })).toBeNull();
    await waitFor(() => expect(window.location.pathname).toBe("/"));
  });

  it("sin market.sourcing:read no ve el enlace de sourcing y una URL directa vuelve al inicio (WP-C16)", async () => {
    vi.mocked(api.current).mockResolvedValue({
      profile: { ...profile, mfaStatus: "satisfied" },
      permissions: ["catalog.product:read"],
    });
    renderApp("/sourcing");

    expect(await screen.findByRole("heading", { name: "Buen día, Vendedor" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sourcing" })).toBeNull();
    await waitFor(() => expect(window.location.pathname).toBe("/"));
  });

  it("con permiso de lectura del catálogo ve el enlace de categorías", async () => {
    vi.mocked(api.current).mockResolvedValue({
      profile: { ...profile, mfaStatus: "satisfied" },
      permissions: ["catalog.product:read"],
    });
    renderApp("/");

    expect(await screen.findByRole("link", { name: "Categorías" })).toBeTruthy();
  });

  it("sin permiso de catálogo no ve el enlace de categorías y una URL directa vuelve al inicio", async () => {
    vi.mocked(api.current).mockResolvedValue({
      profile: { ...profile, mfaStatus: "satisfied" },
      permissions: [],
    });
    renderApp("/categorias");

    expect(await screen.findByRole("heading", { name: "Buen día, Vendedor" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Categorías" })).toBeNull();
    await waitFor(() => expect(window.location.pathname).toBe("/"));
  });

  it("al cerrar sesión limpia el estado y vuelve al ingreso", async () => {
    vi.mocked(api.current)
      .mockResolvedValueOnce({
        profile: { ...profile, mfaStatus: "satisfied" },
        permissions: ["catalog.product:read"],
      })
      .mockRejectedValue(
        Object.assign(new TRPCClientError("Sin sesión"), { data: { httpStatus: 401 } }),
      );
    vi.mocked(api.logout).mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderApp("/");

    await user.click(await screen.findByRole("button", { name: "Salir" }));
    expect(await screen.findByRole("heading", { name: "Ingresar" })).toBeTruthy();
  });
});

describe("docs/backlog.md WP-E04 · Dialog, Select y Popover en un flujo consumidor", () => {
  it("filtra el catálogo por tipo y estado y abre el detalle del producto", async () => {
    vi.mocked(api.current).mockResolvedValue({
      profile: { ...profile, mfaStatus: "satisfied" },
      permissions: ["catalog.product:read"],
    });
    vi.mocked(api.listProducts).mockResolvedValue({
      items: [
        {
          id: profile.id,
          name: "Layton",
          brandName: "Parfums de Marly",
          kind: "perfume",
          status: "active",
          variants: [],
        },
      ],
      nextCursor: null,
    } as unknown as Awaited<ReturnType<typeof api.listProducts>>);
    const user = userEvent.setup();
    renderApp("/vista-catalogo");

    expect(await screen.findByText("Layton")).toBeTruthy();
    await user.click(screen.getByRole("combobox", { name: "Tipo de producto" }));
    await user.click(screen.getByRole("option", { name: "Perfumes" }));
    await user.click(screen.getByRole("button", { name: "Estado: Todos" }));
    await user.click(screen.getByRole("button", { name: "Activo" }));
    await waitFor(() =>
      expect(api.listProducts).toHaveBeenCalledWith({
        kind: "perfume",
        status: "active",
        limit: 20,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Ver detalle" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Layton" })).toBeTruthy();
  });
});
