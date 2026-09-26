// cc-haha adaptation of pi-vcc's global-indices.ts (0.8.0).
//
// pi numbers every `type === "message"` entry in the session file by
// `entry.id`. cc-haha's session JSONL lines ARE the messages
// (`type: "user" | "assistant"` with a `uuid`), so the counting rule is:
//
//   #N = the 0-based position of a user/assistant line among all
//        user/assistant lines in the session file, in file order.
//
// Both the compaction summary (which renders `(#N)` refs) and the
// vcc_recall tool must use this exact rule so refs resolve.
import { forEachJsonlLine } from "./vendor/core/jsonl"

const isCountedCcLine = (line: any): boolean =>
  (line?.type === "user" || line?.type === "assistant") &&
  line?.message != null

const createBuilder = () => {
  const byUuid = new Map<string, number>()
  const ambiguous = new Set<string>()
  let index = 0
  return {
    add(line: any) {
      if (!isCountedCcLine(line)) return
      const id = typeof line?.uuid === "string" ? line.uuid : ""
      if (id) {
        // Duplicate ids are ambiguous — dropped fail-closed so callers
        // emit no ref instead of a wrong one (same policy as pi-vcc).
        if (byUuid.has(id) || ambiguous.has(id)) {
          byUuid.delete(id)
          ambiguous.add(id)
        } else {
          byUuid.set(id, index)
        }
      }
      index++
    },
    map: () => byUuid,
  }
}

/** Build the uuid → `#N` map from parsed JSONL lines (or message rows). */
export const buildCcGlobalIndexByUuid = (
  lines: readonly any[],
): Map<string, number> => {
  const b = createBuilder()
  for (const l of lines) b.add(l)
  return b.map()
}

/**
 * Build the same map by streaming a session JSONL file (chunked, so giant
 * sessions stay within memory bounds). Returns undefined when the file
 * cannot be read (missing or IO error).
 */
export const loadCcGlobalIndexByUuid = (
  sessionFile: string,
): Map<string, number> | undefined => {
  const b = createBuilder()
  let ok: boolean
  try {
    ok = forEachJsonlLine(sessionFile, (line) => {
      if (line.length === 0) return
      try {
        b.add(JSON.parse(line.toString("utf8")))
      } catch {
        // Corrupt lines are silently dropped.
      }
    })
  } catch {
    return undefined
  }
  return ok ? b.map() : undefined
}
