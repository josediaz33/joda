import { z } from "zod";

// docs/security-spec.md §3.1: apps/api nunca se conecta con una credencial
// elevada. DATABASE_URL_API es la única variable que este proceso lee para
// conectarse a Postgres — sin fallback a DATABASE_URL (esa queda reservada
// a migraciones/ETL, ver .env.example). Si falta, el proceso no arranca:
// fallar acá es preferible a arrancar corriendo como superusuario sin que
// nadie lo note.
const envSchema = z.object({
  DATABASE_URL_API: z
    .string()
    .min(
      1,
      "DATABASE_URL_API es obligatoria (docs/security-spec.md §3.1). apps/api nunca usa " +
        "DATABASE_URL (reservada a migraciones/ETL) ni arranca sin una credencial explícita de joda_api.",
    ),
  PORT: z.coerce.number().int().positive().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // El mensaje de Zod por un campo AUSENTE ("expected string, received
    // undefined") no menciona el nombre del campo — a diferencia del que
    // dispara `.min(1, ...)` sobre un campo presente pero vacío. Anteponer
    // `issue.path` cubre ambos casos sin depender de cuál mensaje generó Zod.
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join(" ");
    throw new Error(`Configuración de entorno inválida: ${details}`);
  }
  return result.data;
}
