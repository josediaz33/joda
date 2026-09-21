import { err, ok, type StaffAuthProvider, type StaffCredentials } from "@joda/domain";

// Adaptador real de StaffAuthProvider (packages/domain/src/ports/staffAuth.ts),
// ADR-004: "Auth con MFA, recuperación de contraseña y OAuth resueltos" por
// Supabase. Se llama al endpoint REST de password grant de GoTrue
// directamente por `fetch` en vez de instalar `@supabase/supabase-js`: lo
// único que este WP necesita es "¿esta contraseña es correcta, y cuál es el
// auth_subject?" — un solo POST, no justifica traer el SDK completo
// (cliente realtime, storage, etc.) a apps/api.
//
// SIN VERIFICAR CONTRA UN PROYECTO DE SUPABASE REAL (anotado en el PR de
// WP-C03 y en docs/backlog.md como WP-C03b): este WP se desarrolló y probó
// solo contra FakeStaffAuthProvider (fakeStaffAuthProvider.ts). El contrato
// (staffAuthProvider.contract.test.ts) está armado para correr también
// contra esta implementación en cuanto exista un proyecto Supabase
// provisionado — ver ese archivo.
export interface SupabasePasswordProviderConfig {
  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
  readonly fetchImpl?: typeof fetch;
}

interface GoTrueTokenResponse {
  readonly user?: { readonly id?: string };
}

interface GoTrueErrorResponse {
  readonly error_code?: string;
  readonly msg?: string;
}

export function createSupabasePasswordProvider(
  config: SupabasePasswordProviderConfig,
): StaffAuthProvider {
  const fetchImpl = config.fetchImpl ?? fetch;
  const tokenUrl = new URL("/auth/v1/token", config.supabaseUrl);
  tokenUrl.searchParams.set("grant_type", "password");

  return {
    async verifyPassword(credentials: StaffCredentials) {
      let response: Response;
      try {
        response = await fetchImpl(tokenUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            apikey: config.supabaseAnonKey,
          },
          body: JSON.stringify({ email: credentials.email, password: credentials.password }),
        });
      } catch {
        return err({ code: "PROVIDER_UNAVAILABLE" });
      }

      if (response.status === 400) {
        // GoTrue responde 400 tanto para "no existe ese usuario" como para
        // "contraseña incorrecta" — no hace falta distinguirlos acá tampoco
        // (docs/security-spec.md §5.1, mismo criterio que el puerto).
        return err({ code: "INVALID_CREDENTIALS" });
      }

      if (!response.ok) {
        return err({ code: "PROVIDER_UNAVAILABLE" });
      }

      const body = (await response.json()) as GoTrueTokenResponse & GoTrueErrorResponse;
      const authSubject = body.user?.id;
      if (!authSubject) {
        return err({ code: "PROVIDER_UNAVAILABLE" });
      }

      return ok({ authSubject });
    },
  };
}
