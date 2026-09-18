import { describe, expect, it } from "vitest";
import { buildServer } from "../index.js";

// No hay una RN-XXX que citar: WP-C01 es el esqueleto de transporte (tRPC
// sobre Fastify, contexto de petición, mapeador de errores), no una regla de
// negocio — misma excepción que .claude/rules/testing.md ya reconoce para
// packages/contracts (WP-A11). Se prueba contra Fastify real (`app.inject`),
// no contra el caller de tRPC en memoria: es la única forma de confirmar que
// el plugin está montado y que el código HTTP de la respuesta es el correcto,
// no solo que el router resuelve.
describe("esqueleto de apps/api — tRPC montado sobre Fastify (docs/backlog.md WP-C01)", () => {
  it("un procedimiento de ejemplo responde tipado de punta a punta", async () => {
    const app = buildServer();

    // Una `query` de tRPC viaja por GET con el input codificado en el
    // query string (`input=<json>`), no en el body — %7B%7D es "{}".
    const response = await app.inject({
      method: "GET",
      url: "/trpc/example.ping.list?input=%7B%7D",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.result.data.items).toHaveLength(1);
    expect(typeof body.result.data.items[0].price.minor).toBe("string");

    await app.close();
  });

  it("un CHECK de PostgreSQL violado (23514) llega como error en español, 409, con requestId", async () => {
    const app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/trpc/example.ping.failWithCheckViolation",
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.message).toBe("Los datos no cumplen una restricción del sistema.");
    expect(body.error.message).not.toMatch(/relation|constraint|violates/i);
    expect(body.error.data.appCode).toBe("CONFLICT_CHECK_VIOLATION");
    expect(body.error.data.httpStatus).toBe(409);
    expect(typeof body.error.data.requestId).toBe("string");
    expect(body.error.data.requestId.length).toBeGreaterThan(0);

    await app.close();
  });

  it("un bug real (no un error de Postgres) nunca expone su mensaje original", async () => {
    const app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/trpc/example.ping.failWithBug",
      payload: {},
    });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error.message).toBe("Ocurrió un error interno. Intentá de nuevo en unos minutos.");
    expect(body.error.message).not.toContain("detalle interno");
    expect(body.error.data.appCode).toBe("INTERNAL");

    await app.close();
  });
});
