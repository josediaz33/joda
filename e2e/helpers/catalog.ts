import { expect, type Locator, type Page } from "@playwright/test";
import { apiAs } from "./api";

/**
 * Los productos que crean los specs del humo llevan este prefijo en el nombre. Es lo que
 * `archiveSmokeProducts` busca para dejar el catálogo como estaba: no hay forma de BORRAR
 * un producto por la API, pero sí de archivarlo.
 */
export const SMOKE_PRODUCT_PREFIX = "Estuche de humo ";

/** Tope de páginas que `findProductRow` recorre antes de rendirse (20 productos por página). */
const MAX_PAGES = 100;

const PRODUCT_LIST_PROCEDURE = "/trpc/catalog.product.list";

/** Hace clic en un botón de paginación y espera a que la lista de la página nueva esté en pantalla. */
async function clickAndWaitForList(page: Page, button: Locator): Promise<void> {
  const loaded = page.waitForResponse(
    (response) => response.url().includes(PRODUCT_LIST_PROCEDURE) && response.ok(),
  );
  await button.click();
  await loaded;
  await expect(page.getByText("Cargando productos…")).toHaveCount(0);
}

/** Vuelve a la primera página de la lista (no hace nada si ya está ahí). */
async function toFirstPage(page: Page): Promise<void> {
  const previous = page.getByRole("button", { name: "Anterior", exact: true });
  while (await previous.isVisible()) {
    await clickAndWaitForList(page, previous);
  }
}

/**
 * La fila de un producto en la lista de `/vista-catalogo`, buscándolo en TODAS las páginas.
 *
 * La lista va de lo más nuevo a lo más viejo y muestra 20 por página, así que un producto
 * sembrado se corre de página a medida que alguien crea otros (cada corrida del humo, otros
 * specs, el uso normal de la base de desarrollo). Un spec que lo busca "en la primera
 * pantalla" se rompe sin que nada haya cambiado en el producto. Esta función pagina hasta
 * encontrarlo, y falla con un mensaje claro si no existe.
 *
 * Quien la llama tiene que estar ya en la pantalla de productos.
 */
export async function findProductRow(page: Page, name: string): Promise<Locator> {
  const rows = page.getByTestId("product-row");
  const row = rows.filter({ has: page.getByText(name, { exact: true }) });
  const next = page.getByRole("button", { name: "Siguiente", exact: true });

  await toFirstPage(page);
  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
    await expect(page.getByText("Cargando productos…")).toHaveCount(0);
    await expect(rows.first()).toBeVisible();
    if ((await row.count()) > 0) return row.first();
    if (!(await next.isVisible())) {
      throw new Error(`«${name}» no está en el catálogo (se miraron ${pageNumber} páginas).`);
    }
    await clickAndWaitForList(page, next);
  }
  throw new Error(`«${name}» no apareció en las primeras ${MAX_PAGES} páginas del catálogo.`);
}

/**
 * Archiva los productos que dejó el humo (los de nombre `SMOKE_PRODUCT_PREFIX…`) por la API.
 * Es idempotente y barre también lo que dejó una corrida cortada a la mitad, así que se llama
 * al terminar cada spec que crea productos.
 */
export async function archiveSmokeProducts(): Promise<number> {
  const owner = await apiAs("owner");
  let archived = 0;
  let cursor: string | undefined;
  do {
    const found: {
      items: Array<{ id: string; name: string }>;
      nextCursor: string | null;
    } = await owner.query("catalog.product.list", {
      kind: "accessory",
      status: "draft",
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const product of found.items) {
      if (!product.name.startsWith(SMOKE_PRODUCT_PREFIX)) continue;
      await owner.mutation("catalog.product.archive", { id: product.id });
      archived++;
    }
    cursor = found.nextCursor ?? undefined;
  } while (cursor);
  return archived;
}
