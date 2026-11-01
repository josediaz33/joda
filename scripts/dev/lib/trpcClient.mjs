import { totpCode, readTotpSecrets, writeTotpSecrets } from "./totp.mjs";

// Cliente tRPC por HTTP para los scripts de siembra (WP-M18): sin dependencias,
// sin tipos, con un frasco de cookies. Todo lo que el seed de datos escribe
// pasa por la API (su autorización, RLS, auditoría y reglas de dominio), no por
// INSERT directo. Mismo protocolo que el admin: JSON crudo, la cookie
// `__Host-joda_a` va y viene en las cabeceras.

export class TrpcCallError extends Error {
  /**
   * @param {string} path
   * @param {number} status
   * @param {string} message
   * @param {string | undefined} code
   */
  constructor(path, status, message, code) {
    super(`${path} → HTTP ${status}${code ? ` (${code})` : ""}: ${message}`);
    this.name = "TrpcCallError";
    this.path = path;
    this.status = status;
    this.code = code;
  }
}

/** @param {string} baseUrl */
export function createTrpcClient(baseUrl) {
  /** @type {Map<string, string>} */
  const cookies = new Map();

  /** @param {Response} response */
  function storeCookies(response) {
    for (const header of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = header.split(";");
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const expired = attributes.some((attribute) => {
        const [key = "", given = ""] = attribute.split("=");
        return (
          (key.trim().toLowerCase() === "max-age" && Number(given) <= 0) ||
          (key.trim().toLowerCase() === "expires" && Date.parse(given) <= Date.now())
        );
      });
      if (value === "" || expired) cookies.delete(name);
      else cookies.set(name, value);
    }
  }

  /**
   * @param {"query" | "mutation"} kind
   * @param {string} path
   * @param {unknown} [input]
   */
  async function call(kind, path, input) {
    const url = new URL(`/trpc/${path}`, baseUrl);
    /** @type {Record<string, string>} */
    const headers = {};
    if (cookies.size > 0) {
      headers.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    /** @type {RequestInit} */
    const init = { method: kind === "query" ? "GET" : "POST", headers };
    if (kind === "query") {
      if (input !== undefined) url.searchParams.set("input", JSON.stringify(input));
    } else {
      // Fastify rechaza un POST sin content-type (415); sin entrada se manda un objeto vacío.
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(input ?? {});
    }

    const response = await fetch(url, init);
    storeCookies(response);
    const text = await response.text();
    /** @type {any} */
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      throw new TrpcCallError(
        path,
        response.status,
        text.slice(0, 200) || "respuesta vacía",
        undefined,
      );
    }
    if (body?.error) {
      throw new TrpcCallError(
        path,
        response.status,
        body.error.message ?? "error sin mensaje",
        body.error.data?.appCode ?? body.error.data?.code,
      );
    }
    return body?.result?.data;
  }

  return {
    query: (/** @type {string} */ path, /** @type {unknown} */ input) => call("query", path, input),
    mutation: (/** @type {string} */ path, /** @type {unknown} */ input) =>
      call("mutation", path, input),
    /** Las cookies de la sesión actual, por si un test las necesita. */
    cookieHeader: () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
  };
}

/**
 * Entra como un usuario de prueba hasta dejar la sesión con el segundo factor
 * SATISFECHO: contraseña → (primera vez) inscripción del TOTP con el secreto que
 * devuelve la API, que se guarda en `.data/dev/` → código.
 *
 * @param {ReturnType<typeof createTrpcClient>} client
 * @param {{ role: string; email: string; password: string }} user
 * @param {{ now?: () => number }} [options]
 */
export async function signInWithMfa(client, user, { now = Date.now } = {}) {
  const profile = await client.mutation("auth.session.login", {
    email: user.email,
    password: user.password,
  });

  if (profile.mfaStatus === "satisfied") return;

  const secrets = readTotpSecrets();
  if (profile.mfaStatus === "pending_enrollment") {
    const enrollment = await client.mutation("auth.mfa.enroll");
    // Se guarda ANTES de confirmar: si se corta entre una cosa y la otra, el
    // secreto pendiente no queda perdido.
    writeTotpSecrets({ ...secrets, [user.role]: enrollment.secret });
    await client.mutation("auth.mfa.confirmEnroll", {
      code: totpCode(enrollment.secret, now()),
    });
    return;
  }

  const secret = secrets[user.role];
  if (!secret) {
    throw new Error(
      `${user.email} ya tiene el segundo factor inscripto pero no hay un secreto guardado en .data/dev/totp-secrets.json. Corré \`pnpm dev:setup\` para recrear la base y los usuarios.`,
    );
  }
  await client.mutation("auth.mfa.verify", { code: totpCode(secret, now()) });
}
