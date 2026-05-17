const TITLE_MAX_LEN = 50

const PLACEHOLDER_TITLES = new Set([
  '',
  'New Session',
  'Untitled Session',
])

const XML_TAG_BLOCK_PATTERN = /<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?/g

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function extractXmlTag(text: string, tag: string): string | undefined {
  const match = text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  const value = match?.[1]?.trim()
  return value ? decodeXmlText(value) : undefined
}

function cleanSessionTitleSource(raw: string): string {
  const commandName = extractXmlTag(raw, 'command-name')
  const commandArgs = extractXmlTag(raw, 'command-args')
  if (commandName) {
    return [commandName, commandArgs].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  }

  return raw.replace(XML_TAG_BLOCK_PATTERN, ' ').replace(/\s+/g, ' ').trim()
}

export function deriveSessionTitle(raw: string): string | null {
  const clean = cleanSessionTitleSource(raw)
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
