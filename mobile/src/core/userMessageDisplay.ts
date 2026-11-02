import { parseUserMessageSegments, type UserMessageSegment } from '../../../src/shared/userMessageCapabilities'
import { visibleMessageText } from './chatComposer'

export type UserMessageCapability = {
  kind: 'team' | 'computer' | 'skill' | 'plugin' | 'command'
  id: string
  label: string
}

/** Read the existing prompt format, including old transcripts, without changing what was sent. */
export function userMessageDisplay(text: string, teamRequested = false) {
  const unwrapped = visibleMessageText(text)
  const capabilities: UserMessageCapability[] = teamRequested || unwrapped !== text
    ? [{ kind: 'team', id: 'agent-team', label: 'Agent 团队' }]
    : []
  const addCapability = (segment: Exclude<UserMessageSegment, { type: 'text' }>) => {
    if (segment.type === 'command') {
      capabilities.push({ kind: 'command', id: segment.name, label: segment.name })
    } else if (segment.type === 'skill' && segment.label === 'computer-use') {
      capabilities.push({ kind: 'computer', id: segment.id, label: '操作电脑' })
    } else {
      capabilities.push({ kind: segment.type, id: segment.id, label: `@${segment.label}` })
    }
  }
  const segments = parseUserMessageSegments(unwrapped.trim())
  let body = ''
  let hasCommand = false
  for (const segment of segments) {
    if (segment.type === 'text') body += segment.text
    else {
      hasCommand ||= segment.type === 'command'
      addCapability(segment)
    }
  }
  // The composer puts reference instructions before the user's words. A slash
  // command can therefore be at the start of those words, after the references.
  // Only inspect it once: /review /argument must not consume the argument too.
  if (!hasCommand) {
    const [leading, ...rest] = parseUserMessageSegments(body.trimStart())
    if (leading?.type === 'command') {
      addCapability(leading)
      body = rest.map((segment) => segment.type === 'text' ? segment.text : '').join('')
    }
  }
  const seen = new Set<string>()
  return {
    text: body.trim(),
    capabilities: capabilities.filter((capability) => {
      const key = `${capability.kind}:${capability.id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
  }
}
