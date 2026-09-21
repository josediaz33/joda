import { describe, expect, it } from "vitest";
import { computeValidTotpCodes, generateTotpSecretBase32 } from "./totp.js";

// Vector de prueba OFICIAL de RFC 6238 Apéndice B (SHA1): secreto ASCII
// "12345678901234567890" (20 bytes), en base32 — no un valor inventado, así
// que si la implementación se desvía del estándar (offset de truncamiento,
// endianness del contador, tamaño de paso) esto lo detecta contra una fuente
// externa, no contra la propia implementación.
const RFC6238_SECRET_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("RFC 6238 Apéndice B · computeValidTotpCodes — vector de prueba oficial (SHA1, paso de 30 s)", () => {
  it("T = 59 s (contador 1) → 94287082 truncado a 6 dígitos es 287082", () => {
    const codes = computeValidTotpCodes(RFC6238_SECRET_BASE32, 59_000, 0);
    expect(codes).toEqual(["287082"]);
  });

  it("T = 1111111109 s (contador 37037036) → 081804", () => {
    const codes = computeValidTotpCodes(RFC6238_SECRET_BASE32, 1_111_111_109_000, 0);
    expect(codes).toEqual(["081804"]);
  });
});

describe("docs/security-spec.md §4.3 · computeValidTotpCodes — tolerancia de reloj desincronizado", () => {
  it("con driftSteps = 1 devuelve el código del paso anterior, el actual y el siguiente, en ese orden", () => {
    // T = 59 s cae en el contador 1 (RFC6238_SECRET_BASE32, paso de 30 s) —
    // 0 y 2 son sus vecinos inmediatos.
    const codes = computeValidTotpCodes(RFC6238_SECRET_BASE32, 59_000, 1);
    expect(codes).toEqual(["755224", "287082", "359152"]);
  });

  it("driftSteps = 0 devuelve un único código: el del paso actual", () => {
    const codes = computeValidTotpCodes(RFC6238_SECRET_BASE32, 59_000, 0);
    expect(codes).toHaveLength(1);
  });
});

describe("docs/security-spec.md §4.3 · generateTotpSecretBase32", () => {
  it("genera un secreto en alfabeto base32 (A-Z, 2-7), sin relleno", () => {
    const secret = generateTotpSecretBase32();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
  });

  it("dos secretos generados en llamadas distintas no coinciden — no es un valor fijo", () => {
    expect(generateTotpSecretBase32()).not.toBe(generateTotpSecretBase32());
  });

  it("el secreto generado es utilizable de punta a punta: computeValidTotpCodes no revienta con él", () => {
    const secret = generateTotpSecretBase32();
    const codes = computeValidTotpCodes(secret, Date.now(), 1);
    expect(codes).toHaveLength(3);
    for (const code of codes) expect(code).toMatch(/^\d{6}$/);
  });
});
