// Adaptador de desarrollo de ObjectStorage (packages/domain/src/ports/storage.ts,
// WP-C09). Escribe en disco bajo MEDIA_STORAGE_DIR — el destino real de
// producción es Supabase Storage (decisión posterior a la que originalmente
// apuntaba a Cloudflare R2; se formaliza en un ADR aparte, fuera de esta
// rama). Ningún WP construyó todavía ese adaptador, así que
// assertLocalDiskStorageAllowedInProduction() más abajo es lo que impide que
// este, el único que existe hoy, termine sirviendo en producción por default
// silencioso — mismo criterio que assertRlsNotBypassed (apps/api/src/db/client.ts,
// WP-C02).
import { createHmac } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { ObjectStorage } from "@joda/domain";

export interface LocalDiskStorageOptions {
  readonly rootDir: string;
  /** Origen público desde el que se terminan sirviendo las keys — mediaServer.ts, WP-C09. */
  readonly publicBaseUrl: string;
  /** Firma las URL de `signedUrl` — hoy sin verificador consumiéndolas (ninguna ruta de este WP sirve contenido privado todavía); existe para que el método cumpla el contrato real, no una versión a medias. */
  readonly signingSecret: string;
}

/**
 * `key` siempre sale de packages/domain/src/catalog/media.ts
 * (`buildMediaOriginalKey`/`buildMediaDerivativeKey`, validadas contra un
 * sha256 de 64 hex), nunca de un campo que el cliente controle directo —
 * pero es la frontera donde un string se convierte en ruta de archivo
 * (docs/security-spec.md §5, fila "Recorrido de rutas"), así que igual se
 * verifica acá, no se confía en quien llama.
 */
function resolveObjectPath(rootDir: string, key: string): string {
  const resolved = normalize(join(rootDir, key));
  const rel = relative(rootDir, resolved);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep)[0] === "..") {
    throw new Error(`Key de almacenamiento fuera de la raíz configurada: "${key}".`);
  }
  return resolved;
}

function signMediaKey(secret: string, key: string, expiresAtEpochSeconds: number): string {
  return createHmac("sha256", secret).update(`${key}:${expiresAtEpochSeconds}`).digest("hex");
}

export function createLocalDiskStorage(options: LocalDiskStorageOptions): ObjectStorage {
  const { rootDir, publicBaseUrl, signingSecret } = options;
  const baseUrlWithTrailingSlash = publicBaseUrl.endsWith("/")
    ? publicBaseUrl
    : `${publicBaseUrl}/`;

  return {
    // `opts` (PutOptions.contentType/isPublic) no cambia cómo este adaptador
    // escribe en disco: la privacidad la decide qué RAÍZ ocupa la key
    // (originals/ nunca la sirve mediaServer.ts, catalog/ sí) y el
    // Content-Type de lo servido lo decide el formato real del derivado
    // (mediaServer.ts), no un header guardado sin validar.
    async put(key: string, body: Uint8Array): Promise<string> {
      const path = resolveObjectPath(rootDir, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
      return key;
    },

    async signedUrl(key: string, ttlSeconds: number): Promise<string> {
      const expiresAtEpochSeconds = Math.floor(Date.now() / 1000) + ttlSeconds;
      const signature = signMediaKey(signingSecret, key, expiresAtEpochSeconds);
      const url = new URL(key, baseUrlWithTrailingSlash);
      url.searchParams.set("expires", String(expiresAtEpochSeconds));
      url.searchParams.set("sig", signature);
      return url.toString();
    },

    async delete(key: string): Promise<void> {
      const path = resolveObjectPath(rootDir, key);
      await rm(path, { force: true });
    },
  };
}

/**
 * Mismo criterio que assertRlsNotBypassed (apps/api/src/db/client.ts,
 * WP-C02): correr una vez al arrancar, abortar el proceso si la
 * configuración es la que nunca debería usarse en producción. Disco local
 * no sobrevive un redeploy ni escala a más de un proceso — sirve para
 * desarrollo y para los tests de integración de este WP, nunca para
 * producción real (ahí va el adaptador de Supabase Storage, todavía sin
 * construir).
 */
export function assertLocalDiskStorageAllowedInProduction(nodeEnv: string | undefined): void {
  if (nodeEnv === "production") {
    throw new Error(
      "El adaptador de almacenamiento en disco local no puede usarse con NODE_ENV=production " +
        "(apps/api/src/adapters/storage/localDiskStorage.ts, WP-C09): no sobrevive un redeploy " +
        "ni escala a más de un proceso. El adaptador de producción (Supabase Storage) todavía " +
        "no existe — ver el ADR pendiente sobre el reemplazo de Cloudflare R2.",
    );
  }
}
