const TITLE_MAX_LEN = 50

const PLACEHOLDER_TITLES = new Set([
  '',
  'New Session',
  'Untitled Session',
])

export function deriveSessionTitle(raw: string): string | null {
  const clean = raw.replace(/<[^>]+>[^<]*<\/[^>]+>/g, '').trim()
  const firstSentence = /^(.*?[.!?\u3002\uff01\uff1f])\s/.exec(clean)?.[1] ?? clean
  const flat = firstSentence.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > TITLE_MAX_LEN
    ? `${flat.slice(0, TITLE_MAX_LEN - 1)}\u2026`
    : flat
}

export function isPlaceholderSessionTitle(title: string | null | undefined): boolean {
  return PLACEHOLDER_TITLES.has((title ?? '').trim())
}
