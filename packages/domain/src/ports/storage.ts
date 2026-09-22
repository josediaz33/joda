// ObjectStorage — puerto de almacenamiento de objetos binarios
// (docs/domain-contracts.md §5, WP-C09). El dominio no sabe si el
// adaptador real termina siendo disco local, Supabase Storage o cualquier
// otro proveedor — igual que ports/staffAuth.ts no sabe que existe
// Supabase Auth. Los adaptadores viven en apps/api/src/adapters/.
//
// `put`/`delete` son mutaciones directas: no hay noción de "borrador"
// acá, eso lo decide quien llama (docs/architecture/JODA_Arquitectura_v5_Final.md
// §8.3, tabla de buckets). `signedUrl` sirve para el contenido privado
// (originales sin procesar, comprobantes) — el contenido público
// (derivados de catálogo) se sirve por URL fija, sin firmar, para no
// romper el caché del CDN (mismo doc, §8.3).
export interface PutOptions {
  readonly contentType: string;
  readonly isPublic: boolean;
}

export interface ObjectStorage {
  /** Devuelve la key final del objeto — normalmente la misma `key` recibida, salvo que el adaptador la transforme. */
  put(key: string, body: Uint8Array, opts: PutOptions): Promise<string>;
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
}
