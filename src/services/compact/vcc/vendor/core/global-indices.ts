// Vendored from @sting8k/pi-vcc@0.8.0 (MIT). Do not edit by hand.
// @ts-nocheck
/**
 * Session-global message indices — the single definition of the `#N` index space.
 *
 * Recall (`src/core/load-messages.ts`) numbers every `type == "message"` entry
 * in session-file order, counting across compaction windows and abandoned
 * branches. Compaction summaries must emit the same numbers, but `normalize`
 * historically numbered the selected window from zero. This module owns the
 * counting rule so both sides agree by construction.
 *
 * Ported from k0valik/pi-blackhole commit f82e07a (issue #28); the file
 * fallback streams via forEachJsonlLine instead of readFileSync so giant
 * sessions stay within PR #26's memory bounds.
 */
import { forEachJsonlLine } from "./jsonl";

/** Entries counted by the global `#N` index: persisted message entries. */
export const isCountedMessageEntry = (entry: any): boolean =>
  entry?.type === "message" && entry.message != null;

/**
 * Accumulates the id → global-index mapping one entry at a time so both the
 * in-memory array path and the streaming file path share one counting rule.
 *
 * Entries without a usable id are still counted (they occupy an index) but
 * produce no map entry. Duplicate ids are ambiguous — dropped fail-closed so
 * callers emit no ref instead of a wrong one.
 */
const createGlobalIndexBuilder = () => {
  const byId = new Map<string, number>();
  const ambiguous = new Set<string>();
  let messageIndex = 0;
  return {
    add(entry: any) {
      if (!isCountedMessageEntry(entry)) return;
      const id = entry?.id;
      if (typeof id === "string" && id.length > 0) {
        if (byId.has(id) || ambiguous.has(id)) {
          byId.delete(id);
          ambiguous.add(id);
        } else {
          byId.set(id, messageIndex);
        }
      }
      messageIndex++;
    },
    map: () => byId,
  };
};

/**
 * Map session entry ids to their global message index (position among counted
 * message entries in array order, which matches session-file order).
 */
export const buildGlobalIndexById = (entries: readonly any[]): Map<string, number> => {
  const b = createGlobalIndexBuilder();
  for (const entry of entries) b.add(entry);
  return b.map();
};

/**
 * Build the same map by streaming a session JSONL file. Malformed lines are
 * skipped silently (load-messages already skips them). Returns undefined when
 * the file cannot be read (missing or IO error).
 */
export const loadGlobalIndexById = (sessionFile: string): Map<string, number> | undefined => {
  const b = createGlobalIndexBuilder();
  let ok: boolean;
  try {
    ok = forEachJsonlLine(sessionFile, (line) => {
      if (line.length === 0) return;
      try {
        b.add(JSON.parse(line.toString("utf8")));
      } catch {
        // Corrupt lines are silently dropped by pi too.
      }
    });
  } catch {
    return undefined;
  }
  return ok ? b.map() : undefined;
};
