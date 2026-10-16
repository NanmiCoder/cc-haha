/**
 * Run-specific values (the throwaway work dir, the sandbox config dir, session
 * ids) differ between the recording run and every replay. A recording stores
 * them as `{{NAME}}` placeholders and a replay expands them to its own values.
 *
 * A model streams a path in fragments, and a fragment boundary can fall inside
 * the path. So normalisation works on each streamed value as a whole: it joins
 * the fragments, replaces the values, and moves any boundary that fell inside a
 * replaced value to its end. Every placeholder then sits whole inside one
 * fragment, and a replay can expand fragment by fragment while keeping the real
 * chunking.
 */

import { fingerprintRequest, fragmentRefs, type ApiFormat, type RequestFingerprint, type SseEvent } from './wire'

export type PlaceholderTable = Array<{ name: string; values: string[] }>

const PLACEHOLDER = /\{\{([A-Z][A-Z0-9_]*)\}\}/g

function jsonEscaped(value: string) {
  return JSON.stringify(value).slice(1, -1)
}

/** `/var/x` and `/private/var/x` name the same macOS directory; a recording must catch both. */
export function pathVariants(path: string): string[] {
  const variants = new Set([path])
  if (path.startsWith('/private/')) variants.add(path.slice('/private'.length))
  else if (/^\/(var|tmp|etc)\//.test(path)) variants.add(`/private${path}`)
  return [...variants]
}

type Match = { start: number; end: number; replacement: string }

function findMatches(text: string, table: PlaceholderTable, jsonString: boolean): Match[] {
  const needles = table
    .flatMap(({ name, values }) => values.filter(Boolean).flatMap((value) => {
      const forms = jsonString ? [jsonEscaped(value), value] : [value]
      return [...new Set(forms)].map((form) => ({ form, replacement: `{{${name}}}` }))
    }))
    // Longest first, so a work dir wins over the temp dir that contains it.
    .sort((a, b) => b.form.length - a.form.length)
  const matches: Match[] = []
  for (const { form, replacement } of needles) {
    let from = 0
    while (true) {
      const start = text.indexOf(form, from)
      if (start === -1) break
      const end = start + form.length
      if (!matches.some((match) => start < match.end && end > match.start)) {
        matches.push({ start, end, replacement })
      }
      from = start + 1
    }
  }
  return matches.sort((a, b) => a.start - b.start)
}

export function normalizeString(text: string, table: PlaceholderTable, jsonString = false): string {
  let out = ''
  let cursor = 0
  for (const match of findMatches(text, table, jsonString)) {
    out += text.slice(cursor, match.start) + match.replacement
    cursor = match.end
  }
  return out + text.slice(cursor)
}

export function expandString(text: string, values: Record<string, string>, jsonString = false): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = values[name]
    if (value === undefined) return whole
    return jsonString ? jsonEscaped(value) : value
  })
}

/**
 * Normalises one value that arrived as `fragments`, keeping one fragment per
 * original fragment and never splitting a placeholder.
 */
export function normalizeFragments(fragments: string[], table: PlaceholderTable, jsonString: boolean): string[] {
  const raw = fragments.join('')
  const matches = findMatches(raw, table, jsonString)
  if (matches.length === 0) return fragments
  // Map a raw offset to the normalised string; offsets inside a match move past it.
  const map = (offset: number) => {
    let shift = 0
    for (const match of matches) {
      if (offset <= match.start) break
      if (offset < match.end) return match.start + shift + match.replacement.length
      shift += match.replacement.length - (match.end - match.start)
    }
    return offset + shift
  }
  const normalized = normalizeString(raw, table, jsonString)
  const out: string[] = []
  let rawOffset = 0
  let previous = 0
  for (const fragment of fragments) {
    rawOffset += fragment.length
    const next = Math.max(previous, map(rawOffset))
    out.push(normalized.slice(previous, next))
    previous = next
  }
  out[out.length - 1] += normalized.slice(previous)
  return out
}

function walkStrings(value: unknown, visit: (text: string) => string): unknown {
  if (typeof value === 'string') return visit(value)
  if (Array.isArray(value)) return value.map((item) => walkStrings(item, visit))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walkStrings(child, visit)]))
  }
  return value
}

/** Normalises a recorded stream in place of a copy. */
export function normalizeEvents(format: ApiFormat, events: SseEvent[], table: PlaceholderTable): SseEvent[] {
  const copy = structuredClone(events)
  const groups = new Map<string, Array<ReturnType<typeof fragmentRefs>[number]>>()
  for (const event of copy) {
    for (const ref of fragmentRefs(format, event)) {
      const group = groups.get(ref.key) ?? []
      group.push(ref)
      groups.set(ref.key, group)
    }
  }
  for (const refs of groups.values()) {
    const normalized = normalizeFragments(refs.map((ref) => ref.get()), table, refs[0]!.jsonString)
    refs.forEach((ref, index) => ref.set(normalized[index]!))
  }
  // Anything outside a streamed value (a non-streamed body, a tool_use start).
  return copy.map((event) => ({ ...event, data: walkStrings(event.data, (text) => normalizeString(text, table)) }))
}

export function normalizeJson(value: unknown, table: PlaceholderTable): unknown {
  return walkStrings(value, (text) => normalizeString(text, table))
}

/** Expands a recorded stream for this run. JSON-text fragments get JSON-escaped values. */
export function expandEvents(format: ApiFormat, events: SseEvent[], values: Record<string, string>): SseEvent[] {
  const copy = structuredClone(events)
  for (const event of copy) {
    for (const ref of fragmentRefs(format, event)) ref.set(expandString(ref.get(), values, ref.jsonString))
  }
  return copy.map((event) => ({ ...event, data: walkStrings(event.data, (text) => expandString(text, values)) }))
}

export function expandJson(value: unknown, values: Record<string, string>): unknown {
  return walkStrings(value, (text) => expandString(text, values))
}

/** Placeholders left in an expanded value: a replay that would leak `{{WORK_ROOT}}` to the CLI. */
export function unexpandedPlaceholders(value: unknown): string[] {
  const found = new Set<string>()
  walkStrings(value, (text) => {
    for (const match of text.matchAll(PLACEHOLDER)) found.add(match[1]!)
    return text
  })
  return [...found]
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const TIMESTAMP = /(?:\{\{DATE\}\}|\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g

/**
 * A request's fingerprint with its user texts in placeholder form, comparable
 * across runs. Ids the app mints per run and nothing else names (an uploaded
 * image's file name, a teammate's session) become `{{UUID}}`, and clock times
 * the app stamps on messages (a teammate's report) become `{{TIMESTAMP}}`;
 * known ids were already replaced by their own placeholders.
 */
export function normalizedFingerprint(format: ApiFormat, body: Record<string, unknown>, table: PlaceholderTable): RequestFingerprint {
  const fingerprint = fingerprintRequest(format, body)
  const normalize = (text: string) => normalizeString(text, table).replace(UUID, '{{UUID}}').replace(TIMESTAMP, '{{TIMESTAMP}}')
  return {
    ...fingerprint,
    lastUserText: normalize(fingerprint.lastUserText),
    firstUserText: normalize(fingerprint.firstUserText),
  }
}

/**
 * Values the app mints from the clock per run and that a reply must quote back
 * verbatim, such as a teammate shutdown request id (`shutdown-<ms>@name`). A
 * generic placeholder is not enough for them: the replayed reply has to carry
 * this run's value. A recording stores them as `{{V1}}`, `{{V2}}`…, and a
 * replay learns each value from the first request that carries it.
 */
export const VOLATILE_TOKEN = /\b1[6-9]\d{11}\b/g

export function volatileTokens(texts: string[]): string[] {
  const tokens: string[] = []
  for (const text of texts) {
    for (const match of text.matchAll(VOLATILE_TOKEN)) if (!tokens.includes(match[0])) tokens.push(match[0])
  }
  return tokens
}

/**
 * Matches `actual` against a recorded `template` whose `{{Vn}}` slots are not
 * learned yet, and returns the values in those slots, or null if the texts
 * differ anywhere else.
 */
export function learnVolatileValues(template: string, actual: string): Record<string, string> | null {
  const names: string[] = []
  const pattern = template.split(/(\{\{V\d+\}\})/).map((part) => {
    const slot = /^\{\{(V\d+)\}\}$/.exec(part)
    if (!slot) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    names.push(slot[1]!)
    return '(1[6-9]\\d{11})'
  }).join('')
  const match = new RegExp(`^${pattern}$`, 's').exec(actual)
  if (!match) return null
  const learned: Record<string, string> = {}
  for (const [index, name] of names.entries()) {
    const value = match[index + 1]!
    if (learned[name] !== undefined && learned[name] !== value) return null
    learned[name] = value
  }
  return learned
}
