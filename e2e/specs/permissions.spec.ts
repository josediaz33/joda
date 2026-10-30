import { expect, test } from "@playwright/test";
import { apiAs, statusOfQuery } from "../helpers/api";
import { loginAs } from "../helpers/login";

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
    const owner = await apiAs("owner");
    const serials = await owner.query("inventory.serial.list", { limit: 1 });
    const lotId: string = serials.items[0].lotId;
    const vendedor = await apiAs("vendedor");

    const statuses = [
      await statusOfQuery(vendedor, "market.supplier.list", { limit: 1 }),
      await statusOfQuery(vendedor, "market.purchaseOrder.list", { limit: 1 }),
      await statusOfQuery(vendedor, "inventory.lot.history", { lotId }),
      await statusOfQuery(vendedor, "inventory.serial.list", { limit: 1 }),
    ];

    expect(statuses).toEqual([404, 404, 404, 404]);
  });

  test("el dueño, en cambio, sí recibe el costo puesto del lote", async () => {
    const owner = await apiAs("owner");
    const serials = await owner.query("inventory.serial.list", { limit: 1 });

    const history = await owner.query("inventory.lot.history", { lotId: serials.items[0].lotId });

    expect(history.lot.unitLandedCostPyg).toBe("105000");
  });

  test("el de depósito tampoco ve proveedores ni órdenes de compra", async () => {
    const deposito = await apiAs("deposito");

    const statuses = [
      await statusOfQuery(deposito, "market.supplier.list", { limit: 1 }),
      await statusOfQuery(deposito, "market.purchaseOrder.list", { limit: 1 }),
    ];

    expect(statuses).toEqual([404, 404]);
  });
});
