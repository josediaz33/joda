import type { ObjectStorage } from "@joda/domain";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalDiskStorage } from "./localDiskStorage.js";

// Contrato de ObjectStorage (packages/domain/src/ports/storage.ts,
// docs/engineering-principles.md Parte I "L · Sustitución de Liskov": "los
// mismos tests de contrato corren contra todos los adaptadores"). Corre
// parametrizado por implementación — hoy solo LocalDiskStorage. El
// adaptador de Supabase Storage (ADR pendiente sobre el reemplazo de
// Cloudflare R2, fuera de esta rama) se agrega a `implementations` cuando
// exista, mismo criterio que SupabasePasswordProvider en
// staffAuthProvider.contract.test.ts — cada implementación recibe una raíz
// nueva por test (`rootDir`), así que se parametriza por una FACTORY, no
// por una instancia ya construida.
const implementations: ReadonlyArray<{
  readonly name: string;
  readonly create: (rootDir: string) => ObjectStorage;
}> = [
  {
    name: "LocalDiskStorage",
    create: (rootDir) =>
      createLocalDiskStorage({
        rootDir,
        publicBaseUrl: "http://media.localhost:3334",
        signingSecret: "0".repeat(32),
      }),
  },
];

describe.each(implementations)(
  "contrato de ObjectStorage · $name (docs/engineering-principles.md Parte I·L)",
  ({ create }) => {
    let rootDir: string;
    let storage: ObjectStorage;

    beforeEach(async () => {
      rootDir = await mkdtemp(join(tmpdir(), "joda-storage-contract-"));
      storage = create(rootDir);
    });

    afterEach(async () => {
      await rm(rootDir, { recursive: true, force: true });
    });

    it("put devuelve la key y persiste los bytes exactos", async () => {
      const body = new TextEncoder().encode("contenido de prueba");

      const returnedKey = await storage.put("catalog/abc/320.avif", body, {
        contentType: "image/avif",
        isPublic: true,
      });

      expect(returnedKey).toBe("catalog/abc/320.avif");
      const persisted = await readFile(join(rootDir, "catalog/abc/320.avif"));
      expect(new Uint8Array(persisted)).toEqual(body);
    });

    it("put crea los directorios intermedios que hagan falta", async () => {
      await storage.put("originals/deep/nested/path", new Uint8Array([1, 2, 3]), {
        contentType: "application/octet-stream",
        isPublic: false,
      });

      const persisted = await readFile(join(rootDir, "originals/deep/nested/path"));
      expect(Array.from(persisted)).toEqual([1, 2, 3]);
    });

    it("signedUrl devuelve una URL bajo el origen público, con la key y una firma", async () => {
      const url = await storage.signedUrl("originals/abc123", 300);

      const parsed = new URL(url);
      expect(parsed.origin).toBe("http://media.localhost:3334");
      expect(parsed.pathname).toBe("/originals/abc123");
      expect(parsed.searchParams.get("sig")).toBeTruthy();
      expect(parsed.searchParams.get("expires")).toBeTruthy();
    });

    it("dos firmas de la misma key con TTL distinto difieren (el expires forma parte de lo firmado)", async () => {
      const shortUrl = new URL(await storage.signedUrl("catalog/x/320.avif", 60));
      const longUrl = new URL(await storage.signedUrl("catalog/x/320.avif", 3600));

      expect(shortUrl.searchParams.get("sig")).not.toBe(longUrl.searchParams.get("sig"));
    });

    it("delete borra el objeto — una segunda lectura ya no lo encuentra", async () => {
      await storage.put("catalog/borrar/320.avif", new Uint8Array([9]), {
        contentType: "image/avif",
        isPublic: true,
      });

      await storage.delete("catalog/borrar/320.avif");

      await expect(readFile(join(rootDir, "catalog/borrar/320.avif"))).rejects.toThrow();
    });

    it("delete sobre una key que no existe no lanza — es idempotente", async () => {
      await expect(storage.delete("catalog/nunca-existio/320.avif")).resolves.toBeUndefined();
    });
  },
);
