// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, configure, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Sourcing from "./Sourcing";
import { api } from "../api";

vi.mock("../api", () => ({
  api: { current: vi.fn() },
}));

configure({ asyncUtilTimeout: 8_000 });

Element.prototype.scrollIntoView = () => {};

function renderSourcing() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Sourcing />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.current).mockResolvedValue({
    profile: {
      id: "22222222-2222-4222-a222-222222222222",
      email: "deposito@jodaparfums.com",
      fullName: "Depósito",
      mfaStatus: "satisfied",
    },
    permissions: ["market.sourcing:read", "market.sourcing:write"],
  } as unknown as Awaited<ReturnType<typeof api.current>>);
});
afterEach(cleanup);

const VARIANT_ID = "11111111-1111-4111-a111-111111111111";

/** Llena la única línea con el ejemplo verificado de docs/domain-rules.md RN-SRC-01/02. */
async function fillWorkedExample(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText("Id de variante"));
  await user.paste(VARIANT_ID);
  await user.clear(screen.getByLabelText("Flete total"));
  await user.type(screen.getByLabelText("Flete total"), "2000");
  await user.clear(screen.getByLabelText("Arancel (%, ad valorem)"));
  await user.type(screen.getByLabelText("Arancel (%, ad valorem)"), "10");
  await user.clear(screen.getByLabelText("Precio del proveedor (centavos)"));
  await user.type(screen.getByLabelText("Precio del proveedor (centavos)"), "30000");
  await user.clear(screen.getByLabelText("Tipo de cambio asumido"));
  await user.type(screen.getByLabelText("Tipo de cambio asumido"), "7300");
  await user.clear(screen.getByLabelText("Precio de venta proyectado"));
  await user.type(screen.getByLabelText("Precio de venta proyectado"), "3500000");
}

describe("RN-SRC-01/02 · WP-C16, vista previa de sourcing calculada en el cliente", () => {
  it("reloj importado: USD 300 + flete USD 20 + arancel 10%, fx 7.300 → costo puesto Gs. 2.555.000 y margen 19,7%", async () => {
    const user = userEvent.setup();
    renderSourcing();

    await fillWorkedExample(user);

    expect(await screen.findByText("Gs. 2.555.000")).toBeTruthy();
    expect(await screen.findByText("19,7%")).toBeTruthy();
  });

  it("RF-SRC-04 · nunca ofrece una acción que afecte inventario o caja mientras no exista la API (WP-C16b)", async () => {
    renderSourcing();

    const save = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Guardar escenario",
    });
    const convert = screen.getByRole<HTMLButtonElement>("button", {
      name: "Convertir en orden de compra",
    });
    expect(save.disabled).toBe(true);
    expect(convert.disabled).toBe(true);
  });
});

describe("RN-SRC-03 · alerta de margen bajo umbral configurable", () => {
  it("con el umbral por defecto (25%) un margen de 19,7% se marca con la alerta", async () => {
    const user = userEvent.setup();
    renderSourcing();

    await fillWorkedExample(user);

    expect(await screen.findByText("19,7%")).toBeTruthy();
    expect(screen.getByText((text) => text.includes("⚠"))).toBeTruthy();
  });

  it("subir el umbral por debajo del margen (15%) retira la alerta — es un parámetro, no una constante", async () => {
    const user = userEvent.setup();
    renderSourcing();

    await fillWorkedExample(user);
    await user.clear(screen.getByLabelText("Umbral de margen (%)"));
    await user.type(screen.getByLabelText("Umbral de margen (%)"), "15");

    expect(await screen.findByText("19,7%")).toBeTruthy();
    expect(screen.queryByText((text) => text.includes("⚠"))).toBeNull();
  });
});

describe("RF-SRC-02 · comparación línea por línea de la misma variante", () => {
  it("dos líneas con la misma variante: la de mejor margen se marca como mejor opción", async () => {
    const user = userEvent.setup();
    renderSourcing();

    await fillWorkedExample(user);

    await user.click(screen.getByRole("button", { name: "Agregar línea" }));
    const variantIds = screen.getAllByLabelText("Id de variante");
    await user.click(variantIds[1]!);
    await user.paste(VARIANT_ID);
    const providerPrices = screen.getAllByLabelText("Precio del proveedor (centavos)");
    await user.clear(providerPrices[1]!);
    await user.type(providerPrices[1]!, "20000"); // proveedor más barato: USD 200
    const salePrices = screen.getAllByLabelText("Precio de venta proyectado");
    await user.clear(salePrices[1]!);
    await user.type(salePrices[1]!, "3500000");
    const fxInputs = screen.getAllByLabelText("Tipo de cambio asumido");
    await user.clear(fxInputs[1]!);
    await user.type(fxInputs[1]!, "7300");

    expect(await screen.findAllByText("Mejor opción")).toHaveLength(1);
  });
});
