import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer, startListening } from "./index.js";
import { buildMediaServer } from "./mediaServer.js";

function boundAddress(server: FastifyInstance): string {
  return (server.server.address() as AddressInfo).address;
}

// WP-M18, docs/runbooks/entorno-local.md: en el entorno local la API y el servidor de
// medios escuchan solo en 127.0.0.1 (el admin de desarrollo tiene usuarios de prueba y
// no tiene por qué ser alcanzable desde la red); sin API_HOST escuchan en 0.0.0.0, como
// siempre, para el despliegue en contenedor. Se prueba el arranque de verdad: se abren
// los dos servidores y se lee en qué interfaz quedaron.
describe("startListening usa API_HOST para elegir la interfaz (docs/runbooks/entorno-local.md)", () => {
  let mediaStorageDir: string;
  let app: FastifyInstance;
  let mediaServer: FastifyInstance;

  beforeEach(async () => {
    mediaStorageDir = await mkdtemp(join(tmpdir(), "joda-listen-"));
    await mkdir(join(mediaStorageDir, "catalog"), { recursive: true });
    app = buildServer();
    mediaServer = buildMediaServer(mediaStorageDir);
  });

  afterEach(async () => {
    await app.close();
    await mediaServer.close();
    await rm(mediaStorageDir, { recursive: true, force: true });
  });

  it("con API_HOST=127.0.0.1, la API y el servidor de medios escuchan solo en 127.0.0.1", async () => {
    await startListening({
      app,
      mediaServer,
      env: { API_HOST: "127.0.0.1", PORT: 0 },
      mediaPort: 0,
    });

    expect([boundAddress(app), boundAddress(mediaServer)]).toEqual(["127.0.0.1", "127.0.0.1"]);
  });

  it("sin API_HOST, la API y el servidor de medios escuchan en 0.0.0.0", async () => {
    await startListening({ app, mediaServer, env: { PORT: 0 }, mediaPort: 0 });

    expect([boundAddress(app), boundAddress(mediaServer)]).toEqual(["0.0.0.0", "0.0.0.0"]);
  });
});
