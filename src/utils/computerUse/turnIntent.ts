import type { QueuedCommand } from '../../types/textInputTypes.js'

const toolName = String.raw`(?:computer[ \t-]+use|\$computer-use|电脑操作)(?![\w/\\-]|\.\w)`
const chineseVerb = String.raw`(?:(?:请帮我|请你|请|帮我)[ \t]*)?(?:使用|用|通过)[ \t]*`
const requestAtStart = new RegExp(
  String.raw`^(?:(?:please[ \t]+)?use[ \t]+|${chineseVerb})${toolName}`,
  'i',
)
const trailingMethod = new RegExp(
  String.raw`[ \t,，;；](?:(?:using|via)[ \t]+|${chineseVerb})${toolName}[ \t.!。！]*$`,
  'i',
)

/** Detect direct invocation on the human's input, before hooks or attachments add context. */
export function requiresComputerUse(command: Pick<QueuedCommand, 'mode' | 'value' | 'origin' | 'isMeta' | 'isSynthetic'>): boolean {
  if (command.mode !== 'prompt' || command.isMeta || command.isSynthetic) return false
  if (command.origin && command.origin.kind !== 'human') return false
  if (typeof command.value !== 'string' && command.value.some(block => block.type === 'tool_result')) return false

  // Desktop sends the authored text first, followed by images and metadata.
  // Leading @"..." tokens are file attachments, not method instructions.
  const text = typeof command.value === 'string'
    ? command.value
    : command.value.find(block => block.type === 'text')?.text ?? ''
  const prompt = text.trimStart()
    .replace(/^(?:@"[^"\r\n]*"[ \t]+)+/, '')
    .split('\n\n<session_references>', 1)[0]!
    .trim()
  if (/^\/computer-use(?=\s|$)/i.test(prompt)) return true
  if (/^\$computer-use(?=\s|$)/i.test(prompt)) return true
  if (prompt.startsWith('/') || /[?？]$/.test(prompt)) return false

  let fence: string | undefined
  for (const line of prompt.split(/\r?\n/)) {
    const directive = line.trim()
    const marker = /^(?:```|~~~)/.exec(directive)?.[0]
    if (marker) {
      if (!fence) fence = marker
      else if (marker === fence) fence = undefined
      continue
    }
    if (fence || /^(?:>|`|["'“‘「『])/.test(directive)) continue
    if (/^(?:Use the Skill tool with skill: "computer-use" for this request\.)$/i.test(directive)) return true
    if (requestAtStart.test(directive)) return true
    const suffix = trailingMethod.exec(directive)
    if (suffix && !/(?:不(?:要|必)?|别|禁止|without|avoid|not)[ \t]*$/i.test(directive.slice(0, suffix.index))) return true
  }
  return false
}
