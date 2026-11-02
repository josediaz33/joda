import { describe, expect, it } from "vitest";
import {
  RESERVATION_RELEASE_INTERVAL_MS,
  nodeTimers,
  startPeriodicTasks,
  type TimerPort,
} from "./scheduler.js";

// RN-RES-04: "un trabajo programado libera las reservas vencidas". Esta prueba es
// del temporizador, no de la liberación (`reservations.integration.test.ts`): maneja
// el tiempo a mano con un `TimerPort`, sin dormir y sin relojes falsos globales.
function manualTimers() {
  const callbacks = new Map<number, { callback: () => void; ms: number }>();
  let next = 0;
  const port: TimerPort = {
    setInterval(callback, ms) {
      const handle = ++next;
      callbacks.set(handle, { callback, ms });
      return handle;
    },
    clearInterval(handle) {
      callbacks.delete(handle as number);
    },
  };
  return {
    port,
    registered: () => [...callbacks.values()].map((entry) => entry.ms),
    tick: () => callbacks.forEach((entry) => entry.callback()),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const logger = (errors: Record<string, unknown>[] = []) => ({
  error: (details: Record<string, unknown>) => {
    errors.push(details);
  },
});

describe("RN-RES-04 · las reservas vencidas se liberan en menos de 5 minutos", () => {
  it("el intervalo es de un minuto, para que ninguna espere los cinco", () => {
    expect(RESERVATION_RELEASE_INTERVAL_MS).toBe(60_000);
  });
});

describe("RN-RES-04 · tareas periódicas del proceso de la API (docs/api-conventions.md §8.3)", () => {
  it("programa cada tarea con su intervalo y la corre en cada vuelta", async () => {
    const timers = manualTimers();
    let runs = 0;
    startPeriodicTasks([{ name: "liberar", intervalMs: 60_000, run: async () => void runs++ }], {
      timers: timers.port,
      logger: logger(),
    });

    expect(timers.registered()).toEqual([60_000]);
    timers.tick();
    await flush();
    timers.tick();
    await flush();

    expect(runs).toBe(2);
  });

  it("no se superpone: si la corrida anterior sigue en curso, esa vuelta se salta", async () => {
    const timers = manualTimers();
    let runs = 0;
    let finish: () => void = () => undefined;
    startPeriodicTasks(
      [
        {
          name: "lenta",
          intervalMs: 60_000,
          run: () => {
            runs++;
            return new Promise<void>((resolve) => {
              finish = resolve;
            });
          },
        },
      ],
      { timers: timers.port, logger: logger() },
    );

    timers.tick();
    timers.tick();
    timers.tick();
    expect(runs).toBe(1);

    finish();
    await flush();
    timers.tick();
    expect(runs).toBe(2);
  });

  it("una corrida que falla se anota y la tarea sigue programada: el proceso no se cae", async () => {
    const timers = manualTimers();
    const errors: Record<string, unknown>[] = [];
    let runs = 0;
    startPeriodicTasks(
      [
        {
          name: "frágil",
          intervalMs: 60_000,
          run: async () => {
            runs++;
            throw new Error("se cayó la red");
          },
        },
      ],
      { timers: timers.port, logger: logger(errors) },
    );

    timers.tick();
    await flush();
    timers.tick();
    await flush();

    expect(runs).toBe(2);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ task: "frágil" });
  });

  it("una tarea que lanza en seco (antes de devolver la promesa) tampoco tumba nada", async () => {
    const timers = manualTimers();
    const errors: Record<string, unknown>[] = [];
    startPeriodicTasks(
      [
        {
          name: "síncrona",
          intervalMs: 60_000,
          run: () => {
            throw new Error("falla enseguida");
          },
        },
      ],
      { timers: timers.port, logger: logger(errors) },
    );

    timers.tick();
    await flush();

    expect(errors).toHaveLength(1);
  });

  it("stop() deja de programar: el temporizador se cancela", () => {
    const timers = manualTimers();
    const scheduler = startPeriodicTasks(
      [{ name: "liberar", intervalMs: 60_000, run: async () => undefined }],
      { timers: timers.port, logger: logger() },
    );

    scheduler.stop();

    expect(timers.registered()).toEqual([]);
  });

  it("los temporizadores reales no retienen al proceso (unref) y se pueden cancelar", () => {
    const handle = nodeTimers.setInterval(() => undefined, 60_000);

    expect((handle as { hasRef(): boolean }).hasRef()).toBe(false);
    nodeTimers.clearInterval(handle);
  });
});
