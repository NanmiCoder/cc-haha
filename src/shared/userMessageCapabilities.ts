/**
 * Read the composer capabilities back out of a sent prompt.
 *
 * Skill and plugin pills travel to the model as fixed English sentences
 * (`buildCapabilityMentions` in src/server/services/capabilityMentionService.ts,
 * fallback in `serializeComposerDoc`), and slash commands as their literal
 * `/name` text. Nothing else records them, so the bubble, its reloaded copy and
 * the edit draft all recover the pills from the text with this one reader.
 */

const JSON_STRING = '"(?:[^"\\\\]|\\\\.)*"'
const SKILL_SENTENCE = `Use the Skill tool with skill: (${JSON_STRING}) for this request\\.`
const PLUGIN_SENTENCE = `Use the enabled plugin (${JSON_STRING}) for this request\\. Available skill identities: \\[.*?\\]\\. `
  + 'MCP server identities: \\[.*?\\]\\. Invoke skills using the Skill tool and use only tools currently available from these servers\\. '
  + 'If unavailable or authentication is required, report that; do not install or authenticate automatically\\.'
const FALLBACK_SENTENCE = `Use (skill|plugin) (${JSON_STRING}) for this request\\.`
const CAPABILITY_SENTENCE = new RegExp(`${SKILL_SENTENCE}|${PLUGIN_SENTENCE}|${FALLBACK_SENTENCE}`, 'g')

// A command is a leading `/name` token; a second `/` makes it a path instead.
const LEADING_COMMAND = /^\/[A-Za-z][\w:.-]*(?=\s|$)/
const LEADING_SKILL_BREADCRUMB = /^Skill\(([^()\s]+)\)(?=\s|$)/

export type CapabilityKind = 'skill' | 'plugin'

export type UserMessageSegment =
  | { type: 'text', text: string }
  | { type: CapabilityKind, id: string, label: string, modelText: string }
  | { type: 'command', name: string }

function readJsonString(raw: string): string | null {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'string' && value ? value : null
  } catch {
    return null
  }
}

/** The name a pill shows: plugin skills drop their `plugin:` owner, plugins their `@marketplace`. */
export function capabilityLabel(kind: CapabilityKind, id: string): string {
  if (kind === 'plugin') return id.split('@')[0] || id
  return id.slice(id.lastIndexOf(':') + 1) || id
}

export function hasCapabilitySentence(text: string): boolean {
  CAPABILITY_SENTENCE.lastIndex = 0
  return CAPABILITY_SENTENCE.test(text)
}

function pushText(segments: UserMessageSegment[], text: string) {
  if (!text) return
  const last = segments[segments.length - 1]
  if (last?.type === 'text') last.text += text
  else segments.push({ type: 'text', text })
}

/** Split display text into plain text and capability pills, in reading order. */
export function parseUserMessageSegments(text: string): UserMessageSegment[] {
  const segments: UserMessageSegment[] = []
  let rest = text
  const command = LEADING_COMMAND.exec(rest)
  const breadcrumb = command ? null : LEADING_SKILL_BREADCRUMB.exec(rest)
  if (command) {
    segments.push({ type: 'command', name: command[0] })
    rest = rest.slice(command[0].length)
  } else if (breadcrumb) {
    const id = breadcrumb[1]!
    segments.push({ type: 'skill', id, label: capabilityLabel('skill', id), modelText: '' })
    rest = rest.slice(breadcrumb[0].length)
  }

  let cursor = 0
  CAPABILITY_SENTENCE.lastIndex = 0
  for (const match of rest.matchAll(CAPABILITY_SENTENCE)) {
    const [sentence, skillJson, pluginJson, fallbackKind, fallbackJson] = match
    const kind: CapabilityKind = skillJson ? 'skill' : pluginJson ? 'plugin' : fallbackKind as CapabilityKind
    const id = readJsonString(skillJson ?? pluginJson ?? fallbackJson ?? '')
    if (!id) continue
    pushText(segments, rest.slice(cursor, match.index))
    segments.push({ type: kind, id, label: capabilityLabel(kind, id), modelText: sentence })
    cursor = match.index + sentence.length
  }
  pushText(segments, rest.slice(cursor))
  return segments
}
