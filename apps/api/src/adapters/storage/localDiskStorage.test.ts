import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertLocalDiskStorageAllowedInProduction,
  createLocalDiskStorage,
} from "./localDiskStorage.js";

// Mismo criterio que assertRlsNotBypassed (apps/api/src/db/client.ts,
// WP-C02, docs/security-spec.md §3.1): un adaptador que no debería llegar a
// producción no arranca el proceso en silencio.
describe("assertLocalDiskStorageAllowedInProduction · WP-C09", () => {
  it("lanza si NODE_ENV es production", () => {
    expect(() => assertLocalDiskStorageAllowedInProduction("production")).toThrow(
      /no puede usarse con NODE_ENV=production/,
    );
  });

  it("no lanza en development", () => {
    expect(() => assertLocalDiskStorageAllowedInProduction("development")).not.toThrow();
  });

  it("no lanza en test", () => {
    expect(() => assertLocalDiskStorageAllowedInProduction("test")).not.toThrow();
  });

  it("no lanza si NODE_ENV no está definido", () => {
    expect(() => assertLocalDiskStorageAllowedInProduction(undefined)).not.toThrow();
  });
});

// Revisión cruzada del PR #48: la guarda de resolveObjectPath (comentario
// del código, docs/security-spec.md §5 fila "Recorrido de rutas") no tenía
// ningún test — la key SIEMPRE sale de packages/domain/src/catalog/media.ts
// (validada contra un sha256 de 64 hex), pero esta es la frontera donde un
// string se convierte en ruta de archivo, y una guarda de seguridad sin
// test que confirme que bloquea es una afirmación sin fundamento
// (.claude/rules/testing.md).
describe("LocalDiskStorage rechaza keys que intentan salir de rootDir · docs/security-spec.md §5", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "joda-storage-traversal-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  // Un segmento con "/" al inicio ("/etc/passwd") NO es un vector acá:
  // `node:path` `join()` (a diferencia de `resolve()`) lo trata como un
  // segmento más, nunca "reinicia" a la raíz del filesystem — queda
  // contenido dentro de `rootDir` igual. El vector real son las
  // secuencias `..` que suben de directorio, los tres casos de abajo.
  const MALICIOUS_KEYS = ["../outside.txt", "../../etc/passwd", "catalog/../../outside.txt"];

  it.each(MALICIOUS_KEYS)('put rechaza la key "%s" sin escribir nada', async (maliciousKey) => {
    const storage = createLocalDiskStorage({
      rootDir,
      publicBaseUrl: "http://media.localhost:3334",
      signingSecret: "0".repeat(32),
    });

    await expect(
      storage.put(maliciousKey, new Uint8Array([1]), {
        contentType: "application/octet-stream",
        isPublic: false,
      }),
    ).rejects.toThrow(/fuera de la raíz configurada/);

    expect(await readdir(rootDir)).toEqual([]);
  });

  it.each(MALICIOUS_KEYS)('delete rechaza la key "%s"', async (maliciousKey) => {
    const storage = createLocalDiskStorage({
      rootDir,
      publicBaseUrl: "http://media.localhost:3334",
      signingSecret: "0".repeat(32),
    });

    await expect(storage.delete(maliciousKey)).rejects.toThrow(/fuera de la raíz configurada/);
  });

  it("put acepta una key normal, con subcarpetas, sin disparar la guarda", async () => {
    const storage = createLocalDiskStorage({
      rootDir,
      publicBaseUrl: "http://media.localhost:3334",
      signingSecret: "0".repeat(32),
    });

    await expect(
      storage.put("catalog/abc123/320.avif", new Uint8Array([1]), {
        contentType: "image/avif",
        isPublic: true,
      }),
    ).resolves.toBe("catalog/abc123/320.avif");
  });
});
