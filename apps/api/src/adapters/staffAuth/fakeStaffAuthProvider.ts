import { err, ok, type StaffAuthProvider } from "@joda/domain";

// Implementación falsa de StaffAuthProvider, para tests (contrato y
// apps/api/src/modules/auth). No hace I/O de red: mantiene un registro en
// memoria de credenciales válidas, inyectado por el test — el mismo criterio
// de "el servicio inyecta implementaciones reales; los tests inyectan
// implementaciones fijas" que ya usan Clock/IdGenerator
// (docs/domain-contracts.md §1.1), aplicado a un puerto que sí vive en
// apps/api (StaffAuthProvider es I/O, así que el puerto está en
// packages/domain, pero ninguna implementación de él es "domain puro").
export function createFakeStaffAuthProvider(
  validCredentials: ReadonlyMap<
    string,
    { readonly password: string; readonly authSubject: string }
  >,
): StaffAuthProvider {
  return {
    async verifyPassword({ email, password }) {
      const record = validCredentials.get(email);
      if (!record || record.password !== password) {
        return err({ code: "INVALID_CREDENTIALS" });
      }
      return ok({ authSubject: record.authSubject });
    },
  };
}
