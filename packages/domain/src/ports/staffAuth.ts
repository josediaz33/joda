// StaffAuthProvider — puerto de verificación de contraseña de personal
// (WP-C03, ADR-004: "Auth con MFA, recuperación de contraseña y OAuth
// resueltos" por Supabase, "auth encapsulada tras una interfaz"). El
// dominio no sabe que existe Supabase: eso es el adaptador
// (apps/api/src/adapters/staffAuth/), no esta interfaz — igual que
// ports/fiscal.ts no sabe qué integrador fiscal termina implementándolo
// (docs/domain-contracts.md §2, docs/engineering-principles.md Parte I "D").
//
// Lo único que este puerto expone es lo que el caso de uso de login
// necesita: si la credencial es válida, y con qué `auth_subject` mapear al
// `staff_users` de esta base (packages/db/migrations/0002_identity_rbac.sql).
// El estado de segundo factor (`staff_users.mfa_enrolled`) sale de nuestra
// propia tabla, no de este puerto — WP-C04 lo lee directo, no hace falta
// duplicarlo acá.
import type { Result } from "../shared/result.js";

export interface StaffCredentials {
  readonly email: string;
  readonly password: string;
}

export interface StaffIdentity {
  readonly authSubject: string;
}

/**
 * `INVALID_CREDENTIALS` cubre tanto "no existe ese email" como "contraseña
 * incorrecta" — a propósito el mismo código para los dos casos
 * (docs/security-spec.md §5.1, "mensaje idéntico para usuario inexistente y
 * contraseña incorrecta"): quien llama a este puerto no puede distinguirlos
 * sin abrir una vía de enumeración de usuarios.
 */
export type StaffAuthError =
  { readonly code: "INVALID_CREDENTIALS" } | { readonly code: "PROVIDER_UNAVAILABLE" };

export interface StaffAuthProvider {
  verifyPassword(credentials: StaffCredentials): Promise<Result<StaffIdentity, StaffAuthError>>;
}
