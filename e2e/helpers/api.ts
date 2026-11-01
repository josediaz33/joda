import { createTrpcClient, signInWithMfa } from "../../scripts/dev/lib/trpcClient.mjs";
import { readE2eEnv } from "./env";
import { devUser, type DevRole } from "./roles";

/**
 * Un cliente de la API con la sesión de `role` ya completa (contraseña + segundo factor),
 * para preparar datos o comprobar permisos sin pasar por la pantalla. Es el mismo cliente
 * que usa el seed de datos de muestra.
 *
 *   const owner = await apiAs("owner");
 *   const { items } = await owner.query("catalog.product.list", { limit: 10 });
 */
export async function apiAs(role: DevRole) {
  const client = createTrpcClient(readE2eEnv().apiUrl);
  await signInWithMfa(client, devUser(role));
  return client;
}

/** El estado HTTP de un procedimiento que la API rechazó, o `null` si respondió bien. */
export async function statusOfQuery(
  client: Awaited<ReturnType<typeof apiAs>>,
  path: string,
  input?: unknown,
): Promise<number | null> {
  try {
    await client.query(path, input);
    return null;
  } catch (error) {
    if (error instanceof Error && "status" in error && typeof error.status === "number") {
      return error.status;
    }
    throw error;
  }
}
