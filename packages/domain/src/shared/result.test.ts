import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.js";
import { err, ok } from "./result.js";

describe("Result — docs/domain-contracts.md §4.1", () => {
  it("ok() produce un resultado exitoso con el valor", () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it("err() produce un resultado fallido con el error", () => {
    const error = new DomainError("X", "x");

    expect(err(error)).toEqual({ ok: false, error });
  });
});
