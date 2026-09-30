import { randomUUID } from "node:crypto";
import type { IdGenerator } from "@joda/domain";

// Implementación real del puerto IdGenerator (packages/domain/src/shared/
// ports.ts). Vive en apps/api, no en packages/domain: la aleatoriedad es una
// impureza que el dominio tiene prohibido tocar directo
// (.claude/rules/domain.md: nada de `crypto.randomUUID`). Primer uso real:
// la apertura de frasco (WP-C11), donde el dominio necesita los ids de los
// lotes que nacen antes de que existan como filas, para que los movimientos
// ya apunten a ellos.
export const uuidGenerator: IdGenerator = {
  next: () => randomUUID(),
};
