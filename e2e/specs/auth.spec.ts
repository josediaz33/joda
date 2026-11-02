import { expect, test, type Page } from "@playwright/test";
import { loginAs, submitPassword } from "../helpers/login";
import { devUser } from "../helpers/roles";

// Sesión de personal con segundo factor obligatorio (docs/security-spec.md §4.1 y §4.3,
// WP-C03/WP-C04): cada rol entra con contraseña (validada por el Auth local) y código
// TOTP, y ve solo lo que sus permisos habilitan (docs/testing-strategy.md §6, nivel 5).
function mainNav(page: Page) {
  return page.getByRole("navigation", { name: "Principal" });
}

test.describe("el personal entra al admin con contraseña y segundo factor (RF-SEG-01, docs/security-spec.md §4.3)", () => {
  test("el dueño entra y ve catálogo, contabilidad y sourcing", async ({ page }) => {
    await loginAs(page, "owner");

    await expect(
      page.getByRole("heading", { name: `Buen día, ${devUser("owner").fullName}` }),
    ).toBeVisible();
    await expect(mainNav(page).getByRole("link", { name: "Catálogo" })).toBeVisible();
    await expect(mainNav(page).getByRole("link", { name: "Contabilidad" })).toBeVisible();
    await expect(mainNav(page).getByRole("link", { name: "Sourcing" })).toBeVisible();
  });

  test("el encargado entra y ve catálogo, contabilidad y sourcing", async ({ page }) => {
    await loginAs(page, "manager");

    await expect(
      page.getByRole("heading", { name: `Buen día, ${devUser("manager").fullName}` }),
    ).toBeVisible();
    await expect(mainNav(page).getByRole("link", { name: "Contabilidad" })).toBeVisible();
    await expect(mainNav(page).getByRole("link", { name: "Sourcing" })).toBeVisible();
  });

  test("el vendedor entra y ve el catálogo, sin contabilidad ni sourcing", async ({ page }) => {
    await loginAs(page, "vendedor");

    await expect(
      page.getByRole("heading", { name: `Buen día, ${devUser("vendedor").fullName}` }),
    ).toBeVisible();
    await expect(mainNav(page).getByRole("link", { name: "Catálogo" })).toBeVisible();
    await expect(mainNav(page).getByRole("link", { name: "Contabilidad" })).toHaveCount(0);
    await expect(mainNav(page).getByRole("link", { name: "Sourcing" })).toHaveCount(0);
  });

  test("el de depósito entra y ve el catálogo, sin contabilidad ni sourcing", async ({ page }) => {
    await loginAs(page, "deposito");

    await expect(
      page.getByRole("heading", { name: `Buen día, ${devUser("deposito").fullName}` }),
    ).toBeVisible();
    await expect(mainNav(page).getByRole("link", { name: "Catálogo" })).toBeVisible();
    await expect(mainNav(page).getByRole("link", { name: "Contabilidad" })).toHaveCount(0);
    await expect(mainNav(page).getByRole("link", { name: "Sourcing" })).toHaveCount(0);
  });
});

test.describe("el ingreso rechaza lo que no es válido (RF-SEG-01, docs/security-spec.md §5.1)", () => {
  test("una contraseña incorrecta muestra el error y no pide el segundo factor", async ({
    page,
  }) => {
    await submitPassword(page, "owner", "esta-no-es-la-contraseña");

    await expect(page.getByRole("alert")).toContainText("Email o contraseña incorrectos.");
    await expect(page.getByRole("heading", { name: "Verificar segundo factor" })).toHaveCount(0);
  });

  test("un código de segundo factor incorrecto no deja pasar", async ({ page }) => {
    await submitPassword(page, "owner");
    await expect(page.getByRole("heading", { name: "Verificar segundo factor" })).toBeVisible();

    await page.getByLabel("Código de 6 dígitos").fill("000000");
    await page.getByRole("button", { name: "Verificar", exact: true }).click();

    await expect(page.getByRole("alert")).toContainText("El código ingresado no es válido.");
    await expect(page.getByRole("button", { name: "Salir", exact: true })).toBeVisible();
    await expect(mainNav(page)).toHaveCount(0);
  });

  test("sin sesión, cualquier ruta del admin lleva al ingreso", async ({ page }) => {
    await page.goto("/contabilidad");

    await expect(page).toHaveURL(/\/ingresar$/);
    await expect(page.getByRole("heading", { name: "Ingresar" })).toBeVisible();
  });
});

test.describe("salir cierra la sesión (docs/security-spec.md §4.1)", () => {
  test("después de salir, la sesión queda cerrada y el admin pide el ingreso", async ({ page }) => {
    await loginAs(page, "owner");

    const logout = page.waitForResponse(
      (response) => response.url().includes("/trpc/auth.session.logout") && response.ok(),
    );
    await page.getByRole("button", { name: "Salir", exact: true }).click();
    await logout;

    // Sin recargar (WP-E04b): el admin muestra el ingreso por sí solo al cerrarse la sesión.
    await expect(page.getByRole("heading", { name: "Ingresar" })).toBeVisible();
    await page.goto("/vista-catalogo");
    await expect(page).toHaveURL(/\/ingresar$/);
  });

  // WP-E04b: «Salir» también está en la pantalla del segundo factor, que no es el encabezado del
  // admin. Antes la cookie se revocaba pero la pantalla quedaba igual hasta recargar.
  test("«Salir» desde «Verificar segundo factor» también vuelve al ingreso", async ({ page }) => {
    await submitPassword(page, "owner");
    await expect(page.getByRole("heading", { name: "Verificar segundo factor" })).toBeVisible();

    const logout = page.waitForResponse(
      (response) => response.url().includes("/trpc/auth.session.logout") && response.ok(),
    );
    await page.getByRole("button", { name: "Salir", exact: true }).click();
    await logout;

    await expect(page.getByRole("heading", { name: "Ingresar" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Verificar segundo factor" })).toHaveCount(0);
  });
});

// WP-M24: `loginAs` tiene que volver con la sesión COMPLETA aunque el servidor tarde en verificar
// el segundo factor (una máquina cargada, el CI). Con el servidor lento, un `loginAs` que diera
// el ingreso por hecho al ver «Salir» —que también está en «Verificar segundo factor»— dejaba que
// el `goto` siguiente tirara la verificación en vuelo y el spec terminara en /verificar-mfa.
test.describe("el ingreso espera a que la sesión esté completa (RF-SEG-01, docs/security-spec.md §4.3)", () => {
  test("con la verificación lenta, navegar justo después de loginAs ya encuentra la sesión", async ({
    page,
  }) => {
    // Retiene el pedido de verificación 1,5 s antes de dejarlo salir: determinista, y mucho
    // más lento que cualquier máquina cargada.
    let retenido = false;
    await page.route("**/trpc/auth.mfa.verify*", async (route) => {
      retenido = true;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });

    await loginAs(page, "owner");
    await page.goto("/vista-catalogo");

    await expect(page.getByRole("heading", { name: "Productos" })).toBeVisible();
    await expect(page).toHaveURL(/\/vista-catalogo$/);
    // Si el patrón del `route` dejara de coincidir, la guarda no probaría nada y pasaría igual.
    expect(retenido).toBe(true);
  });
});
