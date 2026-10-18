import type { Message } from '../../types/message.js'

/**
 * Only the human's current request can select skills: the latest human prompt
 * plus anything the user typed while that turn was running, which query.ts
 * drains mid-turn as `queued_command` attachments. Tool output, hook output,
 * task notifications, agent mail, peer or channel messages and earlier prompts
 * never select.
 */
export function isExplicitSkillRequest(messages: readonly Message[], name: string): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const input = getHumanInput(messages[index]!)
    if (!input) continue
    if (selectsSkill(input.text, name)) return true
    // A prompt opens its turn; everything before it is history.
    if (!input.queuedMidTurn) return false
  }
  return false
}

type HumanInput = { text: string, queuedMidTurn: boolean }

// Provenance is structural: no origin means keyboard input. Every other origin
// (task notification, coordinator, channel or peer session) is not the user.
function isHumanOrigin(origin: { kind?: string } | undefined): boolean {
  return origin === undefined || origin.kind === 'human'
}

function getHumanInput(message: Message): HumanInput | undefined {
  if (message.type === 'user') {
    // Tool-result messages, tool-injected messages and the compaction summary
    // (written by the model) are also role=user.
    if (message.isMeta || message.isCompactSummary || message.sourceToolUseID || !isHumanOrigin(message.origin)) return
    const content = message.message.content
    if (Array.isArray(content) && content.some(block => block.type === 'tool_result')) return
    return { text: getText(content), queuedMidTurn: false }
  }
  if (message.type === 'attachment' && message.attachment.type === 'queued_command') {
    const { commandMode, isMeta, origin, prompt } = message.attachment
    if (commandMode !== 'prompt' || isMeta || !isHumanOrigin(origin)) return
    return { text: getText(prompt), queuedMidTurn: true }
  }
}

function getText(content: string | readonly { type: string, text?: string }[]): string {
  return typeof content === 'string'
    ? content
    : content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

// Characters skill and plugin names are made of (`code-review`, `plugin:skill`)
// and path separators. A token touching one of them continues a name or path.
const NAME_OR_SEPARATOR = 'A-Za-z0-9_.:\\-/\\\\'
// Before a sigil these also continue a home path, URL fragment or query value.
const PATH_PREFIX = '~#='

/**
 * `/name` and `$name` select a skill only as a standalone token, so paths,
 * URLs and longer names are not selections (`/tmp/x`, `https://h/#/x`,
 * `x.md`, `x-extra`, `plugin:x`). Whitespace, CJK text, emoji and other
 * punctuation are ordinary boundaries (`请用$x审查`, `(/x)`), and a trailing
 * `.`, `:` or `-` ends the sentence rather than the name (`$x: …`).
 */
function selectsSkill(text: string, name: string): boolean {
  if (text.includes(`Use the Skill tool with skill: ${JSON.stringify(name)} for this request.`)) return true
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![${NAME_OR_SEPARATOR}${PATH_PREFIX}])[/$]${escaped}(?=[.:\\-]*(?![${NAME_OR_SEPARATOR}]))`).test(text)
}
