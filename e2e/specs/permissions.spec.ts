import { expect, test } from "@playwright/test";
import { apiAs, statusOfQuery } from "../helpers/api";
import { loginAs } from "../helpers/login";

/** El lote del reloj serializado de muestra y su variante: de ahí cuelgan las consultas de costo. */
async function casioLot() {
  const owner = await apiAs("owner");
  const watches = await owner.query("catalog.product.list", { kind: "watch", limit: 1 });
  const variantId: string = watches.items[0].variants[0].id;
  const serials = await owner.query("inventory.serial.list", { variantId, limit: 1 });
  return { variantId, lotId: serials.items[0].lotId as string };
}

// docs/testing-strategy.md §6, flujo 5: «un usuario `vendedor` no puede acceder a
// contabilidad ni por URL directa», y los costos (lo que pagó JODA por la mercadería, el
// proveedor) no salen de la API para quien no tiene el permiso: un procedimiento no
// autorizado responde 404, no 403 (docs/api-conventions.md §4, .claude/rules/api.md).
test.describe("el vendedor no ve costos ni proveedores (docs/security-spec.md §3, RF-SEG-03)", () => {
  test("por URL directa, contabilidad y sourcing lo devuelven al inicio", async ({ page }) => {
    await loginAs(page, "vendedor");

    await page.goto("/contabilidad");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: /^Buen día/ })).toBeVisible();

    await page.goto("/sourcing");
    await expect(page).toHaveURL(/\/$/);
  });

  test("la API le responde 404 en proveedores, órdenes de compra y costo de lotes", async () => {
    const { variantId, lotId } = await casioLot();
    const vendedor = await apiAs("vendedor");

    const statuses = [
      await statusOfQuery(vendedor, "market.supplier.list", { limit: 1 }),
      await statusOfQuery(vendedor, "market.purchaseOrder.list", { limit: 1 }),
      await statusOfQuery(vendedor, "inventory.lot.history", { lotId }),
      await statusOfQuery(vendedor, "inventory.serial.list", { variantId, limit: 1 }),
    ];

    expect(statuses).toEqual([404, 404, 404, 404]);
  });

  test("el dueño, en cambio, sí recibe el costo puesto del lote", async () => {
    const { lotId } = await casioLot();
    const owner = await apiAs("owner");

    const history = await owner.query("inventory.lot.history", { lotId });

    expect(history.lot.unitLandedCostPyg).toBe("105000");
  });

  // docs/api-conventions.md §4.3 (WP-C05): quien tiene algún permiso del MISMO módulo ya sabe
  // que existe, y recibe 403; sin ninguno, 404. Depósito recibe mercadería
  // (`market.purchase_order:receive`), así que en órdenes de compra recibe 403, no 404.
  test("el de depósito no ve proveedores (404) ni lee órdenes de compra (403)", async () => {
    const deposito = await apiAs("deposito");

    const statuses = [
      await statusOfQuery(deposito, "market.supplier.list", { limit: 1 }),
      await statusOfQuery(deposito, "market.purchaseOrder.list", { limit: 1 }),
    ];

    expect(statuses).toEqual([404, 403]);
  });
});
