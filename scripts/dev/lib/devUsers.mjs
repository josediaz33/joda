// Usuarios de prueba del entorno LOCAL (WP-M18): uno por rol del seed
// (packages/db/seed/0001_seed_base.sql, `seed_roles`). Las contraseñas están
// escritas acá y en docs/runbooks/entorno-local.md A PROPÓSITO, para que cualquiera
// pueda entrar al admin local: valen solo contra el Auth local (127.0.0.1) y
// `assertDevelopmentEnvironment` (guards.mjs) impide sembrarlas en producción
// o fuera de esta máquina. Nunca se reutilizan en un entorno real.
//
// El segundo factor NO está acá: el secreto TOTP de cada usuario es al azar por
// máquina (lo genera la API al inscribirlo, scripts/dev/lib/totp.mjs).

/**
 * @typedef {{ role: "owner" | "manager" | "vendedor" | "deposito"; email: string; password: string; fullName: string }} DevUser
 */

/** @type {readonly DevUser[]} */
export const DEV_USERS = Object.freeze([
  {
    role: "owner",
    email: "owner@joda.test",
    password: "JodaDev-owner-2026",
    fullName: "Dueño (desarrollo)",
  },
  {
    role: "manager",
    email: "manager@joda.test",
    password: "JodaDev-manager-2026",
    fullName: "Encargado (desarrollo)",
  },
  {
    role: "vendedor",
    email: "vendedor@joda.test",
    password: "JodaDev-vendedor-2026",
    fullName: "Vendedor (desarrollo)",
  },
  {
    role: "deposito",
    email: "deposito@joda.test",
    password: "JodaDev-deposito-2026",
    fullName: "Depósito (desarrollo)",
  },
]);

export const DEV_ROLES = Object.freeze(DEV_USERS.map((user) => user.role));

/**
 * @param {string} role
 * @returns {DevUser}
 */
export function devUserFor(role) {
  const user = DEV_USERS.find((candidate) => candidate.role === role);
  if (!user) {
    throw new Error(
      `Rol desconocido: "${role}". Los roles de prueba son: ${DEV_ROLES.join(", ")}.`,
    );
  }
  return user;
}

export const DEV_TENANT = Object.freeze({
  slug: "joda",
  legalName: "JODA Parfums (desarrollo)",
  tradeName: "JODA Parfums",
});
