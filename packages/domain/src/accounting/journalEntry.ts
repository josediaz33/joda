// Máquina de estados del asiento contable (WP-B14; docs/domain-rules.md
// RN-CTB-06, docs/domain-contracts.md §6.5).
//
// Camino: draft → posted → reversed
//
// - `draft` admite ediciones (draft → draft) y se contabiliza. No se
//   revierte: un borrador que no va, se borra.
// - `posted` es inmutable. Su única salida es `reversed`, y la base además
//   exige un asiento de reversión ya contabilizado que lo referencie por
//   `reverses_id` (packages/db/migrations/0020_journal_immutability.sql).
//   Esa precondición depende de otra fila, así que no cabe en este mapa;
//   quien arme la reversión la cumple contabilizando primero el inverso.
// - `reversed` es terminal.
//
// El mismo mapa lo impone `app.guard_journal_entry()` en la base: la
// inmutabilidad del libro contable es un invariante (ADR-017), y este
// archivo es el que la aplicación consulta antes de intentar la
// transición.
import { defineStateMachine, type TransitionError } from "../shared/stateMachine.js";

export type JournalEntryStatus = "draft" | "posted" | "reversed";

export const JOURNAL_ENTRY_TRANSITIONS: Readonly<
  Record<JournalEntryStatus, readonly JournalEntryStatus[]>
> = {
  draft: ["draft", "posted"],
  posted: ["reversed"],
  reversed: [],
};

const machine = defineStateMachine(JOURNAL_ENTRY_TRANSITIONS);

/** Ver el comentario homólogo en procurement/purchaseOrder.ts sobre el sufijo del nombre. */
export const canTransitionJournalEntry = machine.canTransition;
export const transitionJournalEntry = machine.transition;
export type JournalEntryTransitionError = TransitionError<JournalEntryStatus>;
