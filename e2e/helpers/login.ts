import { expect, type Page } from "@playwright/test";
import { readTotpSecrets, totpCode } from "../../scripts/dev/lib/totp.mjs";
import { devUser, type DevRole } from "./roles";

/** El código de 6 dígitos vigente del segundo factor de un usuario de prueba (el mismo que da `pnpm dev:totp`). */
export function currentTotp(role: DevRole): string {
  const secret = readTotpSecrets()[role];
  if (!secret) {
    throw new Error(
      `No hay un secreto TOTP guardado para "${role}": corré \`pnpm dev:setup\` (lo inscribe por la API).`,
    );
  }
  return totpCode(secret, Date.now());
}

/** Contraseña en la pantalla de ingreso, sin tocar el segundo factor. */
export async function submitPassword(page: Page, role: DevRole, password?: string): Promise<void> {
  const user = devUser(role);
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password ?? user.password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
}

/**
 * Entra al admin como `role`, de punta a punta: contraseña y, como el segundo factor es
 * obligatorio para todo el personal (docs/security-spec.md §4.3, WP-C04), el código TOTP.
 * Al volver, la sesión está completa y se ve el encabezado con «Salir».
 */
export async function loginAs(page: Page, role: DevRole): Promise<void> {
  await submitPassword(page, role);
  await expect(page.getByRole("heading", { name: "Verificar segundo factor" })).toBeVisible();
  await page.getByLabel("Código de 6 dígitos").fill(currentTotp(role));
  await page.getByRole("button", { name: "Verificar", exact: true }).click();
  await expect(page.getByRole("button", { name: "Salir", exact: true })).toBeVisible();
}
