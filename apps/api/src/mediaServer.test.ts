import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMediaServer } from "./mediaServer.js";

// docs/security-spec.md §5, fila "Carga de archivos": "servidos desde
// dominio distinto al del admin". Este archivo prueba lo que SÍ le toca a
// este proceso (nunca abre sesión, sirve derivados con Content-Type fijo +
// nosniff, nunca ve originals/) — la propiedad de que el navegador nunca le
// manda la cookie de sesión de personal está en modules/auth/cookie.test.ts
// (host-only por RFC 6265, no algo que este server pueda decidir).
describe("mediaServer · docs/security-spec.md §5", () => {
  let mediaStorageDir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    mediaStorageDir = await mkdtemp(join(tmpdir(), "joda-media-server-"));
    await mkdir(join(mediaStorageDir, "catalog", "abc123"), { recursive: true });
    await writeFile(join(mediaStorageDir, "catalog", "abc123", "320.avif"), "contenido-avif");
    await writeFile(join(mediaStorageDir, "catalog", "abc123", "320.webp"), "contenido-webp");
    await mkdir(join(mediaStorageDir, "originals"), { recursive: true });
    await writeFile(join(mediaStorageDir, "originals", "abc123"), "original-privado");

    app = buildMediaServer(mediaStorageDir);
  });

  afterEach(async () => {
    await app.close();
    await rm(mediaStorageDir, { recursive: true, force: true });
  });

  it("sirve un derivado avif con Content-Type fijo por extensión y X-Content-Type-Options: nosniff", async () => {
    const response = await app.inject({ method: "GET", url: "/catalog/abc123/320.avif" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/avif");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.body).toBe("contenido-avif");
  });

  it("sirve un derivado webp con su propio Content-Type fijo", async () => {
    const response = await app.inject({ method: "GET", url: "/catalog/abc123/320.webp" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/webp");
  });

  it("nunca expone originals/ — ni siquiera con la ruta exacta del archivo real", async () => {
    const response = await app.inject({ method: "GET", url: "/originals/abc123" });

    expect(response.statusCode).toBe(404);
  });

  it("rechaza una extensión que no sea .avif/.webp aunque el archivo exista bajo catalog/", async () => {
    await writeFile(join(mediaStorageDir, "catalog", "abc123", "320.exe"), "no-es-una-imagen");

    const response = await app.inject({ method: "GET", url: "/catalog/abc123/320.exe" });

    expect(response.statusCode).toBe(404);
  });
});
