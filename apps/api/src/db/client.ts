import { createPrismaClient, type PrismaClient } from "@joda/db";

export { createPrismaClient };

// docs/security-spec.md §3.1: si DATABASE_URL_API terminara apuntando al
// owner de las tablas o a un superusuario por un error de configuración,
// RLS dejaría de evaluarse — en silencio, porque la conexión igual
// funciona. Esta verificación corre una sola vez, al arrancar, y aborta el
// proceso si la credencial conectada puede eludir RLS: barato de correr y
// es la red que atrapa exactamente ese error.
export async function assertRlsNotBypassed(db: PrismaClient): Promise<void> {
  const rows = await db.$queryRaw<{ rolbypassrls: boolean }[]>`
    SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`;
  const bypassesRls = rows[0]?.rolbypassrls ?? false;

  if (bypassesRls) {
    throw new Error(
      "DATABASE_URL_API se conecta con un rol BYPASSRLS. apps/api no puede arrancar así " +
        "(docs/security-spec.md §3.1): verificá que apunte a joda_api, no al owner de las " +
        "tablas ni a un superusuario.",
    );
  }
}
