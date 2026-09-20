import type { StaffAuthProvider } from "@joda/domain";
import { describe, expect, it } from "vitest";
import { createFakeStaffAuthProvider } from "./fakeStaffAuthProvider.js";

// Contrato de StaffAuthProvider (packages/domain/src/ports/staffAuth.ts,
// docs/engineering-principles.md Parte I "L · Sustitución de Liskov": "los
// mismos tests de contrato corren contra todos los adaptadores"). Corre
// parametrizado por implementación — hoy solo FakeStaffAuthProvider.
//
// SupabasePasswordProvider (supabasePasswordProvider.ts) todavía no está acá:
// necesita un proyecto de Supabase real contra el cual autenticar (SUPABASE_URL/
// SUPABASE_ANON_KEY están vacías en .env.example, ningún WP los provisionó
// todavía). Agregarlo a `implementations` de abajo, con las credenciales de
// un usuario de prueba real, es el criterio de aceptación de WP-C03b
// (docs/backlog.md) — no antes.
const implementations: ReadonlyArray<{
  readonly name: string;
  readonly provider: StaffAuthProvider;
}> = [
  {
    name: "FakeStaffAuthProvider",
    provider: createFakeStaffAuthProvider(
      new Map([["jose@jodaparfums.com", { password: "correcta", authSubject: "auth|jose" }]]),
    ),
  },
];

describe.each(implementations)(
  "contrato de StaffAuthProvider · $name (docs/engineering-principles.md Parte I·L)",
  ({ provider }) => {
    it("credencial correcta → ok con el authSubject de ese usuario", async () => {
      const result = await provider.verifyPassword({
        email: "jose@jodaparfums.com",
        password: "correcta",
      });

      expect(result).toEqual({ ok: true, value: { authSubject: "auth|jose" } });
    });

    it("contraseña incorrecta → err INVALID_CREDENTIALS", async () => {
      const result = await provider.verifyPassword({
        email: "jose@jodaparfums.com",
        password: "incorrecta",
      });

      expect(result).toEqual({ ok: false, error: { code: "INVALID_CREDENTIALS" } });
    });

    it("email inexistente → el mismo err INVALID_CREDENTIALS que una contraseña incorrecta (docs/security-spec.md §5.1)", async () => {
      const result = await provider.verifyPassword({
        email: "no-existe@jodaparfums.com",
        password: "cualquiera",
      });

      expect(result).toEqual({ ok: false, error: { code: "INVALID_CREDENTIALS" } });
    });
  },
);
