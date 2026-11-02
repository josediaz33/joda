// Tareas periódicas del proceso de la API (WP-C18b). Hasta acá no había ninguna:
// el primer trabajo es la liberación de reservas vencidas (RN-RES-04).
//
// Un temporizador por tarea, sin dependencias. Los temporizadores entran por
// parámetro (`TimerPort`) para que la prueba maneje el tiempo a mano, sin dormir
// ni usar relojes falsos globales. Dos garantías que importan:
//
//   · NO se superpone. Si una corrida sigue en curso cuando vence el intervalo,
//     esa vuelta se salta: dos corridas del mismo trabajo a la vez no ganan nada
//     y se disputan las mismas filas.
//   · NO tumba el proceso. Una corrida que falla se anota y el temporizador
//     sigue: un trabajo de fondo que mata a la API por un error de red es peor
//     que el error.
//
// Varias instancias de la API corren cada una su temporizador: el trabajo tiene
// que ser seguro frente a otra corrida concurrente (el de las reservas lo es:
// `SKIP LOCKED`).

export interface TimerPort {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const nodeTimers: TimerPort = {
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms);
    // El temporizador de un trabajo de fondo no debe impedir que el proceso termine.
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface PeriodicTask {
  readonly name: string;
  readonly intervalMs: number;
  readonly run: () => Promise<unknown>;
}

export interface SchedulerLogger {
  error(details: Record<string, unknown>, message: string): void;
}

export interface RunningScheduler {
  /** Deja de programar corridas nuevas. Una en curso termina sola. */
  stop(): void;
}

/** RN-RES-04: "libera las reservas vencidas" en menos de 5 minutos. Una vuelta por minuto. */
export const RESERVATION_RELEASE_INTERVAL_MS = 60_000;

export function startPeriodicTasks(
  tasks: readonly PeriodicTask[],
  deps: { readonly timers: TimerPort; readonly logger: SchedulerLogger },
): RunningScheduler {
  const handles = tasks.map((task) => {
    let running = false;
    return deps.timers.setInterval(() => {
      if (running) return;
      running = true;
      // Una tarea que lanza en seco (antes de devolver la promesa) no tiene que escapar
      // del callback del temporizador: sería una excepción sin atrapar y tumbaría el proceso.
      let started: Promise<unknown>;
      try {
        started = Promise.resolve(task.run());
      } catch (error) {
        started = Promise.reject(error);
      }
      void started
        .catch((error: unknown) => {
          deps.logger.error({ task: task.name, error }, "falló una corrida de la tarea periódica");
        })
        .finally(() => {
          running = false;
        });
    }, task.intervalMs);
  });

  return {
    stop() {
      for (const handle of handles) deps.timers.clearInterval(handle);
    },
  };
}
