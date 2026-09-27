/**
 * Inline @-mentions in the composer.
 *
 * The composer holds mentions as structured data (this type), but most of the
 * surrounding machinery — trigger detection, slash replacement, drafts —
 * works on a plain-text projection where each mention shows up as the token
 * `@${label}`. These helpers convert between the two and keep them honest:
 * mentions are matched against the text in document order, so a mention whose
 * token no longer exists simply stops matching (and is treated as literal
 * text) instead of corrupting the rest of the serialization.
 */

export type ComposerMention = {
  /** Missing kind is a legacy file reference. Drafts remain backwards compatible. */
  kind?: 'skill' | 'plugin' | 'session'
  id?: string
  description?: string
  icon?: string
  /** Server-authored invocation text; never serialize extensions as file paths. */
  modelText?: string
  /** Display label inside the token, e.g. `MediaCrawlerPro-Python/` for a directory. */
  label: string
  /** Absolute filesystem path sent to the model. */
  path: string
  isDirectory: boolean
  /**
   * Which occurrence of this mention's token in the projected text is the
   * pill, counting literal occurrences too (0-based). The plain-text
   * projection cannot tell a pill apart from identical text the user typed
   * by hand — this ordinal, always derived from the live document, is what
   * keeps the round trip exact in that case.
   */
  tokenOrdinal: number
}

/** A mention before its position in the text is known (e.g. at insertion time). */
export type NewComposerMention = Omit<ComposerMention, 'tokenOrdinal'>

export type MentionRange = {
  start: number
  end: number
  mention: ComposerMention
}

export function mentionToken(mention: Pick<ComposerMention, 'label'>): string {
  return `@${mention.label}`
}

export function mentionsEqual(a: ComposerMention[], b: ComposerMention[]): boolean {
  if (a.length !== b.length) return false
  return a.every((mention, index) => {
    const other = b[index]!
    return mention.label === other.label &&
      mention.path === other.path &&
      mention.isDirectory === other.isDirectory &&
      mention.tokenOrdinal === other.tokenOrdinal &&
      mention.kind === other.kind && mention.id === other.id &&
      mention.description === other.description && mention.icon === other.icon &&
      mention.modelText === other.modelText
  })
}

/** Every start offset of `token` in `text`, in order. */
export function tokenOccurrences(text: string, token: string): number[] {
  const positions: number[] = []
  let from = 0
  for (;;) {
    const index = text.indexOf(token, from)
    if (index < 0) return positions
    positions.push(index)
    from = index + token.length
  }
}

/**
 * Locate each mention's token occurrence in the projected text, in document
 * order, honoring each mention's tokenOrdinal so literal duplicate text does
 * not steal a pill's slot. Matching stops at the first mention whose token
 * occurrence can no longer be found — callers only ever see a consistent
 * prefix.
 */
export function findMentionRanges(text: string, mentions: ComposerMention[]): MentionRange[] {
  const ranges: MentionRange[] = []
  const occurrenceCache = new Map<string, number[]>()
  let from = 0
  for (const mention of mentions) {
    const token = mentionToken(mention)
    let positions = occurrenceCache.get(token)
    if (!positions) {
      positions = tokenOccurrences(text, token)
      occurrenceCache.set(token, positions)
    }
    const start = positions[mention.tokenOrdinal]
    if (start === undefined || start < from) break
    ranges.push({ start, end: start + token.length, mention })
    from = start + token.length
  }
  return ranges
}

/**
 * Insert a mention token over `[start, end)` in the projected text and return
 * the updated projection. A trailing space always follows the token so the
 * caret lands clear of the pill and trigger detection does not immediately
 * re-open on the mention's own `@`.
 */
export function insertMentionIntoText(
  text: string,
  mentions: ComposerMention[],
  start: number,
  end: number,
  mention: NewComposerMention,
): { text: string; mentions: ComposerMention[]; cursorPos: number } {
  const boundedStart = Math.max(0, Math.min(start, text.length))
  const boundedEnd = Math.max(boundedStart, Math.min(end, text.length))
  const before = text.slice(0, boundedStart)
  // The token supplies its own trailing space; any whitespace the trigger
  // text had after it collapses into that one.
  const after = text.slice(boundedEnd).replace(/^\s+/, '')
  const token = mentionToken(mention)
  const insertion = `${token} `
  const positioned: ComposerMention = {
    ...mention,
    tokenOrdinal: tokenOccurrences(before, token).length,
  }
  const insertIndex = findMentionRanges(text, mentions).filter((range) => range.start < boundedStart).length
  return {
    text: `${before}${insertion}${after}`,
    mentions: [
      ...mentions.slice(0, insertIndex),
      positioned,
      ...mentions.slice(insertIndex),
    ],
    cursorPos: before.length + insertion.length,
  }
}

/** Only packaged icons are accepted in inline editor nodes and clipboard HTML. */
export function safeMentionIcon(icon?: string): string | undefined {
  return icon && /^\/connectors\/[a-z0-9-]+\.svg$/.test(icon) ? icon : undefined
}

export function composerReferenceToMention(reference: import('../types/composerReference').ComposerReferenceCandidate): NewComposerMention {
  return {
    kind: reference.kind, id: reference.id, label: reference.displayName || reference.name,
    description: reference.description, icon: safeMentionIcon(reference.icon),
    modelText: reference.modelText, path: '', isDirectory: false,
  }
}

/** Only live structured pills grant a session reference; typed @text never does. */
export function getSessionReferences(text: string, mentions: ComposerMention[]): Array<{ sessionId: string }> {
  return [...new Set(findMentionRanges(text, mentions)
    .filter(({ mention }) => mention.kind === 'session' && mention.id)
    .map(({ mention }) => mention.id!))].map(sessionId => ({ sessionId }))
}
