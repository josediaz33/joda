// Result<T, E> para fallos que el negocio contempla (docs/domain-contracts.md
// §4.1). Los invariantes violados —bugs, no fallos de negocio— se lanzan
// como excepción de errors.ts; no viven acá.
import type { DomainError } from "./errors.js";

export type Result<T, E = DomainError> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
