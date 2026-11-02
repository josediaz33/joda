import { expect, type Page } from "@playwright/test";
import { readTotpSecrets, totpCode } from "../../scripts/dev/lib/totp.mjs";
import { devUser, type DevRole } from "./roles";

// ───────────────────────────────────────────────────────────────────────────────────────────
// REGLAS DE ORO PARA ESCRIBIR SPECS ESTABLES (WP-M24). Léelas antes de sumar un spec.
//
// 1. Entrá siempre con `loginAs`, y no hagas NADA que dependa de la sesión hasta que vuelva.
//    Vuelve cuando la sesión está COMPLETA: el servidor ya respondió la verificación del
//    segundo factor y el admin ya dibujó la navegación «Principal», que solo existe con la
//    sesión satisfecha. No lo reemplaces por «veo el botón Salir»: la pantalla «Verificar
//    segundo factor» también lo tiene, y un `page.goto` en ese instante tira la verificación
//    que sigue en vuelo; el admin vuelve a leer la sesión, todavía pendiente, y el spec
//    termina en `/verificar-mfa` (la causa de WP-M24).
// 2. Para afirmar algo de una pantalla, esperá una aserción de Playwright (`expect(...)`
//    reintenta sola) sobre lo que ESA pantalla dibuja. Nada de `waitForTimeout` ni de leer
//    el DOM una vez (`isVisible()`, `count()`) para decidir qué hacer a continuación: eso
//    mira un instante y no espera.
// 3. Después de una acción que dispara pedidos (guardar, paginar, salir), esperá su respuesta
//    (`page.waitForResponse` armado ANTES del clic) o el cambio visible que produce, antes de
//    navegar o de recargar. Un `goto` o un `reload` aborta lo que esté en vuelo.
// 4. Los productos sembrados se buscan POR NOMBRE con `findProductRow` (e2e/helpers/catalog.ts),
//    nunca «la primera fila»; lo que un spec crea lleva un nombre único con un prefijo conocido
//    y se archiva al terminar. Así el spec se puede correr cualquier cantidad de veces.
// 5. Los datos y los permisos que no son el objeto del spec se preparan por la API (`apiAs`,
//    e2e/helpers/api.ts), no por la pantalla: es más rápido y hay menos que pueda fallar.
// 6. `retries` sigue en 0 a propósito. Un spec que falla "a veces" tiene una causa: encontrala
//    (`--repeat-each`, `--trace on`, y `page.route` para retrasar una respuesta y volver
//    determinista la carrera) en vez de reintentar.
// ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * El código de 6 dígitos vigente del segundo factor de un usuario de prueba (el mismo que da `pnpm dev:totp`).
 *
 * Sobre la ventana de 30 s (WP-M24, medido contra la API): la API acepta el código del paso
 * anterior, el actual y el siguiente (±30 s), y rechaza los de dos pasos de distancia. Este
 * helper calcula el código justo antes de usarlo, así que aunque caiga en el borde de un paso
 * le quedan al menos 30 s de margen: no hace falta esperar al paso siguiente.
 *
 * SUPUESTO DEL HUMO: varios ingresos seguidos del mismo rol (un `loginAs` por spec, más los
 * `apiAs` de los helpers) usan el MISMO código dentro de su ventana de 30 s. Anda porque la
 * API hoy acepta un código ya usado en la misma ventana (no hay anti-replay). Si la API llega
 * a rechazarlo (un código de un solo uso), este helper tiene que esperar a la ventana
 * siguiente antes de devolver un código ya consumido, y el humo se vuelve más lento.
 */
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
 *
 * Al volver, la sesión está COMPLETA en el servidor y en pantalla (ver la regla 1 de arriba):
 * se esperó la respuesta de `auth.mfa.verify` y la navegación «Principal», que el admin solo
 * dibuja con el segundo factor satisfecho. Es seguro navegar (`page.goto`) a continuación.
 */
export async function loginAs(page: Page, role: DevRole): Promise<void> {
  await submitPassword(page, role);
  await expect(page.getByRole("heading", { name: "Verificar segundo factor" })).toBeVisible();
  await page.getByLabel("Código de 6 dígitos").fill(currentTotp(role));

  // Armado ANTES del clic: la respuesta puede llegar antes de que `click` vuelva.
  const verification = page.waitForResponse(
    (response) =>
      response.url().includes("/trpc/auth.mfa.verify") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Verificar", exact: true }).click();
  const response = await verification;
  expect(response.ok(), `auth.mfa.verify respondió HTTP ${response.status()}`).toBe(true);

  // La señal de «ingreso completado» es la navegación «Principal», no el botón «Salir»:
  // este también está en la pantalla «Verificar segundo factor».
  await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible();
}
