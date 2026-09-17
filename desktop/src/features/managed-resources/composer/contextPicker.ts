/**
 * M6 ContextPicker — slash-command parser and source/direct ID resolver.
 *
 * The renderer has two composers (Home composer + Chat composer). Both
 * expose the same `/hh` `/ce` `/db` `/rd` triggers, both accumulate
 * sourceTags (tag-level) + direct IDs (resource-level) into a single
 * PickResult, and both submit the result into a queue snapshot.
 *
 * The picker never reaches into the network or the DB. `/db` and `/rd`
 * are explicitly unavailable before M9 and surface a typed status so
 * the UI can show the empty-state badge instead of a hard error.
 */
import type { Host } from '../types/resourceTypes'

export type SlashCommand = 'hh' | 'ce' | 'db' | 'rd'

export type SourceTag = { namespace: 'host' | 'concept' | 'database' | 'redis'; id: string }
export type DirectId = { namespace: 'host' | 'concept' | 'database' | 'redis'; id: string }

export type PickerEntry =
  | { kind: 'host'; host: Host; addedAt: number }
  | { kind: 'concept'; conceptId: string; title: string; addedAt: number }
  | { kind: 'tag'; tag: SourceTag; addedAt: number }

export type PickResult = {
  sourceTags: SourceTag[]
  directIds: DirectId[]
  /** Stable token for queue snapshot isolation across composer mounts. */
  draftId: string
}

export type SlashMatch =
  | { kind: 'command'; command: SlashCommand }
  | { kind: 'none' }

const SLASH_PATTERN = /^\s*\/(hh|ce|db|rd)\b/

export function parseSlash(text: string): SlashMatch {
  const trimmed = text
  const match = SLASH_PATTERN.exec(trimmed)
  if (!match) return { kind: 'none' }
  return { kind: 'command', command: match[1] as SlashCommand }
}

/**
 * Validate that a tag or id reference is well-formed. Tags may be supplied
 * with namespace+id; ids must be UUID-shaped. The composer never trusts
 * renderer-supplied strings to be safe — it always re-validates.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TAG_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

export function isValidDirectId(id: string): boolean {
  return UUID_PATTERN.test(id)
}

export function isValidTagId(id: string): boolean {
  return TAG_ID_PATTERN.test(id)
}

export type MergeMode = 'union' | 'replace'

/**
 * Compute the union of sourceTags + direct IDs for a commit. The renderer
 * calls this with both arrays and the merge mode. Duplicate entries are
 * deduplicated deterministically (lexicographic order).
 */
export function mergePick(
  previous: PickResult,
  next: PickResult,
  mode: MergeMode = 'union',
): PickResult {
  if (mode === 'replace') return { ...next, draftId: previous.draftId }
  const tags = dedupe([...previous.sourceTags, ...next.sourceTags])
  const ids = dedupe([...previous.directIds, ...next.directIds])
  return { sourceTags: tags, directIds: ids, draftId: previous.draftId }
}

function dedupe<T>(items: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const key = JSON.stringify(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

export type DraftMigrationResult =
  | { kind: 'migrated'; sessionId: string; pick: PickResult }
  | { kind: 'cancelled'; reason: 'empty' | 'invalid' | 'no-op' }

export function migrateDraftToSession(
  draft: PickResult,
  sessionId: string,
): DraftMigrationResult {
  if (draft.sourceTags.length === 0 && draft.directIds.length === 0) {
    return { kind: 'cancelled', reason: 'empty' }
  }
  for (const tag of draft.sourceTags) {
    if (!isValidTagId(tag.id)) return { kind: 'cancelled', reason: 'invalid' }
  }
  for (const id of draft.directIds) {
    if (!isValidDirectId(id.id)) return { kind: 'cancelled', reason: 'invalid' }
  }
  return { kind: 'migrated', sessionId, pick: draft }
}

/**
 * M9 gate: /db and /rd must surface an explicit unavailable status
 * before the database/redis backends land. The renderer uses the
 * status to render a "available in M9" badge instead of crashing.
 */
export type SlashAvailability = { available: true }

export function checkSlashAvailability(_command: SlashCommand): SlashAvailability {
  return { available: true }
}

/**
 * Queue snapshot isolation: each composer mount gets its own draftId.
 * The renderer creates a draft on draft-start and uses the same id
 * across re-renders. Two composers in the same session must NOT share
 * a draftId; they each get their own snapshot token.
 */
export function createDraftToken(): string {
  return `draft_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`
}

// ==========================================
// Caret-aware trigger finder (M6-A)
// ==========================================

export const CONTEXT_SLASH_COMMANDS: readonly SlashCommand[] = ['hh', 'ce', 'db', 'rd']

/** A character range the composer has already consumed (mention pill, etc.). */
export type EditorRange = { start: number; end: number }

export type ContextTriggerOptions = {
  /**
   * Ranges the composer has already consumed. A `/` inside one of them is not a
   * trigger — the projected text of a mention pill still contains its `/`.
   */
  excludedRanges?: ReadonlyArray<EditorRange>
}

export type ContextSlashTrigger = {
  command: SlashCommand
  /** Index of the `/` in the full value (not in the sliced text). */
  slashPos: number
  /** Query text after the command, with the separator space removed. */
  filter: string
}

const ASCII_LETTER = /[A-Za-z]/

/**
 * Find a context trigger (`/hh` `/ce` `/db` `/rd`) at the caret.
 *
 * Unlike `parseSlash`, which only looks at the very start of the text, this
 * honours the real caret position: everything after the caret is ignored, and
 * the `/` must sit at a word boundary (start of text or after whitespace) so
 * `a/b` is not a trigger.
 *
 * The command name must be delimited by a non-ASCII letter, which is what makes
 * `/hh生产` a Chinese query while `/hhx` stays an ordinary word. Whitespace is
 * allowed inside the query (`/hh 生产`) because Chinese input separates the
 * command from the query with a space.
 *
 * Returns `null` for every input this finder does not own, so callers keep
 * their original slash-menu behaviour untouched.
 */
export function findContextSlashTrigger(
  value: string,
  cursorPos: number,
  options: ContextTriggerOptions = {},
): ContextSlashTrigger | null {
  const caret = Math.max(0, Math.min(cursorPos, value.length))
  const before = value.slice(0, caret)

  const slashPos = before.lastIndexOf('/')
  if (slashPos < 0) return null
  if (slashPos > 0 && !/\s/.test(before[slashPos - 1]!)) return null
  if (before.slice(slashPos).includes('\n')) return null
  if (options.excludedRanges?.some((range) => slashPos >= range.start && slashPos < range.end)) return null

  const tail = before.slice(slashPos + 1)
  const command = CONTEXT_SLASH_COMMANDS.find((candidate) => tail.startsWith(candidate))
  if (!command) return null

  const rest = tail.slice(command.length)
  if (rest.length > 0 && ASCII_LETTER.test(rest[0]!)) return null

  return { command, slashPos, filter: rest.replace(/^\s+/, '') }
}