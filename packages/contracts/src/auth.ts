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

export const staffSessionProfile = z
  .object({
    id: idSchema,
    email: z.string().email(),
    fullName: z.string(),
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
