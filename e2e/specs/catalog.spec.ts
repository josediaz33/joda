import { expect, test } from "@playwright/test";
import { loginAs } from "../helpers/login";

// Módulo catálogo del admin (RF-CAT-01…09, WP-E05), contra los datos de muestra de
// scripts/dev/lib/sampleData.mjs. Este archivo es el modelo para los demás módulos: un
// `describe` por flujo, `loginAs` para entrar y datos que el spec crea con nombres únicos
// para poder correrse más de una vez sin pisar nada.
test.describe("el dueño navega el catálogo sembrado (RF-CAT-01, WP-E05)", () => {
  test("la lista muestra los productos de muestra con su estado", async ({ page }) => {
    await loginAs(page, "owner");

    await page
      .getByRole("navigation", { name: "Principal" })
      .getByRole("link", { name: "Catálogo" })
      .click();

    await expect(page.getByRole("heading", { name: "Productos" })).toBeVisible();
    for (const name of [
      "Layton — Parfums de Marly",
      "Aventus — Creed",
      "Baccarat Rouge 540 — Maison Francis Kurkdjian",
      "Casio F-91W",
    ]) {
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }
  });

  test("Layton figura activo y publicado; Aventus, activo sin publicar", async ({ page }) => {
    await loginAs(page, "owner");
    await page.goto("/vista-catalogo");

    const layton = page
      .locator("div", { has: page.getByText("Layton — Parfums de Marly", { exact: true }) })
      .last();
    const aventus = page
      .locator("div", { has: page.getByText("Aventus — Creed", { exact: true }) })
      .last();

    await expect(layton).toContainText("Estado interno: Activo");
    await expect(layton).toContainText("Publicación: Publicado");
    await expect(aventus).toContainText("Estado interno: Activo");
    await expect(aventus).toContainText("Publicación: No publicado");
  });

  test("el reloj serializado y los perfumes traen sus variantes", async ({ page }) => {
    await loginAs(page, "owner");
    await page.goto("/vista-catalogo");

    await expect(page.getByText("CASIO-F91W", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("LAYTON-125", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("LAYTON-DECANT-10", { exact: false }).first()).toBeVisible();
  });
});

test.describe("el dueño crea un producto desde el admin (RF-CAT-01, WP-E05)", () => {
  test("un accesorio nuevo queda en la lista como borrador", async ({ page }) => {
    const suffix = Date.now().toString(36);
    const name = `Estuche de humo ${suffix}`;
    await loginAs(page, "owner");
    await page.goto("/vista-catalogo");

    await page.getByRole("button", { name: "Nuevo accesorio" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^Nombre/).fill(name);
    await dialog.getByLabel(/^Slug/).fill(`estuche-de-humo-${suffix}`);
    await dialog.getByRole("checkbox", { name: "perfumes", exact: true }).check();
    await dialog.getByRole("button", { name: "Crear producto" }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    const row = page.locator("div", { has: page.getByText(name, { exact: true }) }).last();
    await expect(row).toContainText("Estado interno: Borrador");
  });
});

test.describe("quien no puede escribir en el catálogo no ve cómo hacerlo (RF-SEG-03, WP-C05)", () => {
  test("el de depósito ve la lista pero no los botones de alta", async ({ page }) => {
    await loginAs(page, "deposito");
    await page.goto("/vista-catalogo");

    await expect(page.getByRole("heading", { name: "Productos" })).toBeVisible();
    await expect(page.getByText("Layton — Parfums de Marly", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Nuevo / })).toHaveCount(0);
  });
});
