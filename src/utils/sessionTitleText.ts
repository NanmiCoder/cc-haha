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

function normalizeTitleWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Convert system-injected XML wrappers into user-facing text before using a
 * message as a session title source. Slash commands are stored in transcripts
 * as command-name/command-args breadcrumbs; titles should show the command the
 * user typed, not the internal XML transport.
 */
export function cleanSessionTitleSource(raw: string): string {
  const commandName = extractXmlTag(raw, 'command-name')
  const commandArgs = extractXmlTag(raw, 'command-args')
  if (commandName) {
    return normalizeTitleWhitespace([commandName, commandArgs].filter(Boolean).join(' '))
  }

  const stripped = raw.replace(XML_TAG_BLOCK_PATTERN, ' ')
  return normalizeTitleWhitespace(replaceCapabilitySentences(stripped))
}

// The fixed sentences a composer skill/plugin pill sends to the model
// (`buildCapabilityMentions` in capabilityMentionService.ts). A title shows the
// capability the user picked, not the instruction behind it.
const JSON_STRING = '"(?:[^"\\\\]|\\\\.)*"'
const CAPABILITY_SENTENCE = new RegExp(
  `Use the Skill tool with skill: (${JSON_STRING}) for this request\\.`
  + `|Use the enabled plugin (${JSON_STRING}) for this request\\. Available skill identities: \\[.*?\\]\\. `
  + 'MCP server identities: \\[.*?\\]\\. Invoke skills using the Skill tool and use only tools currently available from these servers\\. '
  + 'If unavailable or authentication is required, report that; do not install or authenticate automatically\\.',
  'g',
)

function replaceCapabilitySentences(text: string): string {
  return text.replace(CAPABILITY_SENTENCE, (sentence, skillJson?: string, pluginJson?: string) => {
    try {
      const id: unknown = JSON.parse(skillJson ?? pluginJson ?? '')
      if (typeof id !== 'string' || !id) return sentence
      return skillJson ? `/${id}` : `@${id.split('@')[0] || id}`
    } catch {
      return sentence
    }
  })
}

export function hasSessionTitleMarkup(raw: string): boolean {
  return /<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/.test(raw)
}
