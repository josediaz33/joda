// node --test scripts/dev/lib/*.test.mjs  (ver "test:dev-scripts" en package.json)
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { base32Decode, secondsLeft, totpCode } from "./totp.mjs";

// RFC 6238, apéndice B: secreto ASCII "12345678901234567890" (en base32, abajo). Los
// códigos de la RFC son de 8 dígitos; los de 6 son sus últimos 6.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totpCode calcula el TOTP de la RFC 6238 (docs/security-spec.md §4.3, WP-M18)", () => {
  test("T=59 s da 287082", () => {
    assert.equal(totpCode(RFC_SECRET, 59_000), "287082");
  });

  test("T=1111111109 s da 081804", () => {
    assert.equal(totpCode(RFC_SECRET, 1_111_111_109_000), "081804");
  });

  test("T=1234567890 s da 005924 (conserva el cero inicial)", () => {
    assert.equal(totpCode(RFC_SECRET, 1_234_567_890_000), "005924");
  });

  test("T=2000000000 s da 279037", () => {
    assert.equal(totpCode(RFC_SECRET, 2_000_000_000_000), "279037");
  });

  test("el código no cambia dentro de la misma ventana de 30 s", () => {
    assert.equal(totpCode(RFC_SECRET, 30_000), totpCode(RFC_SECRET, 59_999));
  });
});

describe("base32Decode (docs/security-spec.md §4.3, WP-M18)", () => {
  test("decodifica el secreto de la RFC a su texto ASCII", () => {
    assert.equal(base32Decode(RFC_SECRET).toString("ascii"), "12345678901234567890");
  });

  test("ignora separadores y minúsculas, como las apps autenticadoras", () => {
    assert.equal(
      base32Decode("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq").toString("ascii"),
      "12345678901234567890",
    );
  });
});

describe("secondsLeft (docs/security-spec.md §4.3, WP-M18)", () => {
  test("al inicio de la ventana quedan 30 s", () => {
    assert.equal(secondsLeft(60_000), 30);
  });

  test("al final de la ventana queda 1 s", () => {
    assert.equal(secondsLeft(89_000), 1);
  });
});
