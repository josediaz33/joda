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
  // WP-M18: interfaz en la que escuchan la API y el servidor de medios. Sin valor,
  // 0.0.0.0 (despliegue en contenedor, donde el proceso tiene que ser alcanzable
  // desde fuera). El entorno local la fija en 127.0.0.1: el admin de desarrollo, con
  // usuarios de prueba, no tiene por qué ser alcanzable desde la red.
  HOST: z.string().min(1).optional(),
  // WP-C09 (docs/security-spec.md §5, fila "Carga de archivos": "servidos
  // desde dominio distinto al del admin"). `APP_URL` es el origen público
  // de ESTE proceso — el que emite la cookie de sesión `__Host-joda_a`
  // (modules/auth/cookie.ts): sin `Domain` explícito, esa cookie es
  // host-only y un navegador jamás la manda a otro nombre de host, ni
  // siquiera a un puerto distinto del mismo host (por diseño: RFC 6265, las
  // cookies no se aíslan por puerto). Por eso la comparación de abajo es
  // por HOSTNAME, no por origen completo.
  APP_URL: z
    .string()
    .url(
      "APP_URL es obligatoria: es el origen donde este proceso emite la cookie de sesión de " +
        "personal (docs/security-spec.md §4.1), y MEDIA_PUBLIC_BASE_URL se valida contra su host.",
    ),
  MEDIA_STORAGE_DIR: z
    .string()
    .min(
      1,
      "MEDIA_STORAGE_DIR es obligatoria: raíz en disco del adaptador ObjectStorage de " +
        "desarrollo (packages/domain/src/ports/storage.ts, WP-C09).",
    ),
  MEDIA_PUBLIC_BASE_URL: z
    .string()
    .url(
      "MEDIA_PUBLIC_BASE_URL es obligatoria: origen público desde el que se sirven los " +
        "derivados de catálogo (docs/security-spec.md §5).",
    ),
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

  // No expresable como `.superRefine` sobre el propio schema: `z.string().url()`
  // ya garantiza que ambos parsean como URL antes de que `new URL(...)` corra
  // acá sin riesgo de tirar por un valor mal formado.
  const appHost = new URL(result.data.APP_URL).hostname;
  const mediaHost = new URL(result.data.MEDIA_PUBLIC_BASE_URL).hostname;
  if (appHost === mediaHost) {
    throw new Error(
      "Configuración de entorno inválida: MEDIA_PUBLIC_BASE_URL tiene que resolver a un host " +
        `distinto de APP_URL (ambos resuelven a "${appHost}") — docs/security-spec.md §5: servir ` +
        "medios desde el mismo host que el admin anula el aislamiento de la cookie de sesión, " +
        "aunque el puerto sea distinto.",
    );
  }

  return result.data;
}
