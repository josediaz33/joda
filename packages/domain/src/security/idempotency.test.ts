import { describe, expect, it } from "vitest";
import { decideIdempotencyOutcome } from "./idempotency.js";

describe("docs/api-conventions.md §5 · decideIdempotencyOutcome — sin clave previa", () => {
  it("no hay ningún registro para (tenant_id, scope, key) → run", () => {
    const outcome = decideIdempotencyOutcome({
      existing: null,
      requestHash: "hash-a",
    });

    expect(outcome).toEqual({ kind: "run" });
  });
});

describe("docs/api-conventions.md §5 · decideIdempotencyOutcome — misma clave, mismo cuerpo", () => {
  it("el hash del cuerpo coincide → replay con la respuesta y el código guardados, sin reprocesar", () => {
    const outcome = decideIdempotencyOutcome({
      existing: { requestHash: "hash-a", response: { orderId: "123" }, statusCode: 200 },
      requestHash: "hash-a",
    });

    expect(outcome).toEqual({
      kind: "replay",
      response: { orderId: "123" },
      statusCode: 200,
    });
  });
});

describe("docs/api-conventions.md §5 · decideIdempotencyOutcome — misma clave, cuerpo distinto", () => {
  it("el hash del cuerpo no coincide → conflict, sin exponer la respuesta guardada", () => {
    const outcome = decideIdempotencyOutcome({
      existing: { requestHash: "hash-a", response: { orderId: "123" }, statusCode: 200 },
      requestHash: "hash-b",
    });

    expect(outcome).toEqual({ kind: "conflict" });
  });
});
