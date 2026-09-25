import { describe, expect, it } from "vitest";
import {
  canTransitionJournalEntry,
  transitionJournalEntry,
  type JournalEntryStatus,
} from "./journalEntry.js";

// Matriz completa: los 3 estados de journal_status (packages/db/
// migrations/0001_foundation.sql) contra sí mismos, 3×3 = 9 pares. Es la
// misma regla que impone app.guard_journal_entry() (0020).
describe("RN-CTB-06 · asiento contable — matriz completa de transiciones", () => {
  it.each([
    ["draft", "draft", true],
    ["draft", "posted", true],
    ["draft", "reversed", false],
    ["posted", "draft", false],
    ["posted", "posted", false],
    ["posted", "reversed", true],
    ["reversed", "draft", false],
    ["reversed", "posted", false],
    ["reversed", "reversed", false],
  ] satisfies [JournalEntryStatus, JournalEntryStatus, boolean][])(
    "%s → %s es %s",
    (from, to, expected) => {
      expect(canTransitionJournalEntry(from, to)).toBe(expected);
    },
  );
});

describe("RN-CTB-06 · un asiento contabilizado no se modifica, se reversa", () => {
  it("posted no vuelve a draft: reabrirlo para editarlo es un fallo contemplado", () => {
    expect(transitionJournalEntry("posted", "draft")).toEqual({
      ok: false,
      error: { code: "INVALID_TRANSITION", from: "posted", to: "draft" },
    });
  });

  it("posted pasa a reversed", () => {
    expect(transitionJournalEntry("posted", "reversed")).toEqual({ ok: true, value: "reversed" });
  });
});
