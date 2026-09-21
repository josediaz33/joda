import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptMfaSecret, encryptMfaSecret } from "./mfaSecretCipher.js";

const KEY = Buffer.from("0".repeat(64), "hex"); // 32 bytes — clave de prueba fija, determinista

describe("docs/security-spec.md §4.3/§6 · encryptMfaSecret/decryptMfaSecret — ida y vuelta", () => {
  it("descifra exactamente el secreto que se cifró", () => {
    const plaintext = "JBSWY3DPEHPK3PXP";
    const ciphertext = encryptMfaSecret(plaintext, KEY);

    expect(decryptMfaSecret(ciphertext, KEY)).toBe(plaintext);
  });

  it("el mismo secreto cifrado dos veces produce salidas distintas — el IV nunca se reusa", () => {
    const plaintext = "JBSWY3DPEHPK3PXP";
    expect(encryptMfaSecret(plaintext, KEY)).not.toBe(encryptMfaSecret(plaintext, KEY));
  });

  it("el texto cifrado no contiene el secreto en claro", () => {
    const plaintext = "JBSWY3DPEHPK3PXP";
    expect(encryptMfaSecret(plaintext, KEY)).not.toContain(plaintext);
  });
});

describe("docs/security-spec.md §6 · integridad — GCM detecta un texto cifrado alterado", () => {
  it("descifrar con la clave equivocada rechaza, no devuelve basura silenciosa", () => {
    const ciphertext = encryptMfaSecret("JBSWY3DPEHPK3PXP", KEY);
    const wrongKey = randomBytes(32);

    expect(() => decryptMfaSecret(ciphertext, wrongKey)).toThrow();
  });

  it("un byte del texto cifrado modificado hace fallar la verificación de autenticidad", () => {
    const ciphertext = encryptMfaSecret("JBSWY3DPEHPK3PXP", KEY);
    const tampered = Buffer.from(ciphertext, "base64");
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 0xff, tampered.length - 1);

    expect(() => decryptMfaSecret(tampered.toString("base64"), KEY)).toThrow();
  });
});
