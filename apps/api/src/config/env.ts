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
  // WP-C03 (docs/security-spec.md §4): la sesión de personal necesita las
  // tres — sin alguna, el proceso arranca "andando" pero con el login roto
  // recién en el primer request, que es peor que no arrancar. Mismo criterio
  // de "fallar acá es preferible" que ya usa DATABASE_URL_API arriba.
  REDIS_URL: z
    .string()
    .min(
      1,
      "REDIS_URL es obligatoria: ahí vive el caché de sesión de 15 min (docs/security-spec.md §4.2).",
    ),
  SESSION_SECRET: z
    .string()
    .min(
      32,
      "SESSION_SECRET es obligatoria y necesita al menos 32 caracteres: firma la cookie " +
        "__Host-joda_a (docs/security-spec.md §4.1).",
    ),
  SUPABASE_URL: z
    .string()
    .min(
      1,
      "SUPABASE_URL es obligatoria: WP-C03 verifica la contraseña de personal contra Supabase Auth (ADR-004).",
    ),
  SUPABASE_ANON_KEY: z
    .string()
    .min(1, "SUPABASE_ANON_KEY es obligatoria junto con SUPABASE_URL (ADR-004)."),
  // WP-C04 (docs/security-spec.md §4.3/§6): cifra el secreto TOTP de
  // personal en reposo (adapters/mfaSecretCipher.ts, AES-256-GCM) — a
  // diferencia del token de refresco (hash de un solo sentido), este
  // secreto hay que poder recuperarlo para calcular el código vigente, así
  // que no alcanza con un hash. 64 caracteres hex = 32 bytes = una clave de
  // AES-256 exacta. Generar una de desarrollo con `openssl rand -hex 32`.
  MFA_ENCRYPTION_KEY: z
    .string()
    .regex(
      /^[0-9a-f]{64}$/i,
      "MFA_ENCRYPTION_KEY es obligatoria: 64 caracteres hexadecimales (32 bytes, AES-256-GCM) " +
        "para cifrar el secreto TOTP de personal (docs/security-spec.md §4.3).",
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
