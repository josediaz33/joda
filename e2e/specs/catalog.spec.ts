import { expect, test } from "@playwright/test";
import { archiveSmokeProducts, findProductRow, SMOKE_PRODUCT_PREFIX } from "../helpers/catalog";
import { loginAs } from "../helpers/login";

// Módulo catálogo del admin (RF-CAT-01…09, WP-E05), contra los datos de muestra de
// scripts/dev/lib/sampleData.mjs. Este archivo es el modelo para los demás módulos: un
// `describe` por flujo, `loginAs` para entrar y datos que el spec crea con nombres únicos
// para poder correrse más de una vez sin pisar nada.
//
// Dos reglas para que el humo no envejezca (la lista va de lo más nuevo a lo más viejo, 20
// por página, y la API no borra productos):
//   - un producto sembrado se busca POR NOMBRE con `findProductRow`, que pagina hasta
//     encontrarlo; nunca "lo que haya en la primera pantalla";
//   - lo que un spec crea se archiva al terminar (`archiveSmokeProducts`).
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
      await expect(await findProductRow(page, name)).toBeVisible();
    }
  });

  test("Layton figura activo y publicado; Aventus, activo sin publicar", async ({ page }) => {
    await loginAs(page, "owner");
    await page.goto("/vista-catalogo");

    const layton = await findProductRow(page, "Layton — Parfums de Marly");
    await expect(layton).toContainText("Estado interno: Activo");
    await expect(layton).toContainText("Publicación: Publicado");

    const aventus = await findProductRow(page, "Aventus — Creed");
    await expect(aventus).toContainText("Estado interno: Activo");
    await expect(aventus).toContainText("Publicación: No publicado");
  });

  test("el reloj serializado y los perfumes traen sus variantes", async ({ page }) => {
    await loginAs(page, "owner");
    await page.goto("/vista-catalogo");

    await expect(await findProductRow(page, "Casio F-91W")).toContainText("CASIO-F91W");
    const layton = await findProductRow(page, "Layton — Parfums de Marly");
    await expect(layton).toContainText("LAYTON-125");
    await expect(layton).toContainText("LAYTON-DECANT-10");
  });
});

test.describe("el dueño crea un producto desde el admin (RF-CAT-01, WP-E05)", () => {
  // El humo no deja productos: se archivan los que creó (y los de una corrida cortada).
  test.afterAll(async () => {
    await archiveSmokeProducts();
  });

  test("un accesorio nuevo queda en la lista como borrador", async ({ page }) => {
    const suffix = Date.now().toString(36);
    const name = `${SMOKE_PRODUCT_PREFIX}${suffix}`;
    await loginAs(page, "owner");
    await page.goto("/vista-catalogo");

    await page.getByRole("button", { name: "Nuevo accesorio" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^Nombre/).fill(name);
    await dialog.getByLabel(/^Slug/).fill(`estuche-de-humo-${suffix}`);
    await dialog.getByRole("checkbox", { name: "perfumes", exact: true }).check();
    await dialog.getByRole("button", { name: "Crear producto" }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    const row = await findProductRow(page, name);
    await expect(row).toContainText("Estado interno: Borrador");
  });
});

// RF-SEG-02: los permisos por rol (docs/especificacion-software.md). Que un botón no
// aparezca es la mitad visible de eso; la API lo vuelve a comprobar (permissions.spec.ts).
test.describe("quien no puede escribir en el catálogo no ve cómo hacerlo (RF-SEG-02, WP-C05)", () => {
  test("el de depósito ve la lista pero no los botones de alta", async ({ page }) => {
    await loginAs(page, "deposito");
    await page.goto("/vista-catalogo");

    await expect(page.getByRole("heading", { name: "Productos" })).toBeVisible();
    await expect(await findProductRow(page, "Layton — Parfums de Marly")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Nuevo / })).toHaveCount(0);
  });
});
