import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { appError, isApiError, isPgError, mapPgError, toTRPCError } from "./errorMapper.js";

// No hay una RN-XXX que citar: esto es la convención de frontera de
// docs/api-conventions.md §4 (forma del error, familias de código,
// traducción por ERRCODE), no una regla de negocio del dominio — mismo caso
// que ya reconoce .claude/rules/testing.md para packages/contracts (WP-A11).
describe("mapPgError — traducción por ERRCODE (api-conventions.md §4.4)", () => {
  it("23514 (check_violation) es CONFLICT_CHECK_VIOLATION, 409, en español", () => {
    const result = mapPgError({ code: "23514", message: "violates check constraint" });

    expect(result).toEqual({
      code: "CONFLICT_CHECK_VIOLATION",
      httpStatus: 409,
      message: "Los datos no cumplen una restricción del sistema.",
    });
  });

  it("23505 (unique_violation) es CONFLICT_DUPLICATE, 409", () => {
    const result = mapPgError({ code: "23505", message: "duplicate key value" });

    expect(result).toEqual({
      code: "CONFLICT_DUPLICATE",
      httpStatus: 409,
      message: "Ya existe un registro con esos datos.",
    });
  });

  it("23503 (foreign_key_violation) es CONFLICT_FOREIGN_KEY, 409", () => {
    const result = mapPgError({ code: "23503", message: "violates foreign key constraint" });

    expect(result).toEqual({
      code: "CONFLICT_FOREIGN_KEY",
      httpStatus: 409,
      message: "El registro referenciado no existe o fue eliminado.",
    });
  });

  it("2F004 (ledger inmutable) es CONFLICT_IMMUTABLE_LEDGER, 409", () => {
    const result = mapPgError({ code: "2F004", message: "reading sql-data not permitted" });

    expect(result).toEqual({
      code: "CONFLICT_IMMUTABLE_LEDGER",
      httpStatus: 409,
      message: "Este registro es de solo lectura y no se puede modificar.",
    });
  });

  it("un ERRCODE sin mapeo explícito cae a INTERNAL, 500, sin filtrar el mensaje de Postgres", () => {
    const result = mapPgError({ code: "53200", message: "out of memory" });

    expect(result.code).toBe("INTERNAL");
    expect(result.httpStatus).toBe(500);
    expect(result.message).not.toContain("out of memory");
  });

  it("sin código (no es un error de Postgres) también cae a INTERNAL, 500", () => {
    const result = mapPgError({ message: "algo raro" });

    expect(result.code).toBe("INTERNAL");
    expect(result.httpStatus).toBe(500);
  });
});

describe("isPgError — reconoce la forma de DatabaseError de `pg` (api-conventions.md §4.4)", () => {
  it("acepta un ERRCODE (SQLSTATE) de cinco caracteres", () => {
    expect(isPgError({ code: "23514", message: "x" })).toBe(true);
  });

  it("rechaza un error sin código", () => {
    expect(isPgError(new Error("boom"))).toBe(false);
  });

  it("rechaza un código que no tiene forma de SQLSTATE", () => {
    expect(isPgError({ code: "NOT_FOUND" })).toBe(false);
  });

  it("rechaza valores que no son objetos", () => {
    expect(isPgError("23514")).toBe(false);
    expect(isPgError(null)).toBe(false);
  });
});

describe("appError / isApiError — forma del ApiError (api-conventions.md §4.1)", () => {
  it("appError arma el objeto sin `details` cuando no se pasan", () => {
    expect(appError("CONFLICT_DUPLICATE", 409, "Ya existe.")).toEqual({
      code: "CONFLICT_DUPLICATE",
      httpStatus: 409,
      message: "Ya existe.",
    });
  });

  it("appError incluye `details` cuando se pasan", () => {
    const result = appError("CONFLICT_DUPLICATE", 409, "Ya existe.", { field: "sku" });

    expect(result.details).toEqual({ field: "sku" });
  });

  it("isApiError distingue un ApiError de un error cualquiera", () => {
    expect(isApiError(appError("INTERNAL", 500, "x"))).toBe(true);
    expect(isApiError(new Error("boom"))).toBe(false);
    expect(isApiError(null)).toBe(false);
  });
});

describe("toTRPCError — httpStatus del ApiError al código nativo de tRPC (api-conventions.md §4.2)", () => {
  it("409 se convierte en CONFLICT, con el ApiError reconocible en cause", () => {
    const apiError = mapPgError({ code: "23514", message: "x" });
    const trpcError = toTRPCError(apiError);

    // TRPCError envuelve un `cause` que no es instancia de Error en un
    // UnknownCauseError propio (@trpc/server, getCauseFromUnknown) — copia
    // las propiedades, no la referencia. `isApiError` (duck typing) es lo
    // que el errorFormatter de trpc.ts usa para reconocerlo igual.
    expect(trpcError).toBeInstanceOf(TRPCError);
    expect(trpcError.code).toBe("CONFLICT");
    expect(trpcError.message).toBe(apiError.message);
    expect(isApiError(trpcError.cause)).toBe(true);
    expect(trpcError.cause).toMatchObject(apiError);
  });

  it("500 (sin mapeo conocido) se convierte en INTERNAL_SERVER_ERROR", () => {
    const trpcError = toTRPCError(appError("INTERNAL", 500, "x"));

    expect(trpcError.code).toBe("INTERNAL_SERVER_ERROR");
  });
});
