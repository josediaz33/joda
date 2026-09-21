// Esquemas de sesión de personal (WP-C03, docs/security-spec.md §4). Los
// tokens de acceso y de refresco NUNCA viajan en el cuerpo de la respuesta
// (nunca en localStorage, y acá tampoco en JSON) — viven solo en la cookie
// httpOnly `__Host-joda_a`, que Fastify pone con `Set-Cookie`, fuera del
// contrato de tRPC. Por eso ninguno de estos esquemas de salida tiene un
// campo `token`.
import { z } from "zod";
import { idSchema } from "./shared/id.js";

export const staffLoginInput = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .strict();
export type StaffLoginInput = z.infer<typeof staffLoginInput>;

// Estado de sesión frente al segundo factor (WP-C04, docs/security-spec.md
// §4.3) — espejo de StaffMfaStatus (packages/domain/src/security/totp.ts).
// packages/contracts no depende de packages/domain (frontera de tipos
// independiente, igual que `Audience` en apps/api/src/trpc/context.ts), así
// que el literal se repite acá, no se importa.
export const staffMfaStatus = z.enum(["pending_enrollment", "pending_verification", "satisfied"]);
export type StaffMfaStatus = z.infer<typeof staffMfaStatus>;

export const staffSessionProfile = z
  .object({
    id: idSchema,
    email: z.string().email(),
    fullName: z.string(),
    mfaStatus: staffMfaStatus,
  })
  .strict();
export type StaffSessionProfile = z.infer<typeof staffSessionProfile>;

// auth.session.refresh y auth.session.logout no toman entrada: leen la
// cookie del pedido (apps/api/src/trpc/context.ts), no un id de sesión que
// el cliente podría falsificar.
export const staffSessionRefreshOutput = z.object({ ok: z.literal(true) }).strict();
export type StaffSessionRefreshOutput = z.infer<typeof staffSessionRefreshOutput>;

export const staffLogoutOutput = z.object({ ok: z.literal(true) }).strict();
export type StaffLogoutOutput = z.infer<typeof staffLogoutOutput>;

// auth.mfa.* (WP-C04) — inscripción y verificación de TOTP sobre una sesión
// de personal ya autenticada por contraseña.
export const mfaEnrollOutput = z
  .object({
    // Base32 — se muestra UNA sola vez, para quien no pueda escanear el QR.
    secret: z.string(),
    otpauthUri: z.string(),
  })
  .strict();
export type MfaEnrollOutput = z.infer<typeof mfaEnrollOutput>;

const totpCodeInput = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();

export const mfaConfirmEnrollInput = totpCodeInput;
export type MfaConfirmEnrollInput = z.infer<typeof mfaConfirmEnrollInput>;

export const mfaVerifyInput = totpCodeInput;
export type MfaVerifyInput = z.infer<typeof mfaVerifyInput>;

export const mfaActionOutput = z.object({ mfaStatus: staffMfaStatus }).strict();
export type MfaActionOutput = z.infer<typeof mfaActionOutput>;
