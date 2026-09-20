import type { FastifyReply, FastifyRequest } from "fastify";

// Cookie de sesión de personal (docs/security-spec.md §4.1). `__Host-` exige
// Secure + Path=/ + sin Domain — el navegador la rechaza si falta alguna de
// las tres, así que van fijas acá, no como parámetro.
export const STAFF_SESSION_COOKIE = "__Host-joda_a";

const BASE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "strict",
  path: "/",
} as const;

/**
 * El valor de la cookie es `sessionId.secret` — `sessionId` (uuid, la
 * "familia" de packages/db/migrations/0011_staff_sessions.sql) identifica
 * la sesión sin ir a la base; `secret` es el token de refresco crudo, que
 * solo se compara por hash (adapters/secureToken.ts). Firmado con
 * SESSION_SECRET vía @fastify/cookie: si alguien arma un valor a mano, con
 * un `sessionId` ajeno adivinado, `unsignCookie` lo rechaza antes de que
 * este archivo intente separarlo.
 */
export interface StaffSessionCookieValue {
  readonly sessionId: string;
  readonly secret: string;
}

export function readStaffSessionCookie(req: FastifyRequest): StaffSessionCookieValue | null {
  const raw = req.cookies[STAFF_SESSION_COOKIE];
  if (!raw) return null;

  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) return null;

  const separator = unsigned.value.indexOf(".");
  if (separator <= 0 || separator === unsigned.value.length - 1) return null;

  return {
    sessionId: unsigned.value.slice(0, separator),
    secret: unsigned.value.slice(separator + 1),
  };
}

export function setStaffSessionCookie(
  res: FastifyReply,
  value: StaffSessionCookieValue,
  expiresAt: Date,
): void {
  res.setCookie(STAFF_SESSION_COOKIE, `${value.sessionId}.${value.secret}`, {
    ...BASE_COOKIE_OPTIONS,
    signed: true,
    expires: expiresAt,
  });
}

export function clearStaffSessionCookie(res: FastifyReply): void {
  res.clearCookie(STAFF_SESSION_COOKIE, { path: BASE_COOKIE_OPTIONS.path });
}
