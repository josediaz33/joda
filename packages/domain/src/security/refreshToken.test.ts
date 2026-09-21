import { describe, expect, it } from "vitest";
import { decideRefreshOutcome } from "./refreshToken.js";

const NOW = 1_700_000_000_000;
const ONE_HOUR_MS = 60 * 60 * 1000;

describe("docs/security-spec.md §4.2 · decideRefreshOutcome — token/sesión no encontrados", () => {
  it("token null → invalid", () => {
    const outcome = decideRefreshOutcome({
      token: null,
      session: { revokedAt: null, expiresAt: NOW + ONE_HOUR_MS },
      now: NOW,
    });

    expect(outcome).toEqual({ kind: "invalid" });
  });

  it("session null → invalid", () => {
    const outcome = decideRefreshOutcome({
      token: { consumedAt: null },
      session: null,
      now: NOW,
    });

    expect(outcome).toEqual({ kind: "invalid" });
  });
});

describe("docs/security-spec.md §4.2 · decideRefreshOutcome — sesión revocada o vencida", () => {
  it("sesión con revoked_at → invalid, sin importar el estado del token", () => {
    const outcome = decideRefreshOutcome({
      token: { consumedAt: null },
      session: { revokedAt: NOW - ONE_HOUR_MS, expiresAt: NOW + ONE_HOUR_MS },
      now: NOW,
    });

    expect(outcome).toEqual({ kind: "invalid" });
  });

  it("sesión con expires_at en el pasado → invalid", () => {
    const outcome = decideRefreshOutcome({
      token: { consumedAt: null },
      session: { revokedAt: null, expiresAt: NOW - 1 },
      now: NOW,
    });

    expect(outcome).toEqual({ kind: "invalid" });
  });

  it("expires_at exactamente en `now` cuenta como vencida (ventana absoluta cerrada, no abierta)", () => {
    const outcome = decideRefreshOutcome({
      token: { consumedAt: null },
      session: { revokedAt: null, expiresAt: NOW },
      now: NOW,
    });

    expect(outcome).toEqual({ kind: "invalid" });
  });

  it("un token ya consumido sobre una sesión vencida es invalid, no reuse_detected — la ventana cerrada gana", () => {
    const outcome = decideRefreshOutcome({
      token: { consumedAt: NOW - ONE_HOUR_MS },
      session: { revokedAt: null, expiresAt: NOW - 1 },
      now: NOW,
    });

    expect(outcome).toEqual({ kind: "invalid" });
  });
});

describe("docs/security-spec.md §4.2 · decideRefreshOutcome — reúso: reusar un token ya consumido invalida la familia", () => {
  it("token con consumed_at, sesión viva → reuse_detected", () => {
    const outcome = decideRefreshOutcome({
      token: { consumedAt: NOW - 1000 },
      session: { revokedAt: null, expiresAt: NOW + ONE_HOUR_MS },
      now: NOW,
    });

    expect(outcome).toEqual({ kind: "reuse_detected" });
  });
});

describe("docs/security-spec.md §4.2 · decideRefreshOutcome — camino feliz", () => {
  it("token sin consumir, sesión viva y sin revocar → rotate", () => {
    const outcome = decideRefreshOutcome({
      token: { consumedAt: null },
      session: { revokedAt: null, expiresAt: NOW + ONE_HOUR_MS },
      now: NOW,
    });

    expect(outcome).toEqual({ kind: "rotate" });
  });
});
