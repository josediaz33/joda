import { describe, expect, it } from "vitest";
import { buildTotpEnrollmentUri, resolveStaffMfaStatus } from "./totp.js";

describe("docs/security-spec.md §4.3 · resolveStaffMfaStatus — usuario sin inscribir", () => {
  it("mfaEnrolled = false → pending_enrollment, sin importar el estado de la sesión", () => {
    expect(resolveStaffMfaStatus({ mfaEnrolled: false, sessionVerifiedAt: null })).toBe(
      "pending_enrollment",
    );
  });

  it("mfaEnrolled = false con sessionVerifiedAt no nulo también es pending_enrollment — inscribirse siempre gana", () => {
    expect(
      resolveStaffMfaStatus({ mfaEnrolled: false, sessionVerifiedAt: 1_700_000_000_000 }),
    ).toBe("pending_enrollment");
  });
});

describe("docs/security-spec.md §4.3 · resolveStaffMfaStatus — usuario inscripto, sesión nueva", () => {
  it("mfaEnrolled = true, sessionVerifiedAt = null → pending_verification: cada sesión nueva reinicia el desafío", () => {
    expect(resolveStaffMfaStatus({ mfaEnrolled: true, sessionVerifiedAt: null })).toBe(
      "pending_verification",
    );
  });

  it("mfaEnrolled = true, sessionVerifiedAt presente → satisfied", () => {
    expect(resolveStaffMfaStatus({ mfaEnrolled: true, sessionVerifiedAt: 1_700_000_000_000 })).toBe(
      "satisfied",
    );
  });
});

describe("Key URI Format (Google Authenticator) · buildTotpEnrollmentUri", () => {
  it("arma un otpauth://totp con label, secreto, emisor y los parámetros TOTP estándar", () => {
    const uri = buildTotpEnrollmentUri({
      secretBase32: "JBSWY3DPEHPK3PXP",
      accountEmail: "jose@jodaparfums.com",
      issuer: "JODA Parfums",
    });

    expect(uri).toBe(
      "otpauth://totp/JODA%20Parfums%3Ajose%40jodaparfums.com?secret=JBSWY3DPEHPK3PXP" +
        "&issuer=JODA+Parfums&algorithm=SHA1&digits=6&period=30",
    );
  });

  it("un email con caracteres que necesitan escape en la URL no rompe el label", () => {
    const uri = buildTotpEnrollmentUri({
      secretBase32: "JBSWY3DPEHPK3PXP",
      accountEmail: "jose+staff@jodaparfums.com",
      issuer: "JODA Parfums",
    });

    expect(uri.startsWith("otpauth://totp/JODA%20Parfums%3Ajose%2Bstaff%40jodaparfums.com?")).toBe(
      true,
    );
  });
});
