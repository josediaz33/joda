// Alta de usuarios en el Auth local por la Admin API de GoTrue (WP-M18),
// detrás del mismo proxy `/auth/v1` que usa el adaptador de la API. Mismo
// camino que usaría un administrador contra un proyecto de Supabase: clave de
// servicio en `Authorization`, clave anónima en `apikey`.

/**
 * @param {{ supabaseUrl: string; anonKey: string; serviceRoleKey: string }} config
 */
export function createGoTrueAdmin({ supabaseUrl, anonKey, serviceRoleKey }) {
  const base = new URL("/auth/v1/", supabaseUrl);

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   */
  async function request(method, path, body) {
    const response = await fetch(new URL(path, base), {
      method,
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${serviceRoleKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    /** @type {any} */
    let json = null;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    if (!response.ok) {
      throw new Error(
        `GoTrue ${method} ${path} respondió ${response.status}: ${json?.msg ?? json?.message ?? text.slice(0, 200)}`,
      );
    }
    return json;
  }

  /** @param {string} email */
  async function findUserByEmail(email) {
    // La lista de un entorno local son un puñado de usuarios: una página alcanza.
    const page = await request("GET", "admin/users?page=1&per_page=200");
    return (page?.users ?? []).find(
      (/** @type {{ email?: string }} */ user) => user.email?.toLowerCase() === email.toLowerCase(),
    );
  }

  return {
    /**
     * Crea el usuario con el correo confirmado o, si ya existe, le deja esta
     * contraseña: correr el setup dos veces da el mismo resultado.
     *
     * @param {{ email: string; password: string }} user
     * @returns {Promise<string>} el `id` (el `auth_subject` de `staff_users`)
     */
    async upsertUser({ email, password }) {
      const existing = await findUserByEmail(email);
      if (existing) {
        await request("PUT", `admin/users/${existing.id}`, { password, email_confirm: true });
        return existing.id;
      }
      const created = await request("POST", "admin/users", {
        email,
        password,
        email_confirm: true,
      });
      return created.id;
    },
    /** @param {string} userId */
    async deleteUser(userId) {
      await request("DELETE", `admin/users/${userId}`);
    },
  };
}
