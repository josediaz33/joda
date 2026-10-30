import { randomUUID } from "node:crypto";
import type { StaffAuthProvider } from "@joda/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeStaffAuthProvider } from "./fakeStaffAuthProvider.js";
import { createSupabasePasswordProvider } from "./supabasePasswordProvider.js";

// Contrato de StaffAuthProvider (packages/domain/src/ports/staffAuth.ts,
// docs/engineering-principles.md Parte I "L · Sustitución de Liskov": "los
// mismos tests de contrato corren contra todos los adaptadores"). Corre
// parametrizado por implementación:
//
// - FakeStaffAuthProvider: siempre. Sin red.
// - SupabasePasswordProvider contra el GoTrue LOCAL (WP-M18): solo con
//   `pnpm test:auth-local`, que no levanta nada: exige el entorno de
//   `pnpm dev:setup` ya corriendo y fija JODA_TEST_AUTH_LOCAL=1 y las variables de
//   `.env.local`. Es el MISMO adaptador de producción, sin cambios, contra la
//   misma API de contraseña de GoTrue que expone Supabase. Esto avanza
//   WP-C03b (docs/backlog.md) pero NO lo cierra: C03b es contra un proyecto
//   REAL de Supabase, que nadie provisionó todavía.
//
// Qué NO es esto: la corrida por defecto (`pnpm test`, CI de pruebas) no
// toca la red. Con la bandera puesta y un SUPABASE_URL que no sea de esta
// máquina, el archivo se niega a correr: crea y borra usuarios en el
// proveedor, y eso no se hace contra un proyecto real.

interface ProvisionedProvider {
  readonly provider: StaffAuthProvider;
  readonly validCredentials: { readonly email: string; readonly password: string };
  readonly expectedAuthSubject: string;
  readonly unknownEmail: string;
  readonly dispose?: () => Promise<void>;
}

function defineStaffAuthContract(
  name: string,
  provision: () => Promise<ProvisionedProvider>,
  { enabled }: { readonly enabled: boolean },
) {
  describe.skipIf(!enabled)(
    `contrato de StaffAuthProvider · ${name} (docs/engineering-principles.md Parte I·L)`,
    () => {
      let fixture: ProvisionedProvider;

      beforeAll(async () => {
        fixture = await provision();
      });

      afterAll(async () => {
        await fixture?.dispose?.();
      });

      it("credencial correcta → ok con el authSubject de ese usuario", async () => {
        const result = await fixture.provider.verifyPassword(fixture.validCredentials);

        expect(result).toEqual({ ok: true, value: { authSubject: fixture.expectedAuthSubject } });
      });

      it("contraseña incorrecta → err INVALID_CREDENTIALS", async () => {
        const result = await fixture.provider.verifyPassword({
          email: fixture.validCredentials.email,
          password: "incorrecta",
        });

        expect(result).toEqual({ ok: false, error: { code: "INVALID_CREDENTIALS" } });
      });

      it("email inexistente → el mismo err INVALID_CREDENTIALS que una contraseña incorrecta (docs/security-spec.md §5.1)", async () => {
        const result = await fixture.provider.verifyPassword({
          email: fixture.unknownEmail,
          password: "cualquiera",
        });

        expect(result).toEqual({ ok: false, error: { code: "INVALID_CREDENTIALS" } });
      });
    },
  );
}

defineStaffAuthContract(
  "FakeStaffAuthProvider",
  async () => ({
    provider: createFakeStaffAuthProvider(
      new Map([["jose@jodaparfums.com", { password: "correcta", authSubject: "auth|jose" }]]),
    ),
    validCredentials: { email: "jose@jodaparfums.com", password: "correcta" },
    expectedAuthSubject: "auth|jose",
    unknownEmail: "no-existe@jodaparfums.com",
  }),
  { enabled: true },
);

// --- GoTrue local (WP-M18) ---------------------------------------------

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

interface LocalGoTrueConfig {
  readonly supabaseUrl: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
}

/** `null` si la corrida no pidió el GoTrue local; lanza si lo pidió mal configurado o apuntando fuera de esta máquina. */
function readLocalGoTrueConfig(env: NodeJS.ProcessEnv): LocalGoTrueConfig | null {
  if (env.JODA_TEST_AUTH_LOCAL !== "1") return null;
  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "JODA_TEST_AUTH_LOCAL=1 exige SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY. Corré `pnpm test:auth-local`, que las toma de .env.local.",
    );
  }
  if (!LOOPBACK_HOSTS.has(new URL(SUPABASE_URL).hostname)) {
    throw new Error(
      `SUPABASE_URL (${SUPABASE_URL}) no es de esta máquina: el contrato crea y borra usuarios, y no corre contra un proyecto real.`,
    );
  }
  return {
    supabaseUrl: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
  };
}

const localGoTrue = readLocalGoTrueConfig(process.env);

async function goTrueAdmin(
  config: LocalGoTrueConfig,
  method: "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ id?: string }> {
  const response = await fetch(new URL(`/auth/v1/${path}`, config.supabaseUrl), {
    method,
    headers: {
      apikey: config.anonKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`GoTrue ${method} ${path} respondió ${response.status}.`);
  }
  return method === "DELETE" ? {} : ((await response.json()) as { id?: string });
}

defineStaffAuthContract(
  "SupabasePasswordProvider contra el GoTrue local",
  async () => {
    const config = localGoTrue as LocalGoTrueConfig;
    // Un usuario propio de esta corrida: no depende de que `pnpm dev:setup` haya
    // sembrado nada, y no toca a los usuarios de prueba.
    const suffix = randomUUID();
    const email = `contrato-${suffix}@joda.test`;
    const password = `Contrato-${suffix}`;
    const created = await goTrueAdmin(config, "POST", "admin/users", {
      email,
      password,
      email_confirm: true,
    });
    if (!created.id) throw new Error("GoTrue no devolvió el id del usuario de prueba.");
    const userId = created.id;

    return {
      provider: createSupabasePasswordProvider({
        supabaseUrl: config.supabaseUrl,
        supabaseAnonKey: config.anonKey,
      }),
      validCredentials: { email, password },
      expectedAuthSubject: userId,
      unknownEmail: `no-existe-${suffix}@joda.test`,
      dispose: async () => {
        await goTrueAdmin(config, "DELETE", `admin/users/${userId}`);
      },
    };
  },
  { enabled: localGoTrue !== null },
);

// El gateway de Supabase (y el proxy local) exigen una `apikey` válida; el
// adaptador tiene que mandarla y, si el proveedor la rechaza, NO confundirlo con
// una contraseña incorrecta (sería un login "fallido" que oculta una configuración rota).
describe.skipIf(localGoTrue === null)(
  "SupabasePasswordProvider contra el GoTrue local · apikey (docs/security-spec.md §5.1, WP-M18)",
  () => {
    it("una clave anónima inválida → err PROVIDER_UNAVAILABLE, no INVALID_CREDENTIALS", async () => {
      const config = localGoTrue as LocalGoTrueConfig;
      const provider = createSupabasePasswordProvider({
        supabaseUrl: config.supabaseUrl,
        supabaseAnonKey: "clave-que-no-es-la-del-proyecto",
      });

      const result = await provider.verifyPassword({
        email: "cualquiera@joda.test",
        password: "cualquiera",
      });

      expect(result).toEqual({ ok: false, error: { code: "PROVIDER_UNAVAILABLE" } });
    });
  },
);
