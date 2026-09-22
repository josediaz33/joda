import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import { CookieJar } from "tough-cookie";
import { describe, expect, it } from "vitest";
import { setStaffSessionCookie, STAFF_SESSION_COOKIE } from "./cookie.js";

/**
 * docs/security-spec.md §5, fila "Carga de archivos": "servidos desde
 * dominio distinto al del admin" — la propiedad de fondo detrás de esa
 * regla (WP-C09) es que la cookie de sesión de personal no viaje a donde
 * se sirven los medios. `__Host-joda_a` no lleva `Domain` (cookie.ts,
 * `BASE_COOKIE_OPTIONS`), lo que la hace host-only por RFC 6265 — un
 * navegador la manda solo al host EXACTO que la emitió, ni siquiera a otro
 * puerto del mismo host. Se prueba acá con `tough-cookie`, una
 * implementación real de esa RFC (no un mock), contra el Set-Cookie que
 * produce el código real de este módulo — no una reimplementación de la
 * regla en el propio test.
 */
describe("__Host-joda_a es host-only (docs/security-spec.md §5, WP-C09)", () => {
  it("un navegador la manda de vuelta al mismo host, incluso a otro puerto, pero nunca a otro host", async () => {
    const app = Fastify();
    await app.register(fastifyCookie, { secret: "0".repeat(32) });
    app.get("/login", async (_req, reply) => {
      setStaffSessionCookie(
        reply,
        { sessionId: "session-1", secret: "secret-1" },
        new Date(Date.now() + 60_000),
      );
      return reply.send({ ok: true });
    });

    const response = await app.inject({ method: "GET", url: "/login" });
    const rawSetCookie = response.headers["set-cookie"];
    const setCookieHeader = Array.isArray(rawSetCookie) ? rawSetCookie[0] : rawSetCookie;
    expect(setCookieHeader).toBeDefined();

    const jar = new CookieJar();
    await jar.setCookie(setCookieHeader as string, "https://localhost/");

    const sameHost = await jar.getCookieString("https://localhost/");
    expect(sameHost).toContain(STAFF_SESSION_COOKIE);

    // Control: las cookies NO se aíslan por puerto (RFC 6265) — si
    // MEDIA_PUBLIC_BASE_URL solo cambiara el puerto (localhost:3334 en vez
    // de :3333), esto demuestra que la cookie igual llegaría ahí. Es
    // exactamente por lo que env.ts (WP-C09) compara HOSTNAME, no origen
    // completo.
    const sameHostDifferentPort = await jar.getCookieString("https://localhost:9999/");
    expect(sameHostDifferentPort).toContain(STAFF_SESSION_COOKIE);

    // La propiedad real: un host DISTINTO nunca la recibe.
    const differentHost = await jar.getCookieString("https://media.localhost/");
    expect(differentHost).toBe("");

    await app.close();
  });
});
