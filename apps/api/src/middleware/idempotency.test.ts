import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  API_IDEMPOTENCY_SCOPE,
  buildIdempotencyRequest,
  hashIdempotencyRequestBody,
  readIdempotencyKeyHeader,
} from "./idempotency.js";

function fakeRequest(headers: Record<string, string | string[] | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

describe("docs/api-conventions.md §5 · readIdempotencyKeyHeader", () => {
  it("sin el header → null", () => {
    expect(readIdempotencyKeyHeader(fakeRequest({}))).toBeNull();
  });

  it("con el header en minúscula (como lo normaliza Fastify) → el valor", () => {
    expect(readIdempotencyKeyHeader(fakeRequest({ "idempotency-key": "01J8XKQ7ZN" }))).toBe(
      "01J8XKQ7ZN",
    );
  });

  it("header vacío → null, no una clave vacía", () => {
    expect(readIdempotencyKeyHeader(fakeRequest({ "idempotency-key": "" }))).toBeNull();
  });
});

describe("docs/api-conventions.md §5 · hashIdempotencyRequestBody — detecta reuso de clave con cuerpo distinto", () => {
  it("el mismo objeto serializado en distinto orden de claves da el mismo hash", () => {
    const a = hashIdempotencyRequestBody({ orderId: "1", paymentMethod: "cash" });
    const b = hashIdempotencyRequestBody({ paymentMethod: "cash", orderId: "1" });

    expect(a).toBe(b);
  });

  it("un cuerpo con un valor distinto da un hash distinto", () => {
    const a = hashIdempotencyRequestBody({ orderId: "1" });
    const b = hashIdempotencyRequestBody({ orderId: "2" });

    expect(a).not.toBe(b);
  });

  it("objetos anidados y arrays también se canonicalizan", () => {
    const a = hashIdempotencyRequestBody({ lines: [{ sku: "A", qty: 1 }], meta: { note: "x" } });
    const b = hashIdempotencyRequestBody({ meta: { note: "x" }, lines: [{ qty: 1, sku: "A" }] });

    expect(a).toBe(b);
  });
});

describe("docs/api-conventions.md §5 · buildIdempotencyRequest", () => {
  it("sin header → null, la mutación corre sin idempotencia", () => {
    expect(buildIdempotencyRequest(fakeRequest({}), { orderId: "1" })).toBeNull();
  });

  it("con header → scope 'api', la clave del header y el hash del input", () => {
    const request = buildIdempotencyRequest(fakeRequest({ "idempotency-key": "clave-1" }), {
      orderId: "1",
    });

    expect(request).toEqual({
      scope: API_IDEMPOTENCY_SCOPE,
      key: "clave-1",
      requestHash: hashIdempotencyRequestBody({ orderId: "1" }),
    });
  });
});
