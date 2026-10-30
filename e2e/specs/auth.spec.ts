import { expect, test, type Page } from "@playwright/test";
import { loginAs, submitPassword } from "../helpers/login";
import { devUser } from "../helpers/roles";

// Sesión de personal con segundo factor obligatorio (docs/security-spec.md §4.1 y §4.3,
// WP-C03/WP-C04): cada rol entra con contraseña (validada por el Auth local) y código
// TOTP, y ve solo lo que sus permisos habilitan (docs/testing-strategy.md §6, nivel 5).
function mainNav(page: Page) {
  return page.getByRole("navigation", { name: "Principal" });
}

test.describe("el personal entra al admin con contraseña y segundo factor (docs/security-spec.md §4.3)", () => {
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

test.describe("el ingreso rechaza lo que no es válido (docs/security-spec.md §5.1)", () => {
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

    // WP-E04b: tras «Salir» el admin a veces sigue mostrando la sesión vieja hasta que algo
    // vuelve a leerla (`useLogout` vacía la caché y revalida en la misma tanda). Por eso se
    // espera la respuesta del cierre y se recarga: lo que importa acá es que la sesión de
    // verdad se cerró. Cuando se corrija E04b, este spec afirma el ingreso sin recargar.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Ingresar" })).toBeVisible();
    await page.goto("/vista-catalogo");
    await expect(page).toHaveURL(/\/ingresar$/);
  });
});
