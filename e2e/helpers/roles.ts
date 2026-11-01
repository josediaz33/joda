import { DEV_USERS } from "../../scripts/dev/lib/devUsers.mjs";

/** Los cuatro roles del seed (packages/db/seed/0001_seed_base.sql): owner, manager, vendedor, deposito. */
export type DevRole = "owner" | "manager" | "vendedor" | "deposito";

export interface DevUser {
  readonly role: DevRole;
  readonly email: string;
  readonly password: string;
  readonly fullName: string;
}

export function devUser(role: DevRole): DevUser {
  const user = DEV_USERS.find((candidate) => candidate.role === role);
  if (!user) throw new Error(`Rol de prueba desconocido: ${role}`);
  return user;
}
