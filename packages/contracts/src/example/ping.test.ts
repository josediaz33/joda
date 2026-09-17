import { describe, expect, it } from "vitest";
import { createExampleCaller } from "./ping.js";

// Criterio de aceptación de WP-A11: "un procedimiento de ejemplo tipado
// extremo a extremo compila" (docs/backlog.md). Este test no verifica una
// regla de negocio (no hay RN-XXX que citar): confirma que el patrón
// Zod (packages/contracts) + tRPC compila y funciona en tiempo de
// ejecución, no solo en el chequeo de tipos.
describe("exampleRouter.ping.list — tipado extremo a extremo (api-conventions.md §1, §3, §6)", () => {
  it("devuelve un ítem cuyo importe llega como string, no como number", async () => {
    const caller = createExampleCaller({});
    const result = await caller.ping.list({});

    expect(result.items).toHaveLength(1);
    expect(typeof result.items[0]?.price.minor).toBe("string");
  });

  it("una segunda página (con cursor) llega vacía en este ejemplo", async () => {
    const caller = createExampleCaller({});
    const result = await caller.ping.list({ cursor: "cualquiera" });

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("rechaza un límite fuera del rango de paginationInputSchema", async () => {
    const caller = createExampleCaller({});

    await expect(caller.ping.list({ limit: 99999 })).rejects.toThrow();
  });
});
