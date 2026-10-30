#!/usr/bin/env node
// `pnpm dev:totp <rol>` (WP-M18): el código de 6 dígitos vigente del segundo
// factor de un usuario de prueba. Sin argumento, el de los cuatro roles.
// El secreto de cada uno está en `.data/dev/totp-secrets.json`, que genera
// `pnpm dev:setup` (al azar por máquina, ignorado por git).
import { DEV_ROLES } from "./lib/devUsers.mjs";
import { assertDevelopmentEnvironment } from "./lib/guards.mjs";
import { readTotpSecrets, secondsLeft, totpCode } from "./lib/totp.mjs";

function main() {
  assertDevelopmentEnvironment({ env: process.env });

  const requested = process.argv[2];
  const roles = requested ? [requested] : DEV_ROLES;
  if (requested && !DEV_ROLES.includes(requested)) {
    throw new Error(`Rol desconocido: "${requested}". Los roles son: ${DEV_ROLES.join(", ")}.`);
  }

  const secrets = readTotpSecrets();
  const now = Date.now();
  for (const role of roles) {
    const secret = secrets[role];
    if (!secret) {
      throw new Error(
        `No hay un secreto TOTP guardado para "${role}". Corré \`pnpm dev:setup\`: crea los usuarios y inscribe el segundo factor de cada uno.`,
      );
    }
    console.log(
      requested
        ? `${totpCode(secret, now)}   (vence en ${secondsLeft(now)} s)`
        : `${role.padEnd(9)} ${totpCode(secret, now)}   (vence en ${secondsLeft(now)} s)`,
    );
  }
}

try {
  main();
} catch (error) {
  console.error(`[dev:totp] ${error.message}`);
  process.exit(1);
}
