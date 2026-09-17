import pg from "pg";

/**
 * Todos los scripts de este paquete se conectan con la misma variable de
 * entorno que documenta .env.example y packages/db/prisma/schema.prisma:
 * DATABASE_URL. No hay un default local — apuntar a la base equivocada por
 * un valor supuesto es peor que fallar explícitamente.
 */
export function requireDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL no está definida. Ver .env.example — packages/db necesita" +
        " una cadena postgresql://usuario:clave@host:puerto/base.",
    );
  }
  return url;
}

/**
 * Abre una única conexión, la pasa a `fn` y la cierra al terminar (incluso
 * si `fn` lanza). Una sola conexión por corrida: los scripts de este
 * paquete dependen de que el `search_path` y las tablas temporales que fija
 * un archivo SQL sigan visibles para las consultas que corren después, en
 * la misma sesión.
 */
export async function withClient(fn) {
  const client = new pg.Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
